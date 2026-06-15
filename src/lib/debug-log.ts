import { appendFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { redactSensitiveData } from "@/lib/secrets"

const LOG_FILE = ".llm-wiki/debug.log"

function safeStringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(redactSensitiveData(value), (_, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message }
      }
      return v
    }, 2)
  } catch {
    return String(value)
  }
}

export function debugLog(
  level: "info" | "warn" | "error",
  tag: string,
  message: string,
  data?: unknown,
): void {
  const ts = new Date().toISOString()
  const dataStr = data !== undefined ? `\n${safeStringify(data)}` : ""
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}${dataStr}\n`

  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log
  consoleFn(`[${tag}] ${message}`, data ?? "")

  const project = useWikiStore.getState().project
  if (!project) return
  const path = `${normalizePath(project.path)}/${LOG_FILE}`
  appendFile(path, line).catch(() => {
    // Avoid recursive logging if append itself fails
  })
}
