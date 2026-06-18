import type { LlmConfig } from "@/stores/wiki-store"

/** Turn raw HTTP / provider errors into actionable Chinese hints */
export function formatLlmHttpError(message: string, config?: Pick<LlmConfig, "provider" | "customEndpoint">): string {
  const is401 =
    /HTTP 401/i.test(message) ||
    /Authentication Fails/i.test(message) ||
    /invalid api key/i.test(message) ||
    /incorrect api key/i.test(message)

  if (!is401) return message

  const endpoint = config?.customEndpoint?.trim()
  const deepseekHint =
    endpoint?.includes("deepseek.com") || /governor/i.test(message)
      ? "\n\nDeepSeek 配置检查：\n• Provider 选 OpenAI 或 Custom\n• Endpoint: https://api.deepseek.com/v1\n• Model: deepseek-chat\n• API Key: platform.deepseek.com 创建的 sk- 密钥\n• Settings 里点「测试连接」通过后再提取"
      : ""

  return `LLM 认证失败（HTTP 401）。请在 Settings 重新填写并保存 API Key，确认 Endpoint 与 Key 属于同一服务商。${deepseekHint}\n\n原始错误：${message}`
}

export function isLlmProviderReady(config: LlmConfig): boolean {
  if (config.provider === "ollama") return Boolean(config.ollamaUrl.trim())
  return Boolean(config.apiKey.trim())
}
