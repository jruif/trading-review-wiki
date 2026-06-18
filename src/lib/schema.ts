import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

// -----------------------------------------------------------------------------
// Schema v1 — locked enums
// -----------------------------------------------------------------------------

export const WIKI_TYPES = [
  "股票",
  "概念",
  "策略",
  "模式",
  "错误",
  "人物",
  "总结",
  "查询",
  "源文档",
] as const
export type WikiType = (typeof WIKI_TYPES)[number]

export const WIKI_STATUS = ["活跃", "观察", "归档", "废弃"] as const
export type WikiStatus = (typeof WIKI_STATUS)[number]

export const CONFIDENCE = ["高", "中", "低"] as const
export type Confidence = (typeof CONFIDENCE)[number]

export const MOMENTUM = ["热", "活跃", "降温", "已死"] as const
export type Momentum = (typeof MOMENTUM)[number]

export const SCHEMA_VERSION = 1 as const

// -----------------------------------------------------------------------------
// Type aliases (legacy → canonical)
// -----------------------------------------------------------------------------

const TYPE_ALIASES: Record<string, WikiType> = {
  // 股票
  股票: "股票",
  个股档案: "股票",
  entity: "股票",
  entities: "股票",
  // 概念
  概念: "概念",
  concept: "概念",
  concepts: "概念",
  // 策略
  策略: "策略",
  strategy: "策略",
  // 模式
  模式: "模式",
  市场模式: "模式",
  进化: "模式",
  预测: "模式",
  pattern: "模式",
  // 错误
  错误: "错误",
  error: "错误",
  mistake: "错误",
  // 人物
  人物: "人物",
  people: "人物",
  person: "人物",
  // 总结
  总结: "总结",
  分析: "总结",
  比较: "总结",
  synthesis: "总结",
  analysis: "总结",
  comparison: "总结",
  comparisons: "总结",
  // 查询
  查询: "查询",
  query: "查询",
  // 源文档
  源文档: "源文档",
  source: "源文档",
  sources: "源文档",
}

const STATUS_ALIASES: Record<string, WikiStatus> = {
  活跃: "活跃",
  观察: "观察",
  归档: "归档",
  废弃: "废弃",
  active: "活跃",
  watching: "观察",
  archived: "归档",
  deprecated: "废弃",
}

// -----------------------------------------------------------------------------
// Interfaces
// -----------------------------------------------------------------------------

export interface WikiFrontmatter {
  schema_version: 1
  title: string
  aliases?: string[]
  type: WikiType
  summary: string
  tags?: string[]
  related?: string[]
  sources?: string[]
  created: string
  updated: string
  last_reviewed: string
  confidence: Confidence
  status: WikiStatus
  redirect?: string

  // 股票
  code?: string
  industry?: string
  concepts?: string[]

  // 概念
  parent?: string
  momentum?: Momentum
  catalysts?: string[]
}

export interface SchemaViolation {
  field: string
  message: string
  fatal: boolean
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const WIKILINK_REGEX = /^\[\[[^\]]+\]\]$/
const STOCK_CODE_REGEX = /^(?:(?:SZ|SH|BJ)\d{6}|HK\d{5}|[A-Z]{1,5}(?:\.[A-Z])?)$/
const SUMMARY_MIN = 50
const SUMMARY_MAX = 120

// Field order for canonical serialization. Common fields first, then type-specific.
const COMMON_FIELD_ORDER: (keyof WikiFrontmatter)[] = [
  "schema_version",
  "title",
  "aliases",
  "type",
  "summary",
  "tags",
  "related",
  "sources",
  "created",
  "updated",
  "last_reviewed",
  "confidence",
  "status",
  "redirect",
]

const STOCK_FIELD_ORDER: (keyof WikiFrontmatter)[] = ["code", "industry", "concepts"]
const CONCEPT_FIELD_ORDER: (keyof WikiFrontmatter)[] = ["parent", "momentum", "catalysts"]

// -----------------------------------------------------------------------------
// Type & status normalization
// -----------------------------------------------------------------------------

export function normalizeTypeAlias(raw: string): WikiType | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (TYPE_ALIASES[trimmed]) return TYPE_ALIASES[trimmed]
  const lower = trimmed.toLowerCase()
  if (TYPE_ALIASES[lower]) return TYPE_ALIASES[lower]
  return null
}

export function normalizeStatusAlias(raw: string): WikiStatus | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (STATUS_ALIASES[trimmed]) return STATUS_ALIASES[trimmed]
  return null
}

export function inferTypeFromPath(path: string): WikiType {
  const norm = path.replace(/\\/g, "/")
  // Find first directory segment under wiki/ if present
  const match = norm.match(/wiki\/([^/]+)\//)
  const dir = match?.[1] ?? ""
  return normalizeTypeAlias(dir) ?? "总结"
}

// -----------------------------------------------------------------------------
// Timestamp helpers
// -----------------------------------------------------------------------------

export function nowLocalTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

function parseLocalTimestampParts(value: unknown): { date: string; time: string | null } | null {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/)
  if (!match) return null
  return {
    date: match[1],
    time: match[2] ? (match[2].length === 5 ? `${match[2]}:00` : match[2]) : null,
  }
}

function formatTimestampFromDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Coerce ISO / date-only / YAML Date values to YYYY-MM-DD HH:mm:ss */
export function normalizeWikiTimestamp(value: unknown, fallback?: string): string {
  const fb = fallback ?? nowLocalTimestamp()
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatTimestampFromDate(value)
  }

  const text = String(value ?? "").trim().replace(/^['"]|['"]$/g, "")
  if (!text) return fb
  if (TIMESTAMP_REGEX.test(text)) return text

  const parts = parseLocalTimestampParts(text)
  if (parts) {
    return `${parts.date} ${parts.time ?? "00:00:00"}`
  }

  const parsedMs = Date.parse(text)
  if (Number.isFinite(parsedMs)) {
    return formatTimestampFromDate(new Date(parsedMs))
  }

  return fb
}

export function normalizeFrontmatterFields(
  fm: Partial<WikiFrontmatter>,
  options: { now?: string } = {},
): Partial<WikiFrontmatter> {
  const fallback = options.now ?? nowLocalTimestamp()
  const next = { ...fm }
  for (const field of ["created", "updated", "last_reviewed"] as const) {
    next[field] = normalizeWikiTimestamp(next[field], fallback)
  }
  return next
}

export function pathToTitle(relativePath: string): string {
  const base = relativePath.replace(/^wiki\//, "").replace(/\.md$/, "")
  const last = base.split("/").pop() ?? base
  return last.replace(/-/g, " ")
}

function buildFallbackSummary(title: string, body: string): string {
  const paragraph = body
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk && !chunk.startsWith("#") && !chunk.startsWith("```") && !chunk.startsWith("---"))
  let summary = paragraph?.replace(/\s+/g, " ").slice(0, SUMMARY_MAX) ?? ""
  if ([...summary].length < SUMMARY_MIN) {
    summary = `${title}页面，由 ingest 基于 raw 资料自动整理生成，后续可继续补充证据链与交叉引用。`
  }
  while ([...summary].length < SUMMARY_MIN) summary += "。"
  return [...summary].slice(0, SUMMARY_MAX).join("")
}

function clampSummaryLength(summary: string, title: string, body: string): string {
  let s = summary.trim()
  if (!s) return buildFallbackSummary(title, body)
  if ([...s].length > SUMMARY_MAX) {
    s = [...s].slice(0, SUMMARY_MAX).join("")
  }
  if ([...s].length < SUMMARY_MIN) {
    return buildFallbackSummary(title, body)
  }
  return s
}

function sanitizeRelatedField(related: unknown): string[] {
  if (!Array.isArray(related)) return []
  return related.filter((item): item is string => typeof item === "string" && WIKILINK_REGEX.test(item))
}

/** Fill missing / invalid frontmatter fields before schema validation */
export function coerceWikiPageFrontmatter(
  fm: Partial<WikiFrontmatter>,
  relativePath: string,
  body: string,
  options: { now?: string } = {},
): Partial<WikiFrontmatter> {
  const next = normalizeFrontmatterFields({ ...fm }, options) as Partial<WikiFrontmatter>

  if (next.schema_version !== SCHEMA_VERSION) next.schema_version = SCHEMA_VERSION

  if (!next.title || typeof next.title !== "string" || !next.title.trim()) {
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
    next.title = heading || pathToTitle(relativePath)
  }

  next.type = normalizeTypeAlias(String(next.type ?? "")) ?? inferTypeFromPath(relativePath)

  next.summary = clampSummaryLength(
    typeof next.summary === "string" ? next.summary : "",
    next.title,
    body,
  )

  if (!next.confidence || !CONFIDENCE.includes(next.confidence as Confidence)) {
    next.confidence = "中"
  }
  next.status = normalizeStatusAlias(String(next.status ?? "")) ?? "活跃"

  for (const field of ["aliases", "tags", "sources"] as const) {
    const value = next[field]
    if (value == null) next[field] = []
    else if (!Array.isArray(value)) next[field] = [String(value)]
  }

  next.related = sanitizeRelatedField(next.related)

  if (Array.isArray(next.sources)) {
    next.sources = cleanSources(next.sources)
  }

  return next
}

// -----------------------------------------------------------------------------
// Sources cleaning (§3.2)
// -----------------------------------------------------------------------------

const SOURCE_PREFIX_BLOCKLIST = /^(好的|以下是|这份|现在写入)/

export function cleanSources(raw: string[]): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []

  for (const item of raw) {
    if (typeof item !== "string") continue
    let s = item.trim()
    if (!s) continue
    if (s.includes("]]") || s.includes("：")) continue
    if (SOURCE_PREFIX_BLOCKLIST.test(s)) continue

    // Strip .md, keep .pdf/.xlsx etc.
    s = s.replace(/\.md$/i, "")
    // Strip "-1" / "-2" duplicate suffixes
    s = s.replace(/-\d+$/, "")
    // Truncate long names
    if (s.length > 60) s = s.slice(0, 40) + "..."
    if (!s) continue

    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export function validate(fm: Partial<WikiFrontmatter>): SchemaViolation[] {
  const violations: SchemaViolation[] = []

  if (fm.schema_version !== SCHEMA_VERSION) {
    violations.push({
      field: "schema_version",
      message: `schema_version 必须为 ${SCHEMA_VERSION}`,
      fatal: true,
    })
  }

  if (!fm.title || typeof fm.title !== "string" || !fm.title.trim()) {
    violations.push({ field: "title", message: "title 必填", fatal: true })
  }

  if (!fm.type) {
    violations.push({ field: "type", message: "type 必填", fatal: true })
  } else if (!WIKI_TYPES.includes(fm.type as WikiType)) {
    violations.push({
      field: "type",
      message: `type 必须为 ${WIKI_TYPES.join("/")} 之一，当前为 "${fm.type}"`,
      fatal: true,
    })
  }

  if (!fm.summary || typeof fm.summary !== "string") {
    violations.push({ field: "summary", message: "summary 必填", fatal: true })
  } else {
    const len = [...fm.summary].length // count by code-point for CJK
    if (len < SUMMARY_MIN || len > SUMMARY_MAX) {
      violations.push({
        field: "summary",
        message: `summary 字数须在 ${SUMMARY_MIN}-${SUMMARY_MAX} 之间（当前 ${len}）`,
        fatal: true,
      })
    }
  }

  for (const field of ["created", "updated", "last_reviewed"] as const) {
    const v = fm[field]
    if (!v || typeof v !== "string") {
      violations.push({ field, message: `${field} 必填`, fatal: true })
    } else if (!TIMESTAMP_REGEX.test(v)) {
      violations.push({
        field,
        message: `${field} 格式须为 YYYY-MM-DD HH:mm:ss（当前 "${v}"）`,
        fatal: true,
      })
    }
  }

  if (!fm.confidence) {
    violations.push({ field: "confidence", message: "confidence 必填", fatal: true })
  } else if (!CONFIDENCE.includes(fm.confidence as Confidence)) {
    violations.push({
      field: "confidence",
      message: `confidence 必须为 ${CONFIDENCE.join("/")} 之一`,
      fatal: true,
    })
  }

  if (!fm.status) {
    violations.push({ field: "status", message: "status 必填", fatal: true })
  } else if (!WIKI_STATUS.includes(fm.status as WikiStatus)) {
    violations.push({
      field: "status",
      message: `status 必须为 ${WIKI_STATUS.join("/")} 之一`,
      fatal: true,
    })
  }

  // Type-specific
  if (fm.type === "股票") {
    if (!fm.code || !STOCK_CODE_REGEX.test(fm.code)) {
      violations.push({
        field: "code",
        message: "股票页 code 必填且须匹配 SZ/SH/BJ + 6 位数字、HK + 5 位数字或美股 ticker",
        fatal: true,
      })
    }
  }

  // related wikilink format
  if (Array.isArray(fm.related)) {
    for (const item of fm.related) {
      if (typeof item !== "string" || !WIKILINK_REGEX.test(item)) {
        violations.push({
          field: "related",
          message: `related 元素须为 "[[type/name]]" 形式，发现 "${item}"`,
          fatal: true,
        })
      }
    }
  }

  // momentum enum (concept only)
  if (fm.momentum != null && !MOMENTUM.includes(fm.momentum as Momentum)) {
    violations.push({
      field: "momentum",
      message: `momentum 必须为 ${MOMENTUM.join("/")} 之一`,
      fatal: true,
    })
  }

  // Warnings: type-specific fields appearing on wrong type
  if (fm.type && fm.type !== "股票") {
    for (const f of ["code", "industry", "concepts"] as const) {
      if (fm[f] !== undefined) {
        violations.push({
          field: f,
          message: `${f} 仅在 type=股票 下有效`,
          fatal: false,
        })
      }
    }
  }
  if (fm.type && fm.type !== "概念") {
    for (const f of ["parent", "momentum", "catalysts"] as const) {
      if (fm[f] !== undefined) {
        violations.push({
          field: f,
          message: `${f} 仅在 type=概念 下有效`,
          fatal: false,
        })
      }
    }
  }

  return violations
}

// -----------------------------------------------------------------------------
// Canonical sample for LLM retry prompts
// -----------------------------------------------------------------------------

export function canonicalSampleFor(type: WikiType): string {
  const now = "2026-05-11 14:23:07"
  const base: Record<string, unknown> = {
    schema_version: 1,
    title: type === "股票" ? "爱迪特" : "示例页面",
    aliases: type === "股票" ? ["301580", "SZ301580"] : [],
    type,
    summary:
      type === "股票"
        ? "齿科陶瓷材料龙头，稀土管制下国产替代受益标的，主营氧化锆瓷块，出海日美高端齿科厂商。"
        : "示例摘要（50-120 字之间）。该字段用于检索召回，禁止照搬正文段落，只做高度概括。",
    tags: [],
    related: [],
    sources: [],
    created: now,
    updated: now,
    last_reviewed: now,
    confidence: "高",
    status: "活跃",
  }

  if (type === "股票") {
    base.code = "SZ301580"
    base.industry = "医疗器械"
    base.concepts = ["稀土管制", "国产替代"]
  } else if (type === "概念") {
    base.parent = ""
    base.momentum = "热"
    base.catalysts = []
  }

  return "---\n" + stringifyYaml(base, { lineWidth: 0 }) + "---\n"
}

// -----------------------------------------------------------------------------
// Parse & serialize
// -----------------------------------------------------------------------------

export interface ParseResult {
  fm: Partial<WikiFrontmatter>
  body: string
  hadYamlWrapper: boolean
}

// 剥掉 ```yaml ... ``` wrapper（schema v1 输出格式），把内嵌 frontmatter 还原成裸 --- 形式。
function stripYamlWrapper(raw: string): { content: string; stripped: boolean } {
  // Pattern: starts with ```yaml\n<frontmatter block>\n```\n
  const m = raw.match(/^```yaml\s*\n([\s\S]*?)\n```\s*\n/)
  if (!m) return { content: raw, stripped: false }
  return { content: m[1] + "\n" + raw.slice(m[0].length), stripped: true }
}

export function parseFrontmatter(markdown: string): ParseResult {
  const { content, stripped } = stripYamlWrapper(markdown)
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fmMatch) {
    return { fm: {}, body: content, hadYamlWrapper: stripped }
  }
  const fmText = fmMatch[1]
  const body = content.slice(fmMatch[0].length)

  let parsed: Partial<WikiFrontmatter> = {}
  try {
    const obj = parseYaml(fmText) as unknown
    if (obj && typeof obj === "object") {
      parsed = obj as Partial<WikiFrontmatter>
    }
  } catch {
    // Leave fm empty on parse failure; caller will treat as missing.
  }
  return { fm: parsed, body, hadYamlWrapper: stripped }
}

function orderedKeys(fm: WikiFrontmatter): (keyof WikiFrontmatter)[] {
  const seen = new Set<string>()
  const order: (keyof WikiFrontmatter)[] = []
  const push = (k: keyof WikiFrontmatter) => {
    if (!seen.has(k as string) && fm[k] !== undefined) {
      order.push(k)
      seen.add(k as string)
    }
  }
  for (const k of COMMON_FIELD_ORDER) push(k)
  if (fm.type === "股票") for (const k of STOCK_FIELD_ORDER) push(k)
  if (fm.type === "概念") for (const k of CONCEPT_FIELD_ORDER) push(k)
  return order
}

export function serializeFrontmatter(fm: WikiFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {}
  for (const k of orderedKeys(fm)) {
    ordered[k as string] = fm[k]
  }
  const yaml = stringifyYaml(ordered, { lineWidth: 0 })
  // 用 ```yaml + --- ... --- + ``` 包裹：
  // - Milkdown (commonmark+gfm) 无 frontmatter 插件，裸 `---` 会被渲染成水平线 + 段落，看着乱
  // - 包成 yaml 代码块后在编辑器里显示为代码块，安全且清晰
  // - 内嵌的 `---` 保留标准 frontmatter 形态，parseFrontmatter 的 stripYamlWrapper 能拆开后继续走 ^--- 匹配
  const cleanBody = body.startsWith("\n") ? body.slice(1) : body
  return `\`\`\`yaml\n---\n${yaml}---\n\`\`\`\n${cleanBody}`
}
