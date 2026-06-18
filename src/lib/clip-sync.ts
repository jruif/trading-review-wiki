import { getClipServerToken } from "@/commands/fs"
import { getRecentProjects } from "@/lib/project-store"
import type { WikiProject } from "@/types/wiki"

const CLIP_API = "http://127.0.0.1:19827"
const MAX_RETRIES = 20
const RETRY_DELAY_MS = 400

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForClipServer(): Promise<boolean> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(`${CLIP_API}/status`, { method: "GET" })
      const data = await res.json()
      if (data.ok) return true
    } catch {
      // server still starting
    }
    await sleep(RETRY_DELAY_MS)
  }
  return false
}

/** Push current + recent projects to the local clip server (with startup retry). */
export async function syncClipServerProjects(project: WikiProject): Promise<void> {
  const ready = await waitForClipServer()
  if (!ready) {
    console.warn("[ClipSync] Clip server not ready after retries")
    return
  }

  let token: string
  try {
    token = await getClipServerToken()
  } catch (err) {
    console.warn("[ClipSync] Failed to get clip server token:", err)
    return
  }

  const headers = {
    "Content-Type": "application/json",
    "X-Clip-Token": token,
  }

  try {
    const recents = await getRecentProjects()
    const projects = recents.map((p) => ({ name: p.name, path: p.path }))
    const projectsRes = await fetch(`${CLIP_API}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projects }),
    })
    if (!projectsRes.ok) {
      const body = await projectsRes.text().catch(() => "")
      console.warn("[ClipSync] POST /projects failed:", projectsRes.status, body)
    }

    const projectRes = await fetch(`${CLIP_API}/project`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: project.path }),
    })
    if (!projectRes.ok) {
      const body = await projectRes.text().catch(() => "")
      console.warn("[ClipSync] POST /project failed:", projectRes.status, body)
    }
  } catch (err) {
    console.warn("[ClipSync] Failed to sync clip server projects:", err)
  }
}
