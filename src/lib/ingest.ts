import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore, type PlanItem } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { debugLog } from "@/lib/debug-log"
import { withRetry } from "@/lib/retry"
import {
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  sha256Hex,
  type IngestCheckpoint,
} from "@/lib/ingest-checkpoint"
import {
  WIKI_TYPES,
  WIKI_STATUS,
  CONFIDENCE,
  SCHEMA_VERSION,
  canonicalSampleFor,
  coerceWikiPageFrontmatter,
  cleanSources,
  normalizeTypeAlias,
  inferTypeFromPath,
  nowLocalTimestamp,
  parseFrontmatter,
  pathToTitle,
  serializeFrontmatter,
  validate,
  type WikiType,
  type WikiFrontmatter,
  type SchemaViolation,
} from "@/lib/schema"
import { lookupStockCode } from "@/commands/stock-codes"
import { appendDailyLog, dailyLogPath, localDateString, mergeIndexEntries, type IndexEntryInput } from "@/lib/wiki-housekeeping"

export const LANGUAGE_RULE = "## Language Rule\n- ALWAYS match the language of the source document. If the source is in Chinese, write in Chinese. If in English, write in English. Wiki page titles, content, and descriptions should all be in the same language as the source material."

interface PlanCreateItem {
  path: string
  type: string
  title: string
  why?: string
}

interface PlanUpdateItem {
  path: string
  why?: string
}

interface Plan {
  create: PlanCreateItem[]
  update: PlanUpdateItem[]
}

const RESERVED_PATHS = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])

/** Max update pages per ingest run — excess deferred to review */
const MAX_PLAN_UPDATES = 8
/** Parallel LLM calls in Stage 3 */
const UPDATE_CONCURRENCY = 2

const INGEST_MAX_TOKENS = {
  analyze: 8192,
  plan: 4096,
  update: 8192,
  updateFullPage: 16384,
  create: 32768,
  retry: 8192,
} as const

export type IngestStageLabel = "analyze" | "plan" | "update" | "create"

export interface IngestStreamHooks {
  /** 每个 stage 开始前调用，便于上层在 chat 起新消息 */
  onStageStart?: (stage: IngestStageLabel, label: string) => void
  /** LLM 流式输出的每个 token */
  onStageToken?: (token: string, stage: IngestStageLabel) => void
  /** 每个 stage 结束后调用，完整文本传回 */
  onStageEnd?: (stage: IngestStageLabel, fullText: string) => void
}

export interface AutoIngestOptions {
  /** 已有的分析文本（如来自 Stage 0 chat 对话）→ 跳过 Stage 1，直接进 Stage 2 */
  preAnalysis?: string
  /** 流式回显 hooks */
  stream?: IngestStreamHooks
}

/**
 * Auto-ingest: 4-stage agent loop.
 *   1. Analyze source        → structured analysis text (可被 preAnalysis 跳过)
 *   2. Plan changes          → JSON plan listing exact creates/updates
 *   3. Update existing pages → one LLM call per page, merge-safe
 *   4. Create new pages      → batch call generates new pages + programmatic index/overview/log
 */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  options?: AutoIngestOptions,
): Promise<string[]> {
  const preAnalysis = options?.preAnalysis
  const stream = options?.stream
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const runDate = new Date()
  const dailyLogRelativePath = dailyLogPath(runDate)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })
  activity.setStages(activityId, [
    { step: 1, label: "分析源文档", status: "pending" },
    { step: 2, label: "规划变更", status: "pending" },
    { step: 3, label: "更新已有页面", status: "pending" },
    { step: 4, label: "新建页面 + 索引/概览/日志", status: "pending" },
  ])

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])

  let wikiDirs: string[] = []
  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    wikiDirs = wikiTree.filter((n) => n.is_dir).map((n) => `wiki/${n.name}/`)
  } catch {
    // ignore
  }

  // Cache check: skip re-ingest if source content hasn't changed
  const cachedFiles = await checkIngestCache(pp, fileName, sourceContent)
  if (cachedFiles !== null) {
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return cachedFiles
  }

  // Compute content hash for checkpoint
  const contentHash = await sha256Hex(sourceContent)
  const existingCheckpoint = await loadCheckpoint(pp, contentHash)
  const checkpoint: IngestCheckpoint = existingCheckpoint ?? {
    sourceFileName: fileName,
    hash: contentHash,
    timestamp: Date.now(),
  }
  const isResume = existingCheckpoint !== null

  const truncatedContent = sourceContent.length > 100000
    ? sourceContent.slice(0, 100000) + "\n\n[...truncated...]"
    : sourceContent

  // Retry-wrapped stream invocation with status surfaced to UI
  const retryOpts = (stepLabel: string) => ({
    maxAttempts: 3,
    backoffMs: [3000, 8000],
    signal,
    onRetry: (err: Error, attempt: number, nextDelayMs: number) => {
      debugLog("warn", "ingest-retry", `${stepLabel} attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, {
        error: err.message,
      })
      activity.updateItem(activityId, {
        detail: `${stepLabel} — 网络错误，${Math.round(nextDelayMs / 1000)}s 后重试（第 ${attempt + 1}/3 次）`,
      })
    },
  })

  // ── Stage 1: Analyze ───────────────────────────────────────
  let analysis: string
  if (preAnalysis) {
    // 调用方已提供分析（如 Stage 0 chat 对话）→ 直接复用，跳过 LLM 调用
    activity.updateStage(activityId, 1, { status: "done" })
    activity.updateItem(activityId, { detail: "Step 1/4: Reusing analysis from chat (Stage 0)" })
    analysis = preAnalysis
    checkpoint.analysis = analysis
    await saveCheckpoint(pp, contentHash, checkpoint)
  } else if (checkpoint.analysis) {
    activity.updateStage(activityId, 1, { status: "done" })
    activity.updateItem(activityId, { detail: "Step 1/4: Reusing cached analysis (resumed)" })
    analysis = checkpoint.analysis
  } else {
    activity.updateStage(activityId, 1, { status: "running" })
    activity.updateItem(activityId, {
      detail: isResume ? "Step 1/4: Analyzing source... (resumed)" : "Step 1/4: Analyzing source...",
    })
    stream?.onStageStart?.("analyze", "Step 1/4: 分析源文档")
    try {
      analysis = await withRetry(
        () =>
          runAnalysisStage(
            llmConfig,
            fileName,
            truncatedContent,
            purpose,
            index,
            folderContext,
            signal,
            (token) => stream?.onStageToken?.(token, "analyze"),
          ),
        retryOpts("Step 1/4: Analyzing"),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      activity.updateStage(activityId, 1, { status: "error", error: msg })
      activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${msg}` })
      return []
    }
    if (signal?.aborted) {
      activity.updateStage(activityId, 1, { status: "error", error: "Cancelled" })
      activity.updateItem(activityId, { status: "error", detail: "Cancelled" })
      return []
    }
    stream?.onStageEnd?.("analyze", analysis)
    checkpoint.analysis = analysis
    await saveCheckpoint(pp, contentHash, checkpoint)
    activity.updateStage(activityId, 1, { status: "done" })
  }

  // ── Stage 2: Plan ──────────────────────────────────────────
  let plan: Plan
  let deferredPlanUpdates: PlanUpdateItem[] = []
  if (checkpoint.plan) {
    activity.updateStage(activityId, 2, { status: "done" })
    activity.updateItem(activityId, { detail: "Step 2/4: Reusing cached plan (resumed)" })
    plan = checkpoint.plan
  } else {
    activity.updateStage(activityId, 2, { status: "running" })
    activity.updateItem(activityId, { detail: "Step 2/4: Planning changes..." })
    stream?.onStageStart?.("plan", "Step 2/4: 规划变更")
    let planRaw = ""
    try {
      plan = await withRetry(
        () =>
          runPlanStage(
            llmConfig,
            fileName,
            sourceBaseName,
            analysis,
            schema,
            index,
            wikiDirs,
            signal,
            (token) => {
              planRaw += token
              stream?.onStageToken?.(token, "plan")
            },
          ),
        retryOpts("Step 2/4: Planning"),
      )
      plan = await normalizePlan(pp, plan)
      const { plan: cappedPlan, deferredUpdates } = capPlanUpdates(plan)
      plan = cappedPlan
      deferredPlanUpdates = deferredUpdates
      if (deferredUpdates.length > 0) {
        debugLog("warn", "ingest-plan", `Deferred ${deferredUpdates.length} update(s) beyond cap ${MAX_PLAN_UPDATES}`, {
          deferred: deferredUpdates.map((u) => u.path),
        })
        activity.updateItem(activityId, {
          detail: `Step 2/4: Plan ready (${deferredUpdates.length} updates deferred — see Review)`,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      activity.updateStage(activityId, 2, { status: "error", error: msg })
      activity.updateItem(activityId, { status: "error", detail: `Plan stage failed: ${msg}` })
      return []
    }
    if (signal?.aborted) {
      activity.updateStage(activityId, 2, { status: "error", error: "Cancelled" })
      activity.updateItem(activityId, { status: "error", detail: "Cancelled" })
      return []
    }
    stream?.onStageEnd?.("plan", planRaw)
    checkpoint.plan = plan
    await saveCheckpoint(pp, contentHash, checkpoint)
    activity.updateStage(activityId, 2, { status: "done" })
  }

  // Materialize plan into store so the UI can render per-page sub-rows
  // Pre-mark items already completed in a prior run (from checkpoint)
  const completedUpdates = new Set(checkpoint.completedUpdates ?? [])
  const stage4DoneAlready = checkpoint.stage4Done === true
  const stage4Written = new Set((checkpoint.stage4Written ?? []).map((p) => p === "wiki/log.md" ? dailyLogRelativePath : p))
  // Housekeeping items: always part of stage 4
  const HOUSEKEEPING_PATHS = ["wiki/index.md", "wiki/overview.md", dailyLogRelativePath]
  const housekeepingAction = (path: string): "update" | "append" =>
    path.startsWith("wiki/logs/") ? "append" : "update"
  const planItems: PlanItem[] = [
    ...plan.update.map((u, i): PlanItem => ({
      id: `u-${i}`,
      action: "update",
      path: u.path,
      why: u.why,
      status: completedUpdates.has(u.path) ? "done" : "pending",
      stage: 3,
    })),
    ...plan.create.map((c, i): PlanItem => ({
      id: `c-${i}`,
      action: "create",
      path: c.path,
      why: c.why,
      status: stage4DoneAlready
        ? stage4Written.has(c.path) ? "done" : "error"
        : "pending",
      error: stage4DoneAlready && !stage4Written.has(c.path) ? "Not written in Stage 4" : undefined,
      stage: 4,
    })),
    ...HOUSEKEEPING_PATHS.map((p): PlanItem => ({
      id: `h-${p.replace(/[\/.]/g, "-")}`,
      action: housekeepingAction(p),
      path: p,
      why: p === "wiki/index.md"
        ? "保留全部已有条目，新增本次摄入的链接"
        : p === "wiki/overview.md"
        ? "更新概览以反映新摄入的源"
        : "追加本次摄入的日期分片日志条目",
      status: stage4DoneAlready
        ? stage4Written.has(p) ? "done" : "error"
        : "pending",
      error: stage4DoneAlready && !stage4Written.has(p) ? "Not written in Stage 4" : undefined,
      stage: 4,
    })),
  ]
  activity.setPlan(activityId, planItems)

  const writtenPaths: string[] = [
    ...(checkpoint.completedUpdates ?? []),
    ...(stage4DoneAlready
      ? (checkpoint.stage4Written ?? []).map((p) => p === "wiki/log.md" ? dailyLogRelativePath : p)
      : []),
  ]
  let allReviewBlocks = checkpoint.reviewBlocksRaw ?? ""

  // ── Stage 3: Updates (incremental merge + parallel LLM, checkpoint per item) ──
  const pendingUpdates = plan.update
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => !completedUpdates.has(u.path))

  if (plan.update.length > 0) {
    activity.updateStage(activityId, 3, { status: "running" })
    activity.updateItem(activityId, {
      detail: pendingUpdates.length === plan.update.length
        ? `Step 3/4: Updating ${plan.update.length} page(s) (×${UPDATE_CONCURRENCY})...`
        : `Step 3/4: Resuming — ${pendingUpdates.length}/${plan.update.length} remaining`,
    })
    let stage3Failed = 0

    const processOneUpdate = async ({ u, i }: { u: PlanUpdateItem; i: number }) => {
      if (signal?.aborted) {
        return { ok: false as const, planItemId: `u-${i}`, path: u.path, error: "Cancelled" }
      }
      const planItemId = `u-${i}`
      activity.updatePlanItem(activityId, planItemId, { status: "running" })
      stream?.onStageStart?.("update", `Step 3/4: 更新 ${u.path}`)
      try {
        const existingContent = await tryReadFile(`${pp}/${u.path}`)
        if (!existingContent) {
          throw new Error(`Existing file not found: ${u.path}`)
        }
        const updateMaxTokens = estimateUpdateMaxTokens(existingContent)
        const generation = await withRetry(
          () =>
            runUpdateStage(
              llmConfig,
              fileName,
              sourceBaseName,
              u,
              existingContent,
              analysis,
              signal,
              UPDATE_CONCURRENCY > 1 ? undefined : (token) => stream?.onStageToken?.(token, "update"),
              updateMaxTokens,
            ),
          {
            maxAttempts: 2,
            backoffMs: [3000],
            signal,
            onRetry: (err, attempt, nextDelayMs) => {
              debugLog("warn", "ingest-retry", `Update ${u.path} attempt ${attempt} failed, retrying`, {
                error: err.message,
                nextDelayMs,
              })
            },
          },
        )
        const nowTs = nowLocalTimestamp()
        const mergedContent = mergeUpdateFromLlmOutput(
          existingContent,
          generation,
          u.path,
          sourceBaseName,
          nowTs,
        )
        const writeResult = await writeRepairedWikiPage(
          llmConfig,
          pp,
          u.path,
          mergedContent,
          signal,
          activityId,
          planItemId,
        )
        if (!writeResult.written) {
          throw new Error(writeResult.error ?? "Failed to write updated page")
        }
        stream?.onStageEnd?.("update", `✓ ${u.path}`)
        return {
          ok: true as const,
          planItemId,
          path: u.path,
          generation,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        activity.updatePlanItem(activityId, planItemId, { status: "error", error: msg })
        stream?.onStageEnd?.("update", `✗ ${u.path}: ${msg}`)
        return { ok: false as const, planItemId, path: u.path, error: msg }
      }
    }

    const updateResults = await mapWithConcurrency(
      pendingUpdates,
      UPDATE_CONCURRENCY,
      processOneUpdate,
    )

    for (const result of updateResults) {
      if (result.ok) {
        writtenPaths.push(result.path)
        allReviewBlocks += `\n${result.generation}`
        completedUpdates.add(result.path)
        activity.updatePlanItem(activityId, result.planItemId, { status: "done" })
      } else if (result.error !== "Cancelled") {
        stage3Failed++
      }
    }

    if (completedUpdates.size > 0) {
      checkpoint.completedUpdates = Array.from(completedUpdates)
      checkpoint.reviewBlocksRaw = allReviewBlocks
      await saveCheckpoint(pp, contentHash, checkpoint)
    }

    activity.updateStage(activityId, 3, {
      status: stage3Failed === pendingUpdates.length && pendingUpdates.length > 0 ? "error" : "done",
      error: stage3Failed > 0 ? `${stage3Failed}/${pendingUpdates.length} 失败` : undefined,
    })
  } else {
    activity.updateStage(activityId, 3, { status: "done" })
    activity.updateItem(activityId, { detail: "Step 3/4: No pages to update — skipped" })
  }

  // ── Stage 4: Creates + programmatic index/overview/log ─────────────────
  if (signal?.aborted) {
    activity.updateStage(activityId, 4, { status: "error", error: "Cancelled" })
  } else if (stage4DoneAlready) {
    activity.updateStage(activityId, 4, { status: "done" })
    activity.updateItem(activityId, { detail: "Step 4/4: Reusing cached creates (resumed)" })
  } else {
    activity.updateStage(activityId, 4, { status: "running" })
    const createCount = plan.create.length
    activity.updateItem(activityId, {
      detail: `Step 4/4: Creating ${createCount} new page(s) + updating index...`,
    })
    stream?.onStageStart?.("create", `Step 4/4: 新建 ${createCount} 个页面 + 索引/概览/日志`)
    let createRaw = ""
    try {
      const createGeneration = await withRetry(
        () =>
          runCreateStage(
            llmConfig,
            plan,
            fileName,
            sourceBaseName,
            analysis,
            truncatedContent,
            schema,
            purpose,
            index,
            overview,
            wikiDirs,
            signal,
            (token) => {
              createRaw += token
              stream?.onStageToken?.(token, "create")
            },
          ),
        retryOpts("Step 4/4: Creating"),
      )
      const { written, errors: createErrors } = await repairAndWriteBlocks(
        llmConfig,
        pp,
        createGeneration,
        undefined,
        signal,
        activityId,
        (p) => {
          const idx = plan.create.findIndex((c) => c.path === p)
          return idx >= 0 ? `c-${idx}` : null
        },
      )
      writtenPaths.push(...written)
      const housekeepingWritten = await writeProgrammaticHousekeeping(
        pp,
        sourceBaseName,
        Array.from(new Set(writtenPaths)),
        runDate,
      )
      writtenPaths.push(...housekeepingWritten)
      const missing = plan.create.filter((c) => !written.includes(c.path))
      if (missing.length > 0) {
        debugLog("warn", "ingest-create", `Create stage missed ${missing.length}/${plan.create.length} planned pages`, {
          missingPaths: missing.map((c) => c.path),
          writtenPaths: written,
          responseLength: createGeneration.length,
          responsePreview: createGeneration.slice(0, 1000),
          fullResponse: createGeneration,
        })
      }
      for (let i = 0; i < plan.create.length; i++) {
        const c = plan.create[i]
        const wasWritten = written.some((p) => p === c.path)
        const repairErr = createErrors.get(c.path)
        activity.updatePlanItem(activityId, `c-${i}`, {
          status: wasWritten ? "done" : "error",
          error: wasWritten ? undefined : repairErr ?? "Not in LLM output",
        })
      }
      for (const hk of HOUSEKEEPING_PATHS) {
        const wasWritten = housekeepingWritten.some((p) => p === hk)
        activity.updatePlanItem(activityId, `h-${hk.replace(/[\/.]/g, "-")}`, {
          status: wasWritten ? "done" : "error",
          error: wasWritten ? undefined : "Programmatic housekeeping did not write this path",
        })
      }
      const missingHousekeeping = HOUSEKEEPING_PATHS.filter((p) => !housekeepingWritten.includes(p))
      if (missingHousekeeping.length > 0) {
        debugLog("warn", "ingest-create", `Stage 4 missed housekeeping pages: ${missingHousekeeping.join(", ")}`, {
          writtenPaths: housekeepingWritten,
          responseLength: createGeneration.length,
          responsePreview: createGeneration.slice(0, 1000),
        })
      }
      allReviewBlocks += "\n" + createGeneration
      checkpoint.stage4Done = true
      checkpoint.stage4Written = [...written, ...housekeepingWritten]
      checkpoint.reviewBlocksRaw = allReviewBlocks
      await saveCheckpoint(pp, contentHash, checkpoint)
      const totalFailed = missing.length + missingHousekeeping.length
      const totalExpected = plan.create.length + HOUSEKEEPING_PATHS.length
      activity.updateStage(activityId, 4, {
        status: totalFailed === totalExpected ? "error" : "done",
        error: totalFailed > 0 ? `${totalFailed}/${totalExpected} 缺失` : undefined,
      })
      stream?.onStageEnd?.("create", createRaw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (let i = 0; i < plan.create.length; i++) {
        activity.updatePlanItem(activityId, `c-${i}`, { status: "error", error: msg })
      }
      for (const hk of HOUSEKEEPING_PATHS) {
        activity.updatePlanItem(activityId, `h-${hk.replace(/[\/.]/g, "-")}`, {
          status: "error",
          error: msg,
        })
      }
      activity.updateStage(activityId, 4, { status: "error", error: msg })
      stream?.onStageEnd?.("create", `✗ Stage 4 failed: ${msg}`)
    }
  }

  // Source summary fallback (if LLM didn't generate one)
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const hasSourceSummary = writtenPaths.some((p) => p === sourceSummaryPath)
  if (!hasSourceSummary) {
    const date = new Date().toISOString().slice(0, 10)
    const fallback = [
      "---",
      `type: source`,
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis,
      "",
    ].join("\n")
    try {
      await writeFile(`${pp}/${sourceSummaryPath}`, fallback)
      writtenPaths.push(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  // Dedupe written paths (defensive — shouldn't normally have dups)
  const uniqueWritten = Array.from(new Set(writtenPaths))

  if (uniqueWritten.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  const reviewItems = parseReviewBlocks(allReviewBlocks, sp)
  if (deferredPlanUpdates.length > 0) {
    reviewItems.push(
      ...deferredPlanUpdates.map((u) => ({
        type: "suggestion" as const,
        title: `延后更新: ${pathToTitle(u.path)}`,
        description:
          u.why ??
          `单次入库最多自动更新 ${MAX_PLAN_UPDATES} 个已有页面。请稍后对该页单独 ingest，或手动编辑 ${u.path}。`,
        sourcePath: sp,
        affectedPages: [u.path],
        options: [{ label: "知道了", action: "Skip" }],
      })),
    )
  }
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  if (uniqueWritten.length > 0) {
    await saveIngestCache(pp, fileName, sourceContent, uniqueWritten)
    // Full run succeeded — clean up the checkpoint
    await deleteCheckpoint(pp, contentHash)
  }

  // Embeddings (existing — unchanged)
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && uniqueWritten.length > 0) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of uniqueWritten) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // module not available
    }
  }

  // Final summary
  const finalPlan =
    useActivityStore.getState().items.find((i) => i.id === activityId)?.plan ?? []
  const failedCount = finalPlan.filter((p) => p.status === "error").length

  let detail: string
  if (uniqueWritten.length === 0) {
    detail = "No files generated"
  } else {
    const reviewSuffix = reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""
    const failSuffix = failedCount > 0 ? ` (${failedCount} failed)` : ""
    detail = `${uniqueWritten.length} files written${reviewSuffix}${failSuffix}`
  }

  activity.updateItem(activityId, {
    status: uniqueWritten.length > 0 ? "done" : "error",
    detail,
    filesWritten: uniqueWritten,
  })

  return uniqueWritten
}

// ── Stage runners ─────────────────────────────────────────────

async function runAnalysisStage(
  llmConfig: LlmConfig,
  fileName: string,
  truncatedContent: string,
  purpose: string,
  index: string,
  folderContext: string | undefined,
  signal: AbortSignal | undefined,
  onToken?: (token: string) => void,
): Promise<string> {
  let analysis = ""
  let failed = false
  let failMsg = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt(purpose, index) },
      {
        role: "user",
        content: `Analyze this source document:\n\n**File:** ${fileName}${
          folderContext ? `\n**Folder context:** ${folderContext}` : ""
        }\n\n---\n\n${truncatedContent}`,
      },
    ],
    {
      onToken: (token) => {
        analysis += token
        onToken?.(token)
      },
      onDone: () => {},
      onError: (err) => {
        failed = true
        failMsg = err.message
      },
    },
    signal,
    { maxTokens: INGEST_MAX_TOKENS.analyze },
  )

  if (failed) {
    throw new Error(failMsg)
  }
  return analysis
}

async function runPlanStage(
  llmConfig: LlmConfig,
  fileName: string,
  sourceBaseName: string,
  analysis: string,
  schema: string,
  index: string,
  wikiDirs: string[],
  signal: AbortSignal | undefined,
  onToken?: (token: string) => void,
): Promise<Plan> {
  let raw = ""
  let failed = false
  let failMsg = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: buildPlanPrompt(schema, index, wikiDirs, fileName, sourceBaseName),
      },
      {
        role: "user",
        content: [
          `Source file: **${fileName}**`,
          "",
          "## Source analysis",
          "",
          analysis,
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => {
        raw += token
        onToken?.(token)
      },
      onDone: () => {},
      onError: (err) => {
        failed = true
        failMsg = err.message
      },
    },
    signal,
    { maxTokens: INGEST_MAX_TOKENS.plan },
  )

  if (failed) {
    throw new Error(failMsg)
  }
  return parsePlan(raw)
}

async function runUpdateStage(
  llmConfig: LlmConfig,
  fileName: string,
  sourceBaseName: string,
  page: PlanUpdateItem,
  existingContent: string,
  analysis: string,
  signal: AbortSignal | undefined,
  onToken?: (token: string) => void,
  maxTokens = INGEST_MAX_TOKENS.update,
): Promise<string> {
  let raw = ""
  let failed = false
  let failMsg = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildUpdatePrompt(page, sourceBaseName, nowLocalTimestamp()) },
      {
        role: "user",
        content: [
          `## Why this page is being updated`,
          page.why ?? "(no explicit reason from plan)",
          "",
          `## Existing content of ${page.path}`,
          existingContent.length > 60000
            ? `${existingContent.slice(0, 60000)}\n\n[...truncated for prompt — full page preserved on merge...]`
            : existingContent,
          "",
          `## Source analysis`,
          analysis,
          "",
          `## Source filename`,
          fileName,
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => {
        raw += token
        onToken?.(token)
      },
      onDone: () => {},
      onError: (err) => {
        failed = true
        failMsg = err.message
      },
    },
    signal,
    { maxTokens },
  )

  if (failed) {
    throw new Error(failMsg)
  }
  return raw
}

async function runCreateStage(
  llmConfig: LlmConfig,
  plan: Plan,
  fileName: string,
  sourceBaseName: string,
  analysis: string,
  truncatedContent: string,
  schema: string,
  purpose: string,
  index: string,
  overview: string,
  wikiDirs: string[],
  signal: AbortSignal | undefined,
  onToken?: (token: string) => void,
): Promise<string> {
  let raw = ""
  let failed = false
  let failMsg = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: buildCreatePrompt(plan, schema, purpose, index, overview, wikiDirs, fileName, sourceBaseName, nowLocalTimestamp()),
      },
      {
        role: "user",
        content: [
          `Generate only the wiki content pages listed in the plan. The app will update index, overview, and daily logs automatically.`,
          "",
          "## Source analysis",
          "",
          analysis,
          "",
          "## Original source content",
          "",
          truncatedContent,
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => {
        raw += token
        onToken?.(token)
      },
      onDone: () => {},
      onError: (err) => {
        failed = true
        failMsg = err.message
      },
    },
    signal,
    { maxTokens: INGEST_MAX_TOKENS.create },
  )

  if (failed) {
    throw new Error(failMsg)
  }
  return raw
}

// ── Plan parsing & normalization ──────────────────────────────

function parsePlan(rawText: string): Plan {
  const fencedJson = rawText.match(/```json\s*\n([\s\S]*?)```/i)
  const fencedAny = rawText.match(/```\s*\n([\s\S]*?)```/)
  let jsonText: string | null = null
  if (fencedJson) {
    jsonText = fencedJson[1]
  } else if (fencedAny) {
    jsonText = fencedAny[1]
  } else {
    const start = rawText.indexOf("{")
    const end = rawText.lastIndexOf("}")
    if (start >= 0 && end > start) {
      jsonText = rawText.slice(start, end + 1)
    }
  }
  if (!jsonText) {
    throw new Error("no JSON block found in LLM output")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText.trim())
  } catch (err) {
    throw new Error(`invalid JSON — ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("parsed value is not an object")
  }
  const obj = parsed as { create?: unknown; update?: unknown }

  const create: PlanCreateItem[] = []
  if (Array.isArray(obj.create)) {
    for (const raw of obj.create) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as Record<string, unknown>
      const path = typeof item.path === "string" ? item.path.trim() : ""
      if (!path.startsWith("wiki/") || !path.endsWith(".md")) continue
      if (RESERVED_PATHS.has(path)) continue
      create.push({
        path,
        type: typeof item.type === "string" ? item.type : "",
        title: typeof item.title === "string" ? item.title : path,
        why: typeof item.why === "string" ? item.why : undefined,
      })
    }
  }

  const update: PlanUpdateItem[] = []
  if (Array.isArray(obj.update)) {
    for (const raw of obj.update) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as Record<string, unknown>
      const path = typeof item.path === "string" ? item.path.trim() : ""
      if (!path.startsWith("wiki/") || !path.endsWith(".md")) continue
      if (RESERVED_PATHS.has(path)) continue
      update.push({
        path,
        why: typeof item.why === "string" ? item.why : undefined,
      })
    }
  }

  return { create, update }
}

function capPlanUpdates(plan: Plan): { plan: Plan; deferredUpdates: PlanUpdateItem[] } {
  if (plan.update.length <= MAX_PLAN_UPDATES) {
    return { plan, deferredUpdates: [] }
  }
  return {
    plan: { ...plan, update: plan.update.slice(0, MAX_PLAN_UPDATES) },
    deferredUpdates: plan.update.slice(MAX_PLAN_UPDATES),
  }
}

function estimateUpdateMaxTokens(existingContent: string): number {
  // Incremental updates need far fewer output tokens; allow more if model returns full page.
  const chars = existingContent.length
  if (chars > 12000) return INGEST_MAX_TOKENS.updateFullPage
  return INGEST_MAX_TOKENS.update
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await fn(items[index], index)
    }
  }

  const workers = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

export function mergeUpdateFromLlmOutput(
  existingContent: string,
  llmRaw: string,
  expectedPath: string,
  sourceBaseName: string,
  nowTs: string,
): string {
  const existing = parseFrontmatter(existingContent)
  const blocks = parseFileBlocks(llmRaw)
  let block = blocks.find((b) => b.path === expectedPath) ?? blocks[0]
  if (!block) {
    const implicit = tryExtractImplicitBlock(llmRaw, expectedPath)
    if (implicit) block = implicit
  }

  const fragment = (block?.content ?? llmRaw).trim()
  if (!fragment) {
    throw new Error("LLM returned empty update content")
  }

  const llmParsed = parseFrontmatter(fragment)
  const sectionHeader = `## 来自 ${sourceBaseName} 的补充`
  const looksLikeFullPage =
    Boolean(block) &&
    (llmParsed.fm.schema_version === SCHEMA_VERSION || llmParsed.fm.title) &&
    llmParsed.body.length > 0 &&
    llmParsed.body.length >= existing.body.length * 0.55

  let mergedBody: string
  let mergedFm: Partial<WikiFrontmatter>

  if (looksLikeFullPage) {
    mergedBody = llmParsed.body
    mergedFm = {
      ...existing.fm,
      ...llmParsed.fm,
      created: existing.fm.created ?? llmParsed.fm.created,
      code: llmParsed.fm.code ?? existing.fm.code,
    }
  } else {
    const incrementBody =
      llmParsed.body.trim().length > 0
        ? llmParsed.body.trim()
        : fragment.replace(/^---[\s\S]*?---\r?\n?/, "").trim()
    if (!incrementBody) {
      throw new Error("LLM returned no appendable markdown sections")
    }
    const alreadyHasSection = existing.body.includes(sectionHeader)
    mergedBody = alreadyHasSection
      ? `${existing.body.trimEnd()}\n\n${incrementBody}`
      : `${existing.body.trimEnd()}\n\n${sectionHeader}\n\n${incrementBody}`
    mergedFm = {
      ...existing.fm,
      sources: cleanSources([
        ...(Array.isArray(existing.fm.sources) ? existing.fm.sources : []),
        sourceBaseName,
      ]),
      updated: nowTs,
    }
  }

  const coerced = coerceWikiPageFrontmatter(mergedFm, expectedPath, mergedBody, { now: nowTs })
  return serializeFrontmatter(coerced as WikiFrontmatter, mergedBody)
}

async function writeRepairedWikiPage(
  llmConfig: LlmConfig,
  projectPath: string,
  relativePath: string,
  content: string,
  signal: AbortSignal | undefined,
  activityId: string | null,
  planItemId: string | null,
): Promise<{ written: boolean; error?: string }> {
  const activity = useActivityStore.getState()
  const result = await repairBlock(
    llmConfig,
    projectPath,
    { path: relativePath, content },
    signal,
    (n, max) => {
      if (activityId && planItemId) {
        activity.updatePlanItem(activityId, planItemId, { note: `重试中 ${n}/${max}` })
      }
    },
  )
  if (activityId && planItemId) {
    activity.updatePlanItem(activityId, planItemId, { note: undefined })
  }
  if (result.error || !result.content) {
    return { written: false, error: result.error ?? "Schema repair failed" }
  }
  await writeFile(`${projectPath}/${relativePath}`, result.content)
  return { written: true }
}

/**
 * Reconcile plan with filesystem reality. Action is determined by whether
 * the file exists on disk, not by which bucket the LLM put it in.
 *   - create entries that already exist on disk → move to update
 *   - update entries that don't exist on disk   → move to create (with inferred metadata)
 */
async function normalizePlan(pp: string, plan: Plan): Promise<Plan> {
  const create: PlanCreateItem[] = []
  const update: PlanUpdateItem[] = []
  const seen = new Set<string>()

  for (const c of plan.create) {
    if (seen.has(c.path)) continue
    seen.add(c.path)
    const existing = await tryReadFile(`${pp}/${c.path}`)
    if (existing) {
      update.push({ path: c.path, why: c.why })
    } else {
      create.push(c)
    }
  }
  for (const u of plan.update) {
    if (seen.has(u.path)) continue
    seen.add(u.path)
    const existing = await tryReadFile(`${pp}/${u.path}`)
    if (existing) {
      update.push(u)
    } else {
      // LLM mis-categorized — move to create with inferred metadata
      create.push({
        path: u.path,
        type: inferTypeFromPath(u.path),
        title: pathToTitle(u.path),
        why: u.why,
      })
    }
  }
  return { create, update }
}

// ── Prompt builders ───────────────────────────────────────────

function buildAnalysisPrompt(purpose: string, index: string): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "",
    LANGUAGE_RULE,
    "",
    "Your analysis should cover:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "Be exhaustive and concrete — every page the source mentions or implies should appear here, never silently dropped.",
    "",
    "### 建议更新（Pages to Update）",
    "List existing wiki pages that should absorb new content from this source. For each:",
    "- Exact wiki path (e.g. `wiki/概念/<slug>.md`)",
    "- One-sentence summary of what new content to add",
    "",
    "### 建议新建 / 可考虑新建（Pages to Create）",
    "List new wiki pages that should be created. **Treat the source's own \"可考虑新建\" / \"建议新建\" / \"recommend creating\" lists as authoritative — every page named there MUST appear here verbatim, do not filter as \"optional\".** For each:",
    "- Exact wiki path (e.g. `wiki/模式/<slug>.md`)",
    "- Type (use Chinese type when wiki schema uses Chinese: 股票/策略/模式/错误/市场环境/进化/总结/概念)",
    "- One-sentence reason for creating",
    "",
    "### Other",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildPlanPrompt(
  schema: string,
  index: string,
  wikiDirs: string[],
  fileName: string,
  sourceBaseName: string,
): string {
  return [
    "You are a wiki maintainer. Based on the source analysis you will receive, output a JSON plan",
    "listing exactly which wiki pages need to be created or updated.",
    "",
    LANGUAGE_RULE,
    "",
    "## Output format (CRITICAL)",
    "",
    "Output ONLY a single ```json``` fenced block. No prose before or after.",
    "",
    "```json",
    "{",
    `  "create": [`,
    `    {"path": "wiki/<dir>/<slug>.md", "type": "<type>", "title": "...", "why": "..."}`,
    "  ],",
    `  "update": [`,
    `    {"path": "wiki/<existing>.md", "why": "..."}`,
    "  ]",
    "}",
    "```",
    "",
    "## Rules",
    "",
    `- Available directories: ${wikiDirs.length > 0 ? wikiDirs.join(", ") : "wiki/entities/, wiki/concepts/"}`,
    `- You MUST use ONLY directories from the list above. Do NOT invent new directories.`,
    `- If Chinese directories exist (e.g. wiki/股票/, wiki/策略/, wiki/模式/), you MUST use them and NEVER use English equivalents (wiki/stocks/, wiki/strategies/, wiki/patterns/).`,
    `- Map types: 股票→wiki/股票/, 策略→wiki/策略/, 模式→wiki/模式/, 错误→wiki/错误/, 市场环境→wiki/市场环境/, 进化→wiki/进化/, 总结→wiki/总结/.`,
    `- Filenames inside subdirectories must be kebab-case for ASCII; preserve original Chinese for Chinese names. e.g. wiki/股票/沃格光电.md.`,
    `- The source summary page **wiki/sources/${sourceBaseName}.md** MUST appear in the plan (in \`create\` if new, or \`update\` if it already exists in the index).`,
    `- DO NOT include wiki/index.md, wiki/overview.md, or wiki/log.md in the plan — the system handles those automatically in the create stage.`,
    "",
    "## CRITICAL: Don't drop recommended pages",
    "",
    `- The source analysis may contain sections labelled "建议更新" / "建议新建" / "可考虑新建" / "可新建" / "应新建" / "should create" / "recommend creating" / "consider creating".`,
    `- **Every page mentioned in such a section MUST appear in this plan** — even if the section says "可考虑" (could consider). Treat them as authoritative, not optional.`,
    `- Put pages with paths that are NOT in the current wiki index into \`create\`.`,
    `- Put pages with paths that ARE in the current wiki index into \`update\`.`,
    `- If a wikilink style \`[模式/xxx](wikilink:模式/xxx)\` appears in the recommendations, convert to \`wiki/模式/xxx.md\` and include in the plan.`,
    `- Do not silently filter out recommendations you think are low-value — the source author already curated them.`,
    `- For \`update\`, do not pad the list with pages the source didn't actually touch — but DO include every page explicitly suggested.`,
    `- The \`why\` field should be a one-sentence reason that will guide the next stage's writing.`,
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index (use this to decide what already exists)\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function buildSchemaSection(types: WikiType[], nowTs: string): string {
  const uniq = Array.from(new Set(types.length > 0 ? types : (["概念"] as WikiType[])))
  const samples = uniq
    .map((t) => `### Canonical sample (type=${t})\n\n${canonicalSampleFor(t)}`)
    .join("\n")
  return [
    "## Frontmatter Schema (Schema v1)",
    "",
    "Every page MUST begin with valid YAML frontmatter delimited by `---`.",
    "**Never** wrap the frontmatter in a ```yaml fenced code block — output the bare `---` delimiters.",
    "",
    "### Required fields",
    "- `schema_version: 1`",
    "- `title` — must match the file name (without `.md`)",
    `- \`type\` — one of: ${WIKI_TYPES.join(" / ")}`,
    "- `summary` — 50–120 字概括，**严禁照搬正文段落**；只做高度概括，便于检索召回",
    "- `created`, `updated`, `last_reviewed` — format `YYYY-MM-DD HH:mm:ss`. Use `" +
      nowTs +
      "` for new fields; preserve existing `created`.",
    `- \`confidence\` — one of: ${CONFIDENCE.join(" / ")}`,
    `- \`status\` — one of: ${WIKI_STATUS.join(" / ")}`,
    "",
    "### Type-specific required fields",
    "- type=股票: `code` (e.g. `SZ301580`). The system will OVERWRITE this from a DB lookup — your value will be discarded, but the field must be present.",
    "",
    "### Optional fields",
    "- `aliases` — array of alternative names (also works on 概念 pages)",
    "- `tags`, `related`, `sources`",
    '- `related` items must be wikilink strings, format `"[[type/name]]"` (with the quotes)',
    "- `sources` items: raw source file names, NO `.md` suffix, NO LLM-reply prefixes like 「好的，以下是」",
    "- type=概念: `parent`, `momentum` (热/活跃/降温/已死), `catalysts`",
    "- type=股票: `industry`, `concepts`",
    "",
    "### Format rules",
    "- Do NOT include duplicate keys.",
    "- Do NOT output any field name in English when a Chinese enum value is defined (status, type, confidence, momentum).",
    "- Timestamps must include seconds (HH:mm:ss). Date-only like `2026-05-08` is INVALID.",
    "",
    samples,
  ].join("\n")
}

function buildUpdatePrompt(page: PlanUpdateItem, sourceBaseName: string, nowTs: string): string {
  const type = inferTypeFromPath(page.path)
  return [
    "You are updating an existing wiki page with new information from a source.",
    "",
    LANGUAGE_RULE,
    "",
    "## CRITICAL RULES",
    "",
    "1. **Do NOT rewrite or repeat the existing page.** Output ONLY the new markdown sections to append.",
    "2. The app will merge your output onto the existing page and update frontmatter programmatically.",
    "3. Start with a section heading like `## 来自 " + sourceBaseName + " 的补充` and write only new facts, links, and evidence.",
    "4. Use [[wikilink]] for cross-references. Do not output YAML frontmatter unless you must fix a single field.",
    "5. Output exactly ONE FILE block:",
    "",
    "   ---FILE: " + page.path + "---",
    "   (incremental markdown sections only — NOT the full page)",
    "   ---END FILE---",
    "",
    "Do NOT output any other text outside the FILE block.",
    "",
    "If the page is very small (<40 lines) you MAY output the full merged page instead, but prefer incremental sections.",
    "",
    buildSchemaSection([type], nowTs),
  ].join("\n")
}

function buildCreatePrompt(
  plan: Plan,
  schema: string,
  purpose: string,
  index: string,
  overview: string,
  wikiDirs: string[],
  fileName: string,
  sourceBaseName: string,
  nowTs: string,
): string {
  const createList = plan.create.length > 0
    ? plan.create
        .map(
          (c, i) =>
            `${i + 1}. **${c.path}** — type: ${c.type || "(inferred)"}, title: "${c.title}"${
              c.why ? `, why: ${c.why}` : ""
            }`,
        )
        .join("\n")
    : "(none)"

  const typesInPlan: WikiType[] = plan.create
    .map((c) => normalizeTypeAlias(c.type) ?? inferTypeFromPath(c.path))
    .filter((t): t is WikiType => !!t)

  return [
    "You are a wiki maintainer. Generate only the new wiki content files listed below.",
    "Do NOT output wiki/index.md, wiki/overview.md, wiki/log.md, or wiki/logs/**.",
    "",
    LANGUAGE_RULE,
    "",
    `## Source File: ${fileName}`,
    `All wiki pages generated MUST include "${sourceBaseName}" in their frontmatter \`sources\` field.`,
    "",
    "## Pages to create (from the plan)",
    "",
    createList,
    "",
    "## Output format",
    "",
    "Output each file in this exact format:",
    "",
    "---FILE: wiki/<path>.md---",
    "(complete file content with YAML frontmatter — NEVER wrap the frontmatter in ```yaml)",
    "---END FILE---",
    "",
    "Generate exactly these files:",
    `1. Each page from the create list above (do not skip any).`,
    `2. Do not output housekeeping files. The app will merge index.md, overview.md, and daily logs after content pages are written.`,
    "",
    buildSchemaSection(typesInPlan, nowTs),
    "",
    `Source summary page is **wiki/源文档/${sourceBaseName}.md** (when in the create list). Type for that page is \`源文档\`.`,
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax for cross-references between pages",
    "- Filenames inside subdirectories: preserve the original Chinese title for CJK names, kebab-case for ASCII",
    `- Available directories: ${wikiDirs.length > 0 ? wikiDirs.join(", ") : "wiki/股票/, wiki/概念/"}`,
    "",
    "## Review Items (optional)",
    "",
    "After all FILE blocks, output REVIEW blocks for things that need human judgment:",
    "",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: (see allowed options below)",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: search query 1 | search query 2 | search query 3",
    "---END REVIEW---",
    "",
    "Review types: contradiction, duplicate, missing-page, suggestion.",
    "Allowed OPTIONS: \"Create Page | Skip\" only. Do NOT invent custom options.",
    "Only emit reviews for things that genuinely need human input. Don't pad.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index (for link awareness only; do not output index.md)\n${index}` : "",
    overview ? `## Current Overview (for context only; do not output overview.md)\n${overview}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

// ── File-block writer ─────────────────────────────────────────

export type FileBlock = { path: string; content: string }

const SCHEMA_RETRY_MAX = 3

function isManagedLogPath(relativePath: string): boolean {
  return relativePath === "wiki/log.md" || /^wiki\/logs\/log-\d{4}-\d{2}-\d{2}\.md$/.test(relativePath)
}

function wikiLinkForPath(relativePath: string): string {
  return `[[${relativePath.replace(/^wiki\//, "").replace(/\.md$/i, "")}]]`
}

function fallbackTitleForPath(relativePath: string): string {
  return relativePath.split("/").pop()?.replace(/\.md$/i, "") || relativePath
}

async function indexEntryInputForPath(projectPath: string, relativePath: string): Promise<IndexEntryInput | null> {
  if (!relativePath.startsWith("wiki/") || !relativePath.endsWith(".md")) return null
  if (RESERVED_PATHS.has(relativePath) || isManagedLogPath(relativePath)) return null

  const content = await tryReadFile(`${projectPath}/${relativePath}`)
  if (!content.trim()) return null

  const parsed = parseFrontmatter(content)
  const heading = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const title = typeof parsed.fm.title === "string" && parsed.fm.title.trim()
    ? parsed.fm.title.trim()
    : heading ?? fallbackTitleForPath(relativePath)
  const summary = typeof parsed.fm.summary === "string" ? parsed.fm.summary.trim() : undefined

  return { path: relativePath, title, summary }
}

function buildOverviewIngestLine(sourceBaseName: string, pagePaths: string[], date: Date): string {
  const contentPages = pagePaths
    .filter((p) => p.startsWith("wiki/") && p.endsWith(".md") && !RESERVED_PATHS.has(p) && !isManagedLogPath(p))
  const links = contentPages.slice(0, 8).map(wikiLinkForPath).join(", ")
  const more = contentPages.length > 8 ? `, +${contentPages.length - 8} more` : ""
  return `- ${localDateString(date)}: ${sourceBaseName}${links ? ` - ${links}${more}` : ""}`
}

function mergeOverviewIngestLine(
  existingOverview: string,
  sourceBaseName: string,
  pagePaths: string[],
  date: Date,
): string {
  const base = existingOverview.trim() ? existingOverview.replace(/\s*$/, "") : "# Wiki Overview"
  const escapedSource = sourceBaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const existingLine = new RegExp(`^- \\d{4}-\\d{2}-\\d{2}: ${escapedSource}(?:\\s|$)`, "m")
  if (existingLine.test(base)) return `${base}\n`

  const line = buildOverviewIngestLine(sourceBaseName, pagePaths, date)
  const headerRegex = /(^|\n)## Recent Ingests\n/
  const match = headerRegex.exec(base)
  if (!match) {
    return `${base}\n\n## Recent Ingests\n${line}\n`
  }
  const insertAt = match.index + match[0].length
  return `${base.slice(0, insertAt)}${line}\n${base.slice(insertAt).replace(/^\n/, "")}\n`
}

function buildIngestLogEntry(sourceBaseName: string, pagePaths: string[], date: Date): string {
  const contentPages = pagePaths
    .filter((p) => p.startsWith("wiki/") && p.endsWith(".md") && !RESERVED_PATHS.has(p) && !isManagedLogPath(p))
  const shown = contentPages.slice(0, 12).map((p) => `- ${p}`)
  const omitted = contentPages.length > shown.length ? [`- ... ${contentPages.length - shown.length} more page(s)`] : []

  return [
    `## [${localDateString(date)}] ingest | ${sourceBaseName}`,
    "",
    `Pages written/updated: ${contentPages.length}`,
    ...shown,
    ...omitted,
  ].join("\n")
}

async function writeProgrammaticHousekeeping(
  projectPath: string,
  sourceBaseName: string,
  pagePaths: string[],
  date: Date,
): Promise<string[]> {
  const uniquePagePaths = Array.from(new Set(pagePaths))
  const entries = (await Promise.all(
    uniquePagePaths.map((relativePath) => indexEntryInputForPath(projectPath, relativePath)),
  )).filter((entry): entry is IndexEntryInput => entry !== null)

  const written: string[] = []
  const indexPath = `${projectPath}/wiki/index.md`
  const overviewPath = `${projectPath}/wiki/overview.md`
  const existingIndex = await tryReadFile(indexPath)
  const existingOverview = await tryReadFile(overviewPath)

  await writeFile(indexPath, mergeIndexEntries(existingIndex, entries))
  written.push("wiki/index.md")

  await writeFile(overviewPath, mergeOverviewIngestLine(existingOverview, sourceBaseName, uniquePagePaths, date))
  written.push("wiki/overview.md")

  const logPath = await appendDailyLog(projectPath, buildIngestLogEntry(sourceBaseName, uniquePagePaths, date), date)
  written.push(logPath)

  return written
}

function buildRetryPrompt(
  block: FileBlock,
  violations: SchemaViolation[],
  type: WikiType,
  attemptNum: number,
): string {
  const bullets = violations.map((v) => `- ${v.field}: ${v.message}`).join("\n")
  return [
    `[Retry attempt ${attemptNum}/${SCHEMA_RETRY_MAX}] Your previous FILE block had these schema violations:`,
    bullets,
    "",
    "Preserve ALL body content below the closing `---` delimiter exactly as-is — do NOT rewrite the prose.",
    "ONLY fix the frontmatter to satisfy the schema. Never wrap the frontmatter in ```yaml.",
    "",
    "--- Previous FILE block ---",
    `---FILE: ${block.path}---`,
    block.content,
    "---END FILE---",
    "",
    `--- Canonical sample for type "${type}" ---`,
    canonicalSampleFor(type),
    "",
    "Output the corrected FILE block now, including `---FILE:` and `---END FILE---` markers. Do not modify any body content.",
  ].join("\n")
}

async function runRetryRequest(
  llmConfig: LlmConfig,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let raw = ""
  let failed = false
  let failMsg = ""
  await streamChat(
    llmConfig,
    [{ role: "system", content: prompt }],
    {
      onToken: (t) => {
        raw += t
      },
      onDone: () => {},
      onError: (err) => {
        failed = true
        failMsg = err.message
      },
    },
    signal,
    { maxTokens: INGEST_MAX_TOKENS.retry },
  )
  if (failed) throw new Error(failMsg)
  return raw
}

async function repairBlock(
  llmConfig: LlmConfig,
  projectPath: string,
  block: FileBlock,
  signal: AbortSignal | undefined,
  onAttempt: (n: number, max: number) => void,
): Promise<{ content?: string; error?: string }> {
  let currentContent = block.content
  const nowTs = nowLocalTimestamp()

  for (let attempt = 0; attempt <= SCHEMA_RETRY_MAX; attempt++) {
    if (signal?.aborted) return { error: "Cancelled" }

    const parsed = parseFrontmatter(currentContent)
    const priorCode = parsed.fm.code
    const coerced = coerceWikiPageFrontmatter(parsed.fm, block.path, parsed.body, { now: nowTs })
    let fm = coerced as Partial<WikiFrontmatter>
    const body = parsed.body

    // Stock code: DB lookup, then preserve existing code from page
    if (fm.type === "股票" && typeof fm.title === "string" && fm.title.trim()) {
      try {
        const code = await lookupStockCode(projectPath, fm.title.trim())
        if (code) {
          fm.code = code
        } else if (priorCode && typeof priorCode === "string") {
          fm.code = priorCode
        } else {
          delete fm.code
        }
      } catch (err) {
        debugLog("warn", "ingest-stockcode", `Lookup failed for "${fm.title}": ${String(err)}`)
        if (priorCode && typeof priorCode === "string") {
          fm.code = priorCode
        }
      }
    }

    const violations = validate(fm)
    const fatal = violations.filter((v) => v.fatal)

    // 股票 + DB miss → LLM retry can't help
    const dbCodeMiss = fm.type === "股票" && fatal.some((v) => v.field === "code")
    if (dbCodeMiss) {
      return {
        error: `DB 中查不到股票 "${fm.title ?? "?"}" 的代码，请在 Settings 刷新股票代码库或检查股票名`,
      }
    }

    if (fatal.length === 0) {
      return { content: serializeFrontmatter(fm as WikiFrontmatter, body) }
    }

    if (attempt === SCHEMA_RETRY_MAX) {
      return {
        error: `Schema 校验 ${SCHEMA_RETRY_MAX} 次重试失败: ${fatal
          .map((v) => `[${v.field}] ${v.message}`)
          .join("; ")}`,
      }
    }

    const retryNum = attempt + 1
    onAttempt(retryNum, SCHEMA_RETRY_MAX)
    debugLog("warn", "ingest-validate", `Retry ${retryNum}/${SCHEMA_RETRY_MAX} for ${block.path}`, {
      violations: fatal,
    })

    const type = (fm.type as WikiType) ?? inferTypeFromPath(block.path)
    const prompt = buildRetryPrompt({ path: block.path, content: currentContent }, fatal, type, retryNum)
    try {
      const raw = await runRetryRequest(llmConfig, prompt, signal)
      const parsedBlocks = parseFileBlocks(raw)
      currentContent =
        parsedBlocks.find((b) => b.path === block.path)?.content ??
        parsedBlocks[0]?.content ??
        raw
    } catch (err) {
      return { error: `重试请求失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { error: "max retries exceeded" }
}

async function repairAndWriteBlocks(
  llmConfig: LlmConfig,
  projectPath: string,
  rawText: string,
  expectedPath: string | undefined,
  signal: AbortSignal | undefined,
  activityId: string | null,
  planItemIdFor: (path: string) => string | null,
): Promise<{ written: string[]; errors: Map<string, string> }> {
  let blocks = parseFileBlocks(rawText)
  const errors = new Map<string, string>()

  if (expectedPath) {
    const exact = blocks.filter((b) => b.path === expectedPath)
    if (exact.length > 0) {
      blocks = exact
    } else if (blocks.length === 1) {
      debugLog("warn", "ingest", `Single FILE block had wrong path, accepting as ${expectedPath}`, {
        emittedPath: blocks[0].path,
        expectedPath,
      })
      blocks = [{ path: expectedPath, content: blocks[0].content }]
    } else if (blocks.length === 0) {
      // Weak LLMs (MiniMax/Kimi) sometimes skip FILE markers entirely.
      // If the raw output looks like wiki frontmatter+body, treat the
      // whole response as the intended content for expectedPath.
      const implicit = tryExtractImplicitBlock(rawText, expectedPath)
      if (implicit) {
        debugLog("warn", "ingest", `No FILE marker found, salvaging raw response as ${expectedPath}`, {
          responseLength: rawText.length,
          preview: rawText.slice(0, 200),
        })
        blocks = [implicit]
      }
    } else {
      blocks = []
    }
  }

  const activity = useActivityStore.getState()
  const finalBlocks: FileBlock[] = []

  for (const block of blocks) {
    if (!block.path) continue
    if (isManagedLogPath(block.path)) {
      errors.set(block.path, "Managed log paths are written by wiki-housekeeping, not LLM file blocks.")
      continue
    }
    const isContentPage =
      block.path.startsWith("wiki/") && !RESERVED_PATHS.has(block.path)
    if (!isContentPage) {
      finalBlocks.push(block)
      continue
    }
    const planItemId = planItemIdFor(block.path)
    const result = await repairBlock(
      llmConfig,
      projectPath,
      block,
      signal,
      (n, max) => {
        if (activityId && planItemId) {
          activity.updatePlanItem(activityId, planItemId, { note: `重试中 ${n}/${max}` })
        }
      },
    )
    if (activityId && planItemId) {
      activity.updatePlanItem(activityId, planItemId, { note: undefined })
    }
    if (result.error) {
      errors.set(block.path, result.error)
      continue
    }
    finalBlocks.push({ path: block.path, content: result.content! })
  }

  const written: string[] = []
  for (const { path: relativePath, content } of finalBlocks) {
    if (!relativePath) continue
    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (isManagedLogPath(relativePath)) {
        errors.set(relativePath, "Managed log paths are written by wiki-housekeeping, not LLM file blocks.")
        continue
      }
      await writeFile(fullPath, content)
      written.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
      errors.set(relativePath, err instanceof Error ? err.message : String(err))
    }
  }

  return { written, errors }
}

/**
 * Strip wrapping markup from a path string emitted by a weaker LLM.
 * Handles: **bold**, `backticks`, <angle>, leading/trailing punctuation.
 */
function cleanBlockPath(raw: string): string {
  let p = raw.trim()
  // Strip paired wrappers: **path**, `path`, <path>, "path", 'path'
  const pairs: Array<[string, string]> = [["**", "**"], ["`", "`"], ["<", ">"], ['"', '"'], ["'", "'"]]
  let changed = true
  while (changed) {
    changed = false
    for (const [l, r] of pairs) {
      if (p.startsWith(l) && p.endsWith(r) && p.length > l.length + r.length) {
        p = p.slice(l.length, p.length - r.length).trim()
        changed = true
      }
    }
  }
  return p
}

/**
 * Lenient FILE block parser. Tolerates:
 * - Missing `---END FILE---` closers (content runs to next start marker or EOF)
 * - Variable dash counts: `--FILE: ...--`, `----FILE: ...----`
 * - Path wrappers: `**path**`, `` `path` ``, `<path>`
 * - Trailing `END FILE` line without matching dash count
 */
export function parseFileBlocks(text: string): FileBlock[] {
  const startRegex = /-{2,}\s*FILE:\s*(.+?)\s*-{2,}\r?\n/g
  const starts: Array<{ path: string; markerStart: number; contentStart: number }> = []
  let m: RegExpExecArray | null
  while ((m = startRegex.exec(text)) !== null) {
    const path = cleanBlockPath(m[1])
    if (path) starts.push({ path, markerStart: m.index, contentStart: m.index + m[0].length })
  }

  const blocks: FileBlock[] = []
  const endRegex = /-{2,}\s*END\s+FILE\s*-{2,}/i
  for (let i = 0; i < starts.length; i++) {
    const { path, contentStart } = starts[i]
    const sliceEnd = i + 1 < starts.length ? starts[i + 1].markerStart : text.length
    const segment = text.slice(contentStart, sliceEnd)
    const endMatch = endRegex.exec(segment)
    const content = endMatch ? segment.slice(0, endMatch.index).replace(/\r?\n$/, "") : segment.replace(/\r?\n$/, "")
    blocks.push({ path, content })
  }
  return blocks
}

/**
 * Fallback for weak LLMs that emit raw frontmatter+body without FILE markers.
 * Strips outer markdown code fences and verifies the result looks like a
 * wiki page (starts with `---\n` frontmatter). Returns null if it doesn't
 * look like wiki content.
 */
export function tryExtractImplicitBlock(text: string, expectedPath: string): FileBlock | null {
  let stripped = text.trim()
  // Strip outer markdown code fence: ```lang\n...\n```
  const fenceMatch = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/.exec(stripped)
  if (fenceMatch) stripped = fenceMatch[1].trim()
  // Drop a single leading prose line if the model prefixed something like
  // "Here is the updated content:" before the frontmatter.
  if (!stripped.startsWith("---")) {
    const fmStart = stripped.indexOf("\n---\n")
    if (fmStart >= 0 && fmStart < 300) {
      stripped = stripped.slice(fmStart + 1).trim()
    }
  }
  if (!stripped.startsWith("---")) return null
  // Must have a closing frontmatter delimiter on its own line.
  const closing = stripped.indexOf("\n---", 3)
  if (closing < 0) return null
  return { path: expectedPath, content: stripped }
}

/**
 * If `expectedPath` is provided, only the FILE block matching it is written.
 * If no exact-path block exists but exactly one FILE block was emitted, that
 * block is treated as the intended content and written to expectedPath.
 * Otherwise, all FILE blocks are written.
 */
async function writeFileBlocks(
  projectPath: string,
  text: string,
  expectedPath?: string,
): Promise<string[]> {
  const writtenPaths: string[] = []
  let blocks = parseFileBlocks(text)

  if (expectedPath) {
    const exact = blocks.filter((b) => b.path === expectedPath)
    if (exact.length > 0) {
      blocks = exact
    } else if (blocks.length === 1) {
      // LLM emitted one block with a different/missing path — accept as intended content
      debugLog("warn", "ingest", `Single FILE block had wrong path, accepting as ${expectedPath}`, {
        emittedPath: blocks[0].path,
        expectedPath,
      })
      blocks = [{ path: expectedPath, content: blocks[0].content }]
    } else {
      blocks = []
    }
  }

  for (const { path: relativePath, content } of blocks) {
    if (!relativePath) continue
    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (isManagedLogPath(relativePath)) {
        debugLog("warn", "ingest", `Skipping managed log path emitted by LLM: ${relativePath}`)
        continue
      }
      await writeFile(fullPath, content)
      writtenPaths.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  return writtenPaths
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

async function readProjectSchema(projectPath: string): Promise<string> {
  const rootSchema = await tryReadFile(`${projectPath}/schema.md`)
  if (rootSchema.trim()) return rootSchema
  return tryReadFile(`${projectPath}/wiki/schema.md`)
}

async function readProjectPurpose(projectPath: string): Promise<string> {
  const rootPurpose = await tryReadFile(`${projectPath}/purpose.md`)
  if (rootPurpose.trim()) return rootPurpose
  return tryReadFile(`${projectPath}/wiki/purpose.md`)
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sp),
    readProjectSchema(pp),
    readProjectPurpose(pp),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const fileName = getFileName(sp)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    LANGUAGE_RULE,
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  try {
    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        onToken: (token) => {
          accumulated += token
          getStore().appendStreamToken(token)
        },
        onDone: () => {
          getStore().finalizeStream(accumulated)
        },
        onError: (err) => {
          getStore().finalizeStream(`Error during ingest: ${err.message}`)
        },
      },
      signal,
    )
  } finally {
    store.setStreaming(false)
  }
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()

  const [schema, index] = await Promise.all([
    readProjectSchema(pp),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "Do not output wiki/log.md or wiki/logs/**. Logs are managed by the app housekeeping layer.",
    "Output the complete file content for every wiki page you do emit.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  let accumulated = ""

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    LANGUAGE_RULE,
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  try {
    await streamChat(
      llmConfig,
      [{ role: "system", content: systemPrompt }, ...conversationHistory],
      {
        onToken: (token) => {
          accumulated += token
        },
        onDone: () => {},
        onError: (err) => {
          throw err
        },
      },
      signal,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    store.addMessage("system", `Wiki write failed: ${message}`)
    throw err
  }

  const writtenPaths: string[] = []
  const blocks = parseFileBlocks(accumulated)

  for (const block of blocks) {
    const relativePath = block.path
    const content = block.content

    if (!relativePath) continue

    const fullPath = `${pp}/${relativePath}`

    try {
      if (isManagedLogPath(relativePath)) {
        debugLog("warn", "ingest", `Skipping managed log path emitted by LLM: ${relativePath}`)
        continue
      }
      await writeFile(fullPath, content)
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  return writtenPaths
}
