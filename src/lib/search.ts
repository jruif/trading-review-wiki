import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { mapWithConcurrency } from "@/lib/concurrency"

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  retrievalMode?: SearchMode
  frontmatterUpdated?: string | null
  frontmatterUpdatedField?: string | null
  staleDays?: number | null
  freshnessScore?: number
}

export type SearchMode = "ask" | "ingest"

export interface SearchOptions {
  mode?: SearchMode
}

const MAX_RESULTS = 20
const SNIPPET_CONTEXT = 80
const TITLE_MATCH_BONUS = 10
const RAW_BONUS = 4 // Give raw sources a slight boost so they compete fairly for context budget
const DEFAULT_RAW_SCAN_LIMIT = 80
const DATED_RAW_SCAN_LIMIT = 240

// Recency boost based on filename date (e.g. YYYY-MM-DD-xxx.md)
function getRecencyBoost(fileName: string, query: string): number {
  const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!dateMatch) return 0

  const fileDate = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]))
  const now = new Date()
  const diffDays = (now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24)

  let boost = 0
  // Base recency: closer is better
  if (diffDays <= 7) boost += 6
  else if (diffDays <= 30) boost += 3
  else if (diffDays <= 90) boost += 1

  // Query-aware boost: if user explicitly asks for recent time range, strongly prefer files in that range
  const timePatterns = [
    { regex: /最近一?个?月|本月|这个月|近30天|近一个月/, days: 30 },
    { regex: /最近一?周|本周|这周|近7天/, days: 7 },
    { regex: /昨日|昨天/, days: 1 },
    { regex: /今天|当日/, days: 0 },
  ]

  for (const p of timePatterns) {
    if (p.regex.test(query)) {
      if (diffDays <= p.days) {
        boost += 15 // Strong boost so old files drop out of top results
      }
      break
    }
  }

  return boost
}

const FRONTMATTER_FRESHNESS_FIELDS = ["updated", "last_reviewed", "created"] as const
const FRONTMATTER_STALE_SENSITIVE_TYPES = new Set(["概念", "股票", "总结", "源文档", "查询"])
const FRONTMATTER_STABLE_TYPES = new Set(["策略", "模式", "错误"])
const FRESHNESS_SENSITIVE_QUERY_REGEX =
  /最新|最近|近期|今日|今天|当日|昨日|昨天|本周|这周|本月|这个月|近\s*\d+|近[一二三四五六七八九十两]+(?:天|日|周|月)|催化|订单|进展|变化|更新|量产|业绩|公告|调研|会议|研报|新闻|舆情|成交|量价|涨跌幅|放量|缩量|验证/

interface FrontmatterFreshnessScore {
  score: number
  field: string | null
  value: string | null
  staleDays: number | null
}

function parseFrontmatterFreshnessDate(value: string | null): { date: Date; value: string } | null {
  const text = String(value ?? "").trim().replace(/^['"]|['"]$/g, "")
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 12),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  )
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null
  }
  return { date, value: text }
}

function extractFrontmatterValue(content: string, field: string): string | null {
  const block = extractFrontmatterBlock(content)
  const match = block.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"))
  return match?.[1]?.trim() ?? null
}

function inferTypeFromPath(filePath: string): string {
  const normalized = normalizePath(filePath)
  return normalized.match(/\/wiki\/([^/]+)\//)?.[1] ?? "总结"
}

function localDateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function frontmatterFreshnessScore(content: string, filePath: string, query: string): FrontmatterFreshnessScore {
  const candidates = FRONTMATTER_FRESHNESS_FIELDS.flatMap((field) => {
    const parsed = parseFrontmatterFreshnessDate(extractFrontmatterValue(content, field))
    return parsed ? [{ ...parsed, field }] : []
  }).sort((a, b) => b.date.getTime() - a.date.getTime())

  const timestamp = candidates[0]
  if (!timestamp) return { score: 0, field: null, value: null, staleDays: null }

  const diffDays = Math.max(
    0,
    Math.floor((localDateOnly(new Date()).getTime() - localDateOnly(timestamp.date).getTime()) / 86400000),
  )
  const type = extractFrontmatterValue(content, "type") ?? inferTypeFromPath(filePath)
  const timeSensitive = FRESHNESS_SENSITIVE_QUERY_REGEX.test(query)
  const stableType = FRONTMATTER_STABLE_TYPES.has(type)
  const staleSensitiveType = FRONTMATTER_STALE_SENSITIVE_TYPES.has(type)
  let score = 0

  if (diffDays <= 7) score += timeSensitive ? 10 : 4
  else if (diffDays <= 30) score += timeSensitive ? 6 : 2
  else if (diffDays <= 90) score += timeSensitive ? 2 : 1

  if (diffDays > 365) {
    if (timeSensitive) score -= stableType ? 2 : 10
    else if (staleSensitiveType) score -= 3
  } else if (diffDays > 180) {
    if (timeSensitive) score -= stableType ? 1 : 5
    else if (staleSensitiveType) score -= 1
  }

  return {
    score,
    field: timestamp.field,
    value: timestamp.value,
    staleDays: diffDays,
  }
}

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "这个", "一个", "以及", "进行",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

const TIME_QUERY_TOKENS = new Set([
  "最近", "近一", "一周", "近7天", "本周", "这周", "最近一周",
  "近一个月", "最近一个月", "本月", "这个月", "今天", "当日", "昨天", "昨日",
])

const GENERIC_QUERY_TOKENS = new Set([
  "投资", "方向", "交易", "证据", "验证", "知识", "知识库", "已有", "反复",
  "哪些", "应该", "优先", "区分", "仍偏", "叙事", "环节", "标的", "节点",
  "最近", "一个月", "最近一个月", "产业", "链环", "要看", "来看",
])

const EVIDENCE_QUERY_TOKENS = new Set([
  "订单", "客户", "出货", "量价", "量产", "产能", "合同", "中标", "交付",
  "毛利", "价格", "涨价", "市占", "份额", "导入", "认证", "供应", "供应商",
  "客户节点", "验证节点", "出货量",
])

function normalizeSearchMode(mode: SearchMode | undefined): SearchMode {
  if (mode === "ask" || mode === "ingest") return mode
  return "ask"
}

export function tokenizeQuery(query: string): string[] {
  // Split by whitespace and punctuation
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []

  for (const token of rawTokens) {
    // Check if token contains CJK characters
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCJK && token.length > 2) {
      // For CJK text: split into individual characters AND overlapping bigrams
      // "默会知识" → ["默会", "会知", "知识", "默", "会", "知", "识"]
      const chars = [...token]
      // Add bigrams (most useful for Chinese)
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1])
      }
      // Add trigrams so long phrases like "机器人方向" can still match "机器人"
      for (let i = 0; i < chars.length - 2; i++) {
        tokens.push(chars[i] + chars[i + 1] + chars[i + 2])
      }
      // Also add individual chars (for single-char matches)
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      // Keep the original token too (for exact phrase match)
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }

  // Deduplicate
  return [...new Set(tokens)]
}

function charLength(token: string): number {
  return [...token].length
}

function isSingleCjkToken(token: string): boolean {
  return charLength(token) === 1 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
}

function containsAnyToken(token: string, words: ReadonlySet<string>): boolean {
  for (const word of words) {
    if (word && token.includes(word)) return true
  }
  return false
}

function tokenWeight(token: string): number {
  const normalized = token.toLowerCase()
  const length = charLength(normalized)
  if (EVIDENCE_QUERY_TOKENS.has(normalized)) return 2.4
  if (TIME_QUERY_TOKENS.has(normalized)) return 0.2
  if (GENERIC_QUERY_TOKENS.has(normalized)) return 0.15
  if (isSingleCjkToken(normalized)) return 0.05
  if (length > 4 && containsAnyToken(normalized, TIME_QUERY_TOKENS)) return 0.35
  if (length > 4 && containsAnyToken(normalized, GENERIC_QUERY_TOKENS)) return 0.35
  if (length > 10 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(normalized)) return 0.35
  if (/[a-z0-9]/i.test(normalized)) return Math.min(3, 1 + length * 0.15)
  if (length >= 4) return 2.4
  if (length === 3) return 1.7
  return 1
}

function preferredEvidenceTokens(tokens: readonly string[]): string[] {
  const uniq = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))]
  const topical = uniq
    .filter((token) => tokenWeight(token) >= 1)
    .sort((a, b) => tokenWeight(b) - tokenWeight(a) || charLength(b) - charLength(a))
  return topical.length > 0 ? topical : uniq
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token)) score += tokenWeight(token)
  }
  return score
}

function topicCoverageBonus(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  const matched = preferredEvidenceTokens(tokens)
    .slice(0, 14)
    .filter((token) => lower.includes(token.toLowerCase()))
  if (matched.length === 0) return 0

  let score = matched.reduce((sum, token) => sum + tokenWeight(token) * 1.8, 0)
  if (matched.length >= 2) score += 6
  if (matched.length >= 4) score += 6
  return score
}

function rawPathQualityBonus(file: FileNode, title: string, tokens: readonly string[], mode: SearchMode): number {
  const normalizedPath = normalizePath(file.path).toLowerCase()
  const titleText = `${title} ${file.name}`.toLowerCase()
  let score = 0

  const titleMatches = preferredEvidenceTokens(tokens)
    .slice(0, 12)
    .filter((token) => titleText.includes(token.toLowerCase()))
  if (titleMatches.length > 0) score += 18 + titleMatches.length * 5

  if (/(?:^|\/)(?:研报新闻|openclaw数据|产业链复盘|投研线索|日复盘)(?:\/|$)/.test(normalizedPath)) {
    score += 10
  }
  if (mode === "ask" && /(?:^|\/)微信聊天(?:\/|$)/.test(normalizedPath)) {
    score -= 15
  }

  return score
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}

function queryDateHints(query: string): string[] {
  return [...new Set(query.match(/\d{4}-\d{2}-\d{2}/g) ?? [])]
}

function fileDateToken(file: FileNode): string {
  return `${file.path}/${file.name}`.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? ""
}

function compareRawRecencyDesc(a: FileNode, b: FileNode): number {
  const dateA = fileDateToken(a)
  const dateB = fileDateToken(b)
  if (dateA && dateB && dateA !== dateB) return dateB.localeCompare(dateA)
  if (dateB && !dateA) return 1
  if (dateA && !dateB) return -1
  return b.path.localeCompare(a.path)
}

function rawPathAllowed(file: FileNode): boolean {
  const normalized = normalizePath(file.path)
  return !/\/(?:scripts|templates|archive|assets)(?:\/|$)/.test(normalized)
}

function selectRawFilesForQuery(files: FileNode[], query: string, mode: SearchMode): FileNode[] {
  const sorted = files.filter(rawPathAllowed).sort(compareRawRecencyDesc)
  if (mode === "ingest") return sorted.slice(0, DATED_RAW_SCAN_LIMIT)
  const hints = queryDateHints(query)
  if (hints.length > 0) {
    const dated = sorted.filter((file) => hints.some((hint) => normalizePath(file.path).includes(hint)))
    if (dated.length > 0) return dated.slice(0, DATED_RAW_SCAN_LIMIT)
  }
  return sorted.slice(0, DEFAULT_RAW_SCAN_LIMIT)
}

function extractTitle(content: string, fileName: string): string {
  // Try YAML frontmatter title
  const frontmatterMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()

  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  // Fall back to filename
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractFrontmatterBlock(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? ""
}

function normalizeFrontmatterSearchText(text: string): string {
  return text
    .replace(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g, (_m, target) => {
      const normalized = String(target).replace(/^wiki\//, "").replace(/\.md$/i, "")
      return `${target} ${normalized} ${normalized.split("/").pop() ?? ""}`
    })
    .replace(/raw\/[^\s,\]]+/g, (source) => {
      const normalized = source.replace(/\.md$/i, "")
      return `${source} ${normalized} ${normalized.split("/").pop() ?? ""}`
    })
}

function frontmatterSearchText(content: string): string {
  const block = extractFrontmatterBlock(content)
  if (!block) return ""
  const lines = block
    .split(/\r?\n/)
    .filter((line) => /^(title|type|summary|aliases|tags|related|sources):|^\s*-\s+/.test(line))
  return normalizeFrontmatterSearchText(lines.join("\n"))
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const idx = lower.indexOf(lowerQuery)
  if (idx === -1) return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")

  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(content.length, idx + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

export async function searchWiki(
  projectPath: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)
  const mode = normalizeSearchMode(options.mode)

  const tokens = tokenizeQuery(query)
  // Fallback: if all tokens were filtered out, use the trimmed query as a single token
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const results: SearchResult[] = []
  let wikiTree: FileNode[] | null = null

  // Search wiki pages
  try {
    wikiTree = await listDirectory(`${pp}/wiki`)
    const wikiFiles = flattenMdFiles(wikiTree)
    await searchFiles(wikiFiles, effectiveTokens, query, results, mode)
  } catch {
    // no wiki directory
  }

  // Also search raw directories but limit to recent files to avoid performance collapse
  // As raw/ grows (e.g. 100+ delivery notes), reading every file blocks the main thread.
  // Also exclude heavy extractable formats (pdf, office) so Rust doesn't hang on text extraction.
  try {
    const rawTree = await listDirectory(`${pp}/raw`)
    const rawTextFiles = flattenAllFiles(rawTree).filter(
      (f) =>
        !f.name.match(
          /\.(png|jpe?g|gif|webp|bmp|tiff|avif|heic|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|m4a|exe|zip|rar|7z|tar|gz|db|tmp|log|DS_Store|pdf|docx?|xlsx?|pptx?|odt|ods|odp)$/i,
        ),
    )
    const rawFiles = selectRawFilesForQuery(rawTextFiles, query, mode)
    await searchFiles(rawFiles, effectiveTokens, query, results, mode)
  } catch {
    // no raw directory
  }

  // Vector search: merge semantic results if embedding enabled
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const embCfg = useWikiStore.getState().embeddingConfig
    console.log(`[Vector Search] Config: enabled=${embCfg.enabled}, model="${embCfg.model}"`)
    if (embCfg.enabled && embCfg.model) {
      const t0 = performance.now()
      const { searchByEmbedding } = await import("@/lib/embedding")
      const vectorResults = await searchByEmbedding(pp, query, embCfg, 10)
      const vectorMs = Math.round(performance.now() - t0)

      console.log(
        `[Vector Search] query="${query}" | ${vectorResults.length} results in ${vectorMs}ms | model=${embCfg.model}` +
        (vectorResults.length > 0
          ? ` | top: ${vectorResults.slice(0, 5).map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`
          : "")
      )

      let boosted = 0
      let added = 0
      const existingPaths = new Set(results.map((r) => r.path))

      for (const vr of vectorResults) {
        // Check if already in results
        const existing = results.find((r) => {
          const fileName = r.path.split("/").pop()?.replace(/\.md$/, "") ?? ""
          return fileName === vr.id
        })

        if (existing) {
          // Boost score of existing result
          existing.score += vr.score * 5
          boosted++
        } else {
          // Try to find the file anywhere in the wiki tree
          if (wikiTree) {
            const allWikiFiles = flattenMdFiles(wikiTree)
            const found = allWikiFiles.find((f) => f.name.replace(/\.md$/, "") === vr.id)
            if (found && !existingPaths.has(found.path)) {
              try {
                const content = await readFile(found.path)
                const title = extractTitle(content, found.name)
                results.push({
                  path: found.path,
                  title,
                  snippet: buildSnippet(content, query),
                  titleMatch: false,
                  score: vr.score * 5,
                })
                existingPaths.add(found.path)
                added++
              } catch {
                // unable to read file
              }
            }
          }
        }
      }

      if (boosted > 0 || added > 0) {
        console.log(`[Vector Search] Merged: ${boosted} boosted, ${added} new pages added`)
      }
    }
  } catch (err) {
    console.log(`[Vector Search] Skipped: ${err instanceof Error ? err.message : "not available"}`)
  }

  // Sort by score descending, then by filename date descending as tie-breaker
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const dateA = a.path.match(/(\d{4})-(\d{2})-(\d{2})/)
    const dateB = b.path.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (dateA && dateB) return dateB[0].localeCompare(dateA[0])
    if (dateB) return 1
    if (dateA) return -1
    return 0
  })

  const tokenCount = results.filter((r) => r.score > 0).length
  console.log(`[Search] query="${query}" | ${tokenCount} token matches | ${results.length} total results`)

  return results.slice(0, MAX_RESULTS)
}

async function searchFiles(
  files: FileNode[],
  tokens: readonly string[],
  query: string,
  results: SearchResult[],
  mode: SearchMode,
): Promise<void> {
  const scanned = await mapWithConcurrency(files, 8, async (file) => {
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      return null
    }

    const title = extractTitle(content, file.name)
    const titleText = `${title} ${file.name}`
    const fmText = frontmatterSearchText(content)

    const titleScore = tokenMatchScore(titleText, tokens)
    const contentScore = tokenMatchScore(content, tokens)
    const frontmatterScore = tokenMatchScore(fmText, tokens) * 4 + topicCoverageBonus(fmText, tokens)

    if (titleScore === 0 && contentScore === 0 && frontmatterScore === 0) return null

    const isTitleMatch = titleScore > 0
    let score = contentScore + frontmatterScore + topicCoverageBonus(content, tokens) + (isTitleMatch ? TITLE_MATCH_BONUS + titleScore : 0)

    const isRaw = file.path.includes("/raw/") || file.path.includes("\\raw\\")
    if (isRaw && score > 0) {
      score += RAW_BONUS
      score += rawPathQualityBonus(file, title, tokens, mode)
    }

    if (mode === "ask") {
      const freshness = frontmatterFreshnessScore(content, file.path, query)
      score += getRecencyBoost(file.name, query)
      score += freshness.score
      return {
        path: file.path,
        title,
        snippet: buildSnippet(content, preferredEvidenceTokens(tokens).find((t) =>
          content.toLowerCase().includes(t.toLowerCase()),
        ) ?? query),
        titleMatch: isTitleMatch,
        score,
        retrievalMode: mode,
        frontmatterUpdated: freshness.value,
        frontmatterUpdatedField: freshness.field,
        staleDays: freshness.staleDays,
        freshnessScore: freshness.score,
      } satisfies SearchResult
    }

    const firstMatchingToken = preferredEvidenceTokens(tokens).find((t) =>
      content.toLowerCase().includes(t.toLowerCase()),
    ) ?? query

    return {
      path: file.path,
      title,
      snippet: buildSnippet(content, firstMatchingToken),
      titleMatch: isTitleMatch,
      score,
      retrievalMode: mode,
    } satisfies SearchResult
  })

  for (const result of scanned) {
    if (result) results.push(result)
  }
}

