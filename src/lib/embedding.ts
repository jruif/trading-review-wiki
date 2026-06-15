import { readFile, listDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { mapWithConcurrency } from "@/lib/concurrency"

// ── Embedding API ─────────────────────────────────────────────────────────

export interface VectorStoreStats {
  db_path: string
  table_exists: boolean
  row_count: number
  db_bytes: number
  data_bytes: number
  versions_bytes: number
  transactions_bytes: number
  error?: string | null
}

async function fetchEmbedding(
  text: string,
  embeddingConfig: EmbeddingConfig,
): Promise<number[] | null> {
  if (!embeddingConfig.endpoint) return null

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (embeddingConfig.apiKey) {
    headers["Authorization"] = `Bearer ${embeddingConfig.apiKey}`
  }

  try {
    const resp = await fetch(embeddingConfig.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: embeddingConfig.model,
        input: text.slice(0, 2000),
      }),
    })
    if (!resp.ok) {
      console.warn(`[Embedding] API error: ${resp.status} ${resp.statusText}`)
      return null
    }
    const data = await resp.json()
    return data?.data?.[0]?.embedding ?? null
  } catch (err) {
    console.warn("[Embedding] fetchEmbedding failed:", err)
    return null
  }
}

// ── LanceDB operations via Tauri commands ─────────────────────────────────

async function vectorUpsert(projectPath: string, pageId: string, embedding: number[]): Promise<void> {
  await invoke("vector_upsert", {
    projectPath: normalizePath(projectPath),
    pageId,
    embedding: embedding.map((v) => Math.fround(v)), // ensure f32
  })
}

async function vectorSearchLance(projectPath: string, queryEmbedding: number[], topK: number): Promise<Array<{ page_id: string; score: number }>> {
  return await invoke("vector_search", {
    projectPath: normalizePath(projectPath),
    queryEmbedding: queryEmbedding.map((v) => Math.fround(v)),
    topK,
  })
}

async function vectorDelete(projectPath: string, pageId: string): Promise<void> {
  await invoke("vector_delete", {
    projectPath: normalizePath(projectPath),
    pageId,
  })
}

async function vectorCount(projectPath: string): Promise<number> {
  return await invoke("vector_count", {
    projectPath: normalizePath(projectPath),
  })
}

async function vectorStats(projectPath: string): Promise<VectorStoreStats> {
  return await invoke("vector_stats", {
    projectPath: normalizePath(projectPath),
  })
}

async function vectorClear(projectPath: string): Promise<void> {
  await invoke("vector_clear", {
    projectPath: normalizePath(projectPath),
  })
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Embed a single page and store in LanceDB.
 * Called after ingest to keep embeddings up to date.
 */
export async function embedPage(
  projectPath: string,
  pageId: string,
  title: string,
  content: string,
  embeddingConfig: EmbeddingConfig,
): Promise<void> {
  if (!embeddingConfig.enabled || !embeddingConfig.model) return

  const t0 = performance.now()
  const text = `${title}\n${content.slice(0, 1500)}`
  const emb = await fetchEmbedding(text, embeddingConfig)
  if (emb) {
    await vectorUpsert(projectPath, pageId, emb)
    console.log(`[Embedding] Indexed "${pageId}" (${emb.length}d) in ${Math.round(performance.now() - t0)}ms`)
  } else {
    console.log(`[Embedding] Failed to embed "${pageId}"`)
  }
}

/**
 * Embed all wiki pages that are not yet indexed.
 * Called on first enable or when model changes.
 */
export async function embedAllPages(
  projectPath: string,
  embeddingConfig: EmbeddingConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (!embeddingConfig.enabled || !embeddingConfig.model) return 0

  const pp = normalizePath(projectPath)

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch (err) {
    console.warn("[Embedding] Failed to list wiki directory:", err)
    return 0
  }

  const mdFiles: { id: string; path: string }[] = []
  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      if (node.is_dir && node.children) {
        walk(node.children)
      } else if (!node.is_dir && node.name.endsWith(".md")) {
        const id = node.name.replace(/\.md$/, "")
        if (!["index", "log", "overview", "purpose", "schema"].includes(id)) {
          mdFiles.push({ id, path: node.path })
        }
      }
    }
  }
  walk(tree)

  let done = 0
  await mapWithConcurrency(mdFiles, 4, async (file) => {
    try {
      const content = await readFile(file.path)
      const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
      const title = titleMatch ? titleMatch[1].trim() : file.id

      const text = `${title}\n${content.slice(0, 1500)}`
      const emb = await fetchEmbedding(text, embeddingConfig)
      if (emb) {
        await vectorUpsert(pp, file.id, emb)
      }
    } catch (err) {
      console.warn(`[Embedding] Failed to embed page "${file.id}":`, err)
    } finally {
      done++
      if (onProgress) onProgress(done, mdFiles.length)
    }
  })

  return done
}

export async function getVectorStoreStats(projectPath: string): Promise<VectorStoreStats> {
  return vectorStats(projectPath)
}

export async function clearVectorStore(projectPath: string): Promise<void> {
  await vectorClear(projectPath)
}

export async function rebuildAllPageEmbeddings(
  projectPath: string,
  embeddingConfig: EmbeddingConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  await clearVectorStore(projectPath)
  return embedAllPages(projectPath, embeddingConfig, onProgress)
}

/**
 * Search wiki pages by semantic similarity via LanceDB.
 * Returns page IDs sorted by similarity score.
 */
export async function searchByEmbedding(
  projectPath: string,
  query: string,
  embeddingConfig: EmbeddingConfig,
  topK: number = 10,
): Promise<Array<{ id: string; score: number }>> {
  if (!embeddingConfig.enabled || !embeddingConfig.model) return []

  const queryEmb = await fetchEmbedding(query, embeddingConfig)
  if (!queryEmb) return []

  try {
    const t0 = performance.now()
    const results = await vectorSearchLance(projectPath, queryEmb, topK)
    console.log(`[Embedding] LanceDB search: ${results.length} results in ${Math.round(performance.now() - t0)}ms`)
    return results.map((r) => ({ id: r.page_id, score: r.score }))
  } catch (err) {
    console.warn(`[Embedding] LanceDB search failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

/**
 * Remove a page from the vector index.
 */
export async function removePageEmbedding(
  projectPath: string,
  pageId: string,
): Promise<void> {
  try {
    await vectorDelete(projectPath, pageId)
  } catch (err) {
    console.warn(`[Embedding] Failed to remove embedding for "${pageId}":`, err)
  }
}

/**
 * Get the number of indexed vectors.
 */
export async function getEmbeddingCount(
  projectPath: string,
): Promise<number> {
  try {
    return await vectorCount(projectPath)
  } catch (err) {
    console.warn("[Embedding] Failed to get embedding count:", err)
    return 0
  }
}
