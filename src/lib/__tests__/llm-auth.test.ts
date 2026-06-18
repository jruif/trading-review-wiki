import { describe, expect, it } from "vitest"
import { formatLlmHttpError, isLlmProviderReady } from "../llm-auth"

describe("formatLlmHttpError", () => {
  it("expands DeepSeek 401 governor errors with setup hints", () => {
    const msg = formatLlmHttpError("HTTP 401: — Authentication Fails (governor)", {
      provider: "openai",
      customEndpoint: "https://api.deepseek.com/v1",
    })
    expect(msg).toContain("401")
    expect(msg).toContain("deepseek-chat")
  })
})

describe("isLlmProviderReady", () => {
  it("requires api key for openai", () => {
    expect(isLlmProviderReady({ provider: "openai", apiKey: "", model: "x", ollamaUrl: "", customEndpoint: "", maxContextSize: 1 })).toBe(false)
    expect(isLlmProviderReady({ provider: "openai", apiKey: "sk-test", model: "x", ollamaUrl: "", customEndpoint: "", maxContextSize: 1 })).toBe(true)
  })

  it("allows ollama without api key", () => {
    expect(isLlmProviderReady({ provider: "ollama", apiKey: "", model: "x", ollamaUrl: "http://127.0.0.1:11434", customEndpoint: "", maxContextSize: 1 })).toBe(true)
  })
})
