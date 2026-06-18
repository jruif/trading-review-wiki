import type { LlmConfig } from "@/stores/wiki-store"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[]) => unknown
  parseStream: (line: string) => string | null
  /**
   * Whether the non-streaming response can be parsed by extractAssistantTextFromResponse
   * (OpenAI-compatible {choices[0].message.content}). Used to gate native-HTTP fallback
   * when the WebView's fetch fails (typically CORS) — Anthropic/Google have different
   * response shapes so we don't fallback for them.
   */
  isOpenAiCompatible: boolean
  /**
   * Optional parser for non-streaming responses. When present, the native-HTTP fallback
   * uses this instead of the OpenAI-compatible extractor. Lets non-OpenAI-compatible
   * providers (e.g. Codex Responses API) participate in the fallback path.
   */
  parseNonStreamingResponse?: (responseText: string) => string
}

export function extractCodexTextFromResponse(responseText: string): string {
  const trimmed = responseText.trim()
  if (trimmed.startsWith("<")) {
    const preview = trimmed.slice(0, 80).replace(/\s+/g, " ")
    throw new Error(
      `服务器返回了 HTML 而不是 JSON（通常是 endpoint 路径错误）。响应开头：${preview}`,
    )
  }
  let parsed: any
  try {
    parsed = JSON.parse(responseText)
  } catch {
    const preview = trimmed.slice(0, 120)
    throw new Error(`无法解析服务器响应（非 JSON）：${preview}`)
  }
  if (parsed?.error?.message) {
    throw new Error(`Codex API error: ${parsed.error.message}`)
  }
  // 1) Responses API convenience field
  if (typeof parsed?.output_text === "string" && parsed.output_text.length > 0) {
    return parsed.output_text
  }
  // 2) Responses API canonical shape: output[].content[].text where type === "output_text"
  const texts: string[] = []
  for (const item of parsed?.output ?? []) {
    if (item?.type !== "message") continue
    for (const c of item?.content ?? []) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        texts.push(c.text)
      }
    }
  }
  if (texts.length > 0) return texts.join("")
  // 3) Some gateways normalize Responses API into chat/completions shape
  const chatContent = parsed?.choices?.[0]?.message?.content
  if (typeof chatContent === "string" && chatContent.length > 0) {
    return chatContent
  }
  const preview = trimmed.slice(0, 500).replace(/\s+/g, " ")
  const err = new Error(
    `No assistant content found in Codex response. 响应预览：${preview}${trimmed.length > 500 ? " …" : ""}`,
  )
  ;(err as any).rawResponse = responseText
  ;(err as any).parsed = parsed
  throw err
}

const JSON_CONTENT_TYPE = "application/json"
const CHAT_COMPLETIONS_PATH = "/chat/completions"

function normalizeOpenAiCompatibleUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "")
  return trimmed.endsWith(CHAT_COMPLETIONS_PATH)
    ? trimmed
    : `${trimmed}${CHAT_COMPLETIONS_PATH}`
}

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices: Array<{ delta: { content?: string } }>
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

function parseAnthropicLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type: string
      delta?: { type: string; text?: string }
    }
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta"
    ) {
      return parsed.delta.text ?? null
    }
    return null
  } catch {
    return null
  }
}

function parseCodexLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as { type?: string; delta?: string }
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      return parsed.delta
    }
    return null
  } catch {
    return null
  }
}

function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> }
      }>
    }
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? null
  } catch {
    return null
  }
}

function buildOpenAiBody(messages: ChatMessage[]): unknown {
  return { messages, stream: true }
}

function buildAnthropicBody(messages: ChatMessage[], maxTokens = 16384): unknown {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")
  const system = systemMessages.map((m) => m.content).join("\n") || undefined

  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: maxTokens,
  }
}

function buildGoogleBody(messages: ChatMessage[]): unknown {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((m) => ({ text: m.content })),
        }
      : undefined

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
  }
}

export function getProviderConfig(config: LlmConfig): ProviderConfig {
  const { provider, apiKey, model, ollamaUrl, customEndpoint, reasoningEffort } = config

  switch (provider) {
    case "openai": {
      const baseUrl = customEndpoint
        ? customEndpoint.replace(/\/$/, "")
        : "https://api.openai.com/v1"
      return {
        url: `${baseUrl}/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
        isOpenAiCompatible: true,
      }
    }

    case "anthropic": {
      const isCustom = Boolean(customEndpoint)
      const baseUrl = isCustom
        ? customEndpoint.replace(/\/$/, "")
        : "https://api.anthropic.com"
      const headers: Record<string, string> = {
        "Content-Type": JSON_CONTENT_TYPE,
        "anthropic-version": "2023-06-01",
      }
      if (isCustom) {
        headers.Authorization = `Bearer ${apiKey}`
      } else {
        headers["x-api-key"] = apiKey
        headers["anthropic-dangerous-direct-browser-access"] = "true"
      }
      return {
        url: `${baseUrl}/v1/messages`,
        headers,
        buildBody: (messages) => ({
          ...buildAnthropicBody(messages),
          model,
        }),
        parseStream: parseAnthropicLine,
        isOpenAiCompatible: false,
      }
    }

    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-goog-api-key": apiKey,
        },
        buildBody: buildGoogleBody,
        parseStream: parseGoogleLine,
        isOpenAiCompatible: false,
      }

    case "ollama":
      return {
        url: `${ollamaUrl}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
        isOpenAiCompatible: true,
      }

    case "minimax": {
      const baseUrl = customEndpoint
        ? customEndpoint.replace(/\/$/, "")
        : "https://api.minimax.io/v1"
      return {
        url: `${baseUrl}/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
          temperature: 1.0,
        }),
        parseStream: parseOpenAiLine,
        isOpenAiCompatible: true,
      }
    }

    case "kimi": {
      const baseUrl = customEndpoint
        ? customEndpoint.replace(/\/$/, "")
        : "https://api.kimi.com/coding/v1"
      return {
        url: `${baseUrl}/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
        isOpenAiCompatible: true,
      }
    }

    case "codex": {
      const baseUrl = customEndpoint
        ? customEndpoint.replace(/\/$/, "")
        : "https://api.openai.com"
      const effort = reasoningEffort ?? "medium"
      return {
        url: `${baseUrl}/v1/responses`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
          "openai-beta": "responses=experimental",
        },
        buildBody: (messages) => {
          const systemText =
            messages
              .filter((m) => m.role === "system")
              .map((m) => m.content)
              .join("\n") || undefined
          const input = messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              type: "message",
              role: m.role,
              content: [
                {
                  type: m.role === "assistant" ? "output_text" : "input_text",
                  text: m.content,
                },
              ],
            }))
          return {
            model,
            ...(systemText !== undefined ? { instructions: systemText } : {}),
            input,
            reasoning: { effort, summary: "auto" },
            store: false,
            stream: true,
          }
        },
        parseStream: parseCodexLine,
        isOpenAiCompatible: false,
        parseNonStreamingResponse: extractCodexTextFromResponse,
      }
    }

    case "custom":
      return {
        url: normalizeOpenAiCompatibleUrl(customEndpoint),
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
        isOpenAiCompatible: true,
      }

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}
