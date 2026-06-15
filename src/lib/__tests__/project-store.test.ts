import { describe, it, expect, vi, beforeEach } from "vitest"

const mockStore = {
  get: vi.fn(),
  set: vi.fn(),
}

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => mockStore),
}))

const storeSecret = vi.fn()
const loadSecret = vi.fn()
const deleteSecret = vi.fn()

vi.mock("@/lib/secrets", () => ({
  SECRET_KEYS: {
    llmApiKey: "llm_api_key",
    searchApiKey: "search_api_key",
    embeddingApiKey: "embedding_api_key",
    pgPassword: "pg_password",
  },
  storeSecret: (...args: unknown[]) => storeSecret(...args),
  loadSecret: (...args: unknown[]) => loadSecret(...args),
  deleteSecret: (...args: unknown[]) => deleteSecret(...args),
}))

describe("project-store secret migration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.get.mockReset()
    mockStore.set.mockReset()
    storeSecret.mockReset()
    loadSecret.mockReset()
    deleteSecret.mockReset()
  })

  it("migrates plaintext apiKey to keychain and strips it from store", async () => {
    mockStore.get.mockResolvedValue({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    })
    storeSecret.mockResolvedValue(undefined)
    mockStore.set.mockResolvedValue(undefined)
    loadSecret.mockResolvedValue("sk-test")

    const { loadLlmConfig } = await import("../project-store")
    const config = await loadLlmConfig()

    expect(storeSecret).toHaveBeenCalledWith("llm_api_key", "sk-test")
    expect(mockStore.set).toHaveBeenCalledWith("llmConfig", {
      provider: "openai",
      model: "gpt-4o",
    })
    expect(config).toEqual({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    })
  })

  it("keeps plaintext apiKey when keychain migration fails", async () => {
    const stored = {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-fallback",
    }
    mockStore.get.mockResolvedValue(stored)
    storeSecret.mockRejectedValue(new Error("keychain unavailable"))

    const { loadLlmConfig } = await import("../project-store")
    const config = await loadLlmConfig()

    expect(mockStore.set).not.toHaveBeenCalled()
    expect(config).toEqual(stored)
  })

  it("keeps plaintext apiKey when store update fails after keychain write", async () => {
    const stored = {
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-partial",
    }
    mockStore.get.mockResolvedValue(stored)
    storeSecret.mockResolvedValue(undefined)
    mockStore.set.mockRejectedValue(new Error("disk full"))

    const { loadLlmConfig } = await import("../project-store")
    const config = await loadLlmConfig()

    expect(storeSecret).toHaveBeenCalledWith("llm_api_key", "sk-partial")
    expect(config).toEqual(stored)
  })

  it("loads apiKey from keychain when store has no plaintext field", async () => {
    mockStore.get.mockResolvedValue({
      provider: "openai",
      model: "gpt-4o",
    })
    loadSecret.mockResolvedValue("sk-from-keychain")

    const { loadLlmConfig } = await import("../project-store")
    const config = await loadLlmConfig()

    expect(config?.apiKey).toBe("sk-from-keychain")
  })
})
