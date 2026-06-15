import { invoke } from "@tauri-apps/api/core"

export const SECRET_KEYS = {
  llmApiKey: "llm_api_key",
  searchApiKey: "search_api_key",
  embeddingApiKey: "embedding_api_key",
  pgPassword: "pg_password",
} as const

export async function storeSecret(key: string, value: string): Promise<void> {
  await invoke("store_secret", { key, value })
}

export async function loadSecret(key: string): Promise<string | null> {
  return invoke<string | null>("load_secret", { key })
}

export async function deleteSecret(key: string): Promise<void> {
  await invoke("delete_secret", { key })
}

const SENSITIVE_KEY_PATTERN = /api[_-]?key|password|secret|token|authorization/i

export function redactSensitiveData(value: unknown): unknown {
  if (value == null) return value
  if (Array.isArray(value)) return value.map(redactSensitiveData)
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof child === "string") {
        out[key] = child ? "[REDACTED]" : child
      } else {
        out[key] = redactSensitiveData(child)
      }
    }
    return out
  }
  return value
}
