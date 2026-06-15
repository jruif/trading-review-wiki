import { load } from "@tauri-apps/plugin-store"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig, SearchApiConfig, EmbeddingConfig, PgConfig } from "@/stores/wiki-store"
import type { AppTheme } from "@/types/theme"
import {
  SECRET_KEYS,
  storeSecret,
  loadSecret,
  deleteSecret,
} from "@/lib/secrets"

const STORE_NAME = "app-state.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_PROJECT_KEY = "lastProject"

async function getStore() {
  return load(STORE_NAME, { autoSave: true })
}

async function migratePlaintextField<T extends Record<string, unknown>>(
  stored: T,
  field: keyof T,
  secretKey: string,
  persistKey: string,
): Promise<{ rest: Omit<T, typeof field>; secret: string } | null> {
  const value = stored[field]
  if (typeof value !== "string" || !value) return null

  try {
    await storeSecret(secretKey, value)
    const { [field]: _removed, ...rest } = stored
    const store = await getStore()
    await store.set(persistKey, rest)
    return { rest: rest as Omit<T, typeof field>, secret: value }
  } catch (err) {
    console.warn(
      `[project-store] Failed to migrate ${String(field)} to keychain; keeping plaintext in store`,
      err,
    )
    return null
  }
}

export async function getRecentProjects(): Promise<WikiProject[]> {
  const store = await getStore()
  const projects = await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)
  return projects ?? []
}

export async function getLastProject(): Promise<WikiProject | null> {
  const store = await getStore()
  const project = await store.get<WikiProject>(LAST_PROJECT_KEY)
  return project ?? null
}

export async function saveLastProject(project: WikiProject): Promise<void> {
  const store = await getStore()
  await store.set(LAST_PROJECT_KEY, project)
  await addToRecentProjects(project)
}

export async function addToRecentProjects(
  project: WikiProject
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const filtered = existing.filter((p) => p.path !== project.path)
  const updated = [project, ...filtered].slice(0, 10)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LLM_CONFIG_KEY = "llmConfig"
type StoredLlmConfig = Omit<LlmConfig, "apiKey">

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await getStore()
  const { apiKey, ...rest } = config
  if (apiKey) {
    await storeSecret(SECRET_KEYS.llmApiKey, apiKey)
  } else {
    await deleteSecret(SECRET_KEYS.llmApiKey)
  }
  await store.set(LLM_CONFIG_KEY, rest)
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const store = await getStore()
  const stored = await store.get<StoredLlmConfig | LlmConfig>(LLM_CONFIG_KEY)
  if (!stored) return null

  const migrated = await migratePlaintextField(
    stored as LlmConfig,
    "apiKey",
    SECRET_KEYS.llmApiKey,
    LLM_CONFIG_KEY,
  )
  if (migrated) {
    return { ...(migrated.rest as StoredLlmConfig), apiKey: migrated.secret }
  }

  if ("apiKey" in stored && typeof stored.apiKey === "string" && stored.apiKey) {
    return stored as LlmConfig
  }

  const apiKey = (await loadSecret(SECRET_KEYS.llmApiKey)) ?? ""
  return { ...(stored as StoredLlmConfig), apiKey }
}

const SEARCH_API_KEY = "searchApiConfig"
type StoredSearchApiConfig = Omit<SearchApiConfig, "apiKey">

export async function saveSearchApiConfig(config: SearchApiConfig): Promise<void> {
  const store = await getStore()
  const { apiKey, ...rest } = config
  if (apiKey) {
    await storeSecret(SECRET_KEYS.searchApiKey, apiKey)
  } else {
    await deleteSecret(SECRET_KEYS.searchApiKey)
  }
  await store.set(SEARCH_API_KEY, rest)
}

export async function loadSearchApiConfig(): Promise<SearchApiConfig | null> {
  const store = await getStore()
  const stored = await store.get<StoredSearchApiConfig | SearchApiConfig>(SEARCH_API_KEY)
  if (!stored) return null

  const migrated = await migratePlaintextField(
    stored as SearchApiConfig,
    "apiKey",
    SECRET_KEYS.searchApiKey,
    SEARCH_API_KEY,
  )
  if (migrated) {
    return { ...(migrated.rest as StoredSearchApiConfig), apiKey: migrated.secret }
  }

  if ("apiKey" in stored && typeof stored.apiKey === "string" && stored.apiKey) {
    return stored as SearchApiConfig
  }

  const apiKey = (await loadSecret(SECRET_KEYS.searchApiKey)) ?? ""
  return { ...(stored as StoredSearchApiConfig), apiKey }
}

const EMBEDDING_KEY = "embeddingConfig"
type StoredEmbeddingConfig = Omit<EmbeddingConfig, "apiKey">

export async function saveEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
  const store = await getStore()
  const { apiKey, ...rest } = config
  if (apiKey) {
    await storeSecret(SECRET_KEYS.embeddingApiKey, apiKey)
  } else {
    await deleteSecret(SECRET_KEYS.embeddingApiKey)
  }
  await store.set(EMBEDDING_KEY, rest)
}

export async function loadEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  const store = await getStore()
  const stored = await store.get<StoredEmbeddingConfig | EmbeddingConfig>(EMBEDDING_KEY)
  if (!stored) return null

  const migrated = await migratePlaintextField(
    stored as EmbeddingConfig,
    "apiKey",
    SECRET_KEYS.embeddingApiKey,
    EMBEDDING_KEY,
  )
  if (migrated) {
    return { ...(migrated.rest as StoredEmbeddingConfig), apiKey: migrated.secret }
  }

  if ("apiKey" in stored && typeof stored.apiKey === "string" && stored.apiKey) {
    return stored as EmbeddingConfig
  }

  const apiKey = (await loadSecret(SECRET_KEYS.embeddingApiKey)) ?? ""
  return { ...(stored as StoredEmbeddingConfig), apiKey }
}

const PG_CONFIG_KEY = "pgConfig"
type StoredPgConfig = Omit<PgConfig, "password">

export async function savePgConfig(config: PgConfig): Promise<void> {
  const store = await getStore()
  const { password, ...rest } = config
  if (password) {
    await storeSecret(SECRET_KEYS.pgPassword, password)
  } else {
    await deleteSecret(SECRET_KEYS.pgPassword)
  }
  await store.set(PG_CONFIG_KEY, rest)
}

export async function loadPgConfig(): Promise<PgConfig | null> {
  const store = await getStore()
  const stored = await store.get<StoredPgConfig | PgConfig>(PG_CONFIG_KEY)
  if (!stored) return null

  const migrated = await migratePlaintextField(
    stored as PgConfig,
    "password",
    SECRET_KEYS.pgPassword,
    PG_CONFIG_KEY,
  )
  if (migrated) {
    return { ...(migrated.rest as StoredPgConfig), password: migrated.secret }
  }

  if ("password" in stored && typeof stored.password === "string" && stored.password) {
    return stored as PgConfig
  }

  const password = (await loadSecret(SECRET_KEYS.pgPassword)) ?? ""
  return { ...(stored as StoredPgConfig), password }
}

export async function removeFromRecentProjects(
  path: string
): Promise<void> {
  const store = await getStore()
  const existing = (await store.get<WikiProject[]>(RECENT_PROJECTS_KEY)) ?? []
  const updated = existing.filter((p) => p.path !== path)
  await store.set(RECENT_PROJECTS_KEY, updated)
}

const LANGUAGE_KEY = "language"

export async function saveLanguage(lang: string): Promise<void> {
  const store = await getStore()
  await store.set(LANGUAGE_KEY, lang)
}

export async function loadLanguage(): Promise<string | null> {
  const store = await getStore()
  return (await store.get<string>(LANGUAGE_KEY)) ?? null
}

const APP_THEME_KEY = "appTheme"

export async function saveAppTheme(theme: AppTheme): Promise<void> {
  const store = await getStore()
  await store.set(APP_THEME_KEY, theme)
}

export async function loadAppTheme(): Promise<AppTheme | null> {
  const store = await getStore()
  return (await store.get<AppTheme>(APP_THEME_KEY)) ?? null
}
