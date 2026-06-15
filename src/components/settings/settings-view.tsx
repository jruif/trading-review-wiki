import { useWikiStore, type PgConfig } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { syncStockCodes, getStockCodesStatus, type SyncResult } from "@/commands/stock-codes"
import { savePgConfig } from "@/lib/project-store"
import { useTranslation } from "react-i18next"
import i18n from "@/i18n"
import { saveLanguage, saveAppTheme } from "@/lib/project-store"
import { THEME_PRESETS } from "@/types/theme"
import type { AppTheme } from "@/types/theme"
import { WikiDoctorDialog } from "./wiki-doctor-dialog"
import { MigrateSchemaDialog } from "./migrate-schema-dialog"
import { NormalizeDirsDialog } from "./normalize-dirs-dialog"
import { CleanupGarbageDialog } from "./cleanup-garbage-dialog"
import { BodyResidueDialog } from "./body-residue-dialog"
import {
  Stethoscope,
  Eye,
  EyeOff,
  Activity,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  ArrowUpCircle,
  FolderTree,
  FileScan,
  Trash2,
} from "lucide-react"
import { previewProviderUrl, testLlmConnection, type LlmTestResult } from "@/lib/llm-test"
import { getClipPairingCode } from "@/commands/fs"

const PROVIDERS = [
  { value: "openai" as const, label: "OpenAI", models: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"] },
  { value: "anthropic" as const, label: "Anthropic", models: ["claude-sonnet-4-5-20250514", "claude-opus-4-5-20250514", "claude-haiku-4-5-20251001"] },
  { value: "google" as const, label: "Google", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { value: "minimax" as const, label: "MiniMax", models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"] },
  { value: "kimi" as const, label: "Kimi Code", models: ["kimi-for-coding"] },
  { value: "codex" as const, label: "Codex (Responses API)", models: ["gpt-5.4", "gpt-5.3-codex"] },
  { value: "ollama" as const, label: "Ollama (Local)", models: [] },
  { value: "custom" as const, label: "Custom", models: [] },
]

const REASONING_EFFORTS = [
  { value: "minimal" as const, label: "Minimal" },
  { value: "low" as const, label: "Low" },
  { value: "medium" as const, label: "Medium" },
  { value: "high" as const, label: "High" },
]

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const HISTORY_OPTIONS = [2, 4, 6, 8, 10, 20]

export function SettingsView() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setLlmConfig = useWikiStore((s) => s.setLlmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const setMaxHistoryMessages = useChatStore((s) => s.setMaxHistoryMessages)

  const [provider, setProvider] = useState(llmConfig.provider)
  const [apiKey, setApiKey] = useState(llmConfig.apiKey)
  const [model, setModel] = useState(llmConfig.model)
  const [ollamaUrl, setOllamaUrl] = useState(llmConfig.ollamaUrl)
  const [customEndpoint, setCustomEndpoint] = useState(llmConfig.customEndpoint)
  const [maxContextSize, setMaxContextSize] = useState(llmConfig.maxContextSize ?? 204800)
  const [reasoningEffort, setReasoningEffort] = useState<NonNullable<typeof llmConfig.reasoningEffort>>(
    llmConfig.reasoningEffort ?? "medium",
  )
  const [searchProvider, setSearchProvider] = useState(searchApiConfig.provider)
  const [searchApiKey, setSearchApiKey] = useState(searchApiConfig.apiKey)
  const [embeddingEnabled, setEmbeddingEnabled] = useState(embeddingConfig.enabled)
  const [embeddingEndpoint, setEmbeddingEndpoint] = useState(embeddingConfig.endpoint)
  const [embeddingApiKey, setEmbeddingApiKey] = useState(embeddingConfig.apiKey)
  const [embeddingModel, setEmbeddingModel] = useState(embeddingConfig.model)
  const [saved, setSaved] = useState(false)
  const [currentLang, setCurrentLang] = useState(i18n.language)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [migrateOpen, setMigrateOpen] = useState(false)
  const [normalizeOpen, setNormalizeOpen] = useState(false)
  const [residueOpen, setResidueOpen] = useState(false)
  const [cleanupGarbageOpen, setCleanupGarbageOpen] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const [clipPairingCode, setClipPairingCode] = useState("")
  const [clipPairingCopied, setClipPairingCopied] = useState(false)
  const appTheme = useWikiStore((s) => s.appTheme)
  const setAppTheme = useWikiStore((s) => s.setAppTheme)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    getClipPairingCode()
      .then((code) => setClipPairingCode(code))
      .catch((err) => console.warn("[Settings] Failed to load clip pairing code:", err))
  }, [])

  useEffect(() => {
    setProvider(llmConfig.provider)
    setApiKey(llmConfig.apiKey)
    setModel(llmConfig.model)
    setOllamaUrl(llmConfig.ollamaUrl)
    setCustomEndpoint(llmConfig.customEndpoint)
    setReasoningEffort(llmConfig.reasoningEffort ?? "medium")
  }, [llmConfig])

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    setSearchProvider(searchApiConfig.provider)
    setSearchApiKey(searchApiConfig.apiKey)
  }, [searchApiConfig])

  const currentProvider = PROVIDERS.find((p) => p.value === provider)

  const previewUrl = useMemo(
    () =>
      previewProviderUrl({
        provider,
        apiKey,
        model,
        ollamaUrl,
        customEndpoint,
        maxContextSize,
        reasoningEffort,
      }),
    [provider, apiKey, model, ollamaUrl, customEndpoint, maxContextSize, reasoningEffort],
  )

  // Reset test result whenever the form changes — stale results are misleading
  useEffect(() => {
    setTestResult(null)
  }, [provider, apiKey, model, ollamaUrl, customEndpoint, reasoningEffort])

  async function handleTestConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testLlmConnection({
        provider,
        apiKey,
        model,
        ollamaUrl,
        customEndpoint,
        maxContextSize,
        reasoningEffort,
      })
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  async function handleCopyClipPairingCode() {
    if (!clipPairingCode) return
    try {
      await navigator.clipboard.writeText(clipPairingCode)
      setClipPairingCopied(true)
      setTimeout(() => setClipPairingCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  async function handleCopyUrl() {
    if (!previewUrl) return
    try {
      await navigator.clipboard.writeText(previewUrl)
      setUrlCopied(true)
      setTimeout(() => setUrlCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  async function handleSave() {
    const { saveLlmConfig, saveSearchApiConfig, saveEmbeddingConfig } = await import("@/lib/project-store")
    const newConfig = { provider, apiKey, model, ollamaUrl, customEndpoint, maxContextSize, reasoningEffort }
    const newSearchConfig = { provider: searchProvider, apiKey: searchApiKey }
    const newEmbeddingConfig = { enabled: embeddingEnabled, endpoint: embeddingEndpoint, apiKey: embeddingApiKey, model: embeddingModel }
    setSearchApiConfig(newSearchConfig)
    await saveSearchApiConfig(newSearchConfig)
    setEmbeddingConfig(newEmbeddingConfig)
    await saveEmbeddingConfig(newEmbeddingConfig)
    setLlmConfig(newConfig)
    await saveLlmConfig(newConfig)
    setSaved(true)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
  }

  async function handleLanguageChange(lang: string) {
    await i18n.changeLanguage(lang)
    setCurrentLang(lang)
    await saveLanguage(lang)
  }

  async function handleThemeChange(theme: AppTheme) {
    setAppTheme(theme)
    await saveAppTheme(theme)
  }

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-xl">
        <h2 className="mb-6 text-2xl font-bold">{t("settings.title")}</h2>

        <div className="space-y-6">
          {/* Language section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.language")}</h3>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => handleLanguageChange(lang.value)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    currentLang === lang.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
          </div>

          {/* Appearance / Theme section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.appearance")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.appearanceHint")}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => handleThemeChange(preset.key)}
                  className={`group relative flex flex-col items-center gap-2 rounded-lg border p-3 transition-all ${
                    appTheme === preset.key
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/50 hover:bg-accent"
                  }`}
                >
                  <div
                    className="h-10 w-full rounded-md shadow-inner"
                    style={{ backgroundColor: preset.previewColor }}
                  />
                  <span className="text-xs font-medium">
                    {i18n.language === "zh" ? preset.label : preset.labelEn}
                  </span>
                  {appTheme === preset.key && (
                    <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* LLM Provider section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">{t("settings.llmProvider")}</h3>

            <div className="space-y-2">
              <Label>{t("settings.provider")}</Label>
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => {
                      setProvider(p.value)
                      setModel(p.models[0] || "")
                    }}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      provider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {(provider === "custom" ||
              provider === "minimax" ||
              provider === "openai" ||
              provider === "anthropic" ||
              provider === "kimi" ||
              provider === "codex") && (
              <div className="space-y-2">
                <Label htmlFor="customEndpoint">
                  {provider === "minimax"
                    ? "MiniMax Endpoint"
                    : provider === "openai"
                      ? "OpenAI Endpoint"
                      : provider === "anthropic"
                        ? "Anthropic Endpoint"
                        : provider === "kimi"
                          ? "Kimi Code Endpoint"
                          : provider === "codex"
                            ? "Codex Endpoint"
                            : t("settings.customEndpoint")}
                </Label>
                <Input
                  id="customEndpoint"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder={
                    provider === "minimax"
                      ? "https://api.minimax.io/v1"
                      : provider === "openai"
                        ? "https://api.openai.com/v1"
                        : provider === "anthropic"
                          ? "https://api.anthropic.com"
                          : provider === "kimi"
                            ? "https://api.kimi.com/coding/v1"
                            : provider === "codex"
                              ? "https://api.suyacode.com"
                              : "https://your-api.example.com/v1"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {provider === "minimax"
                    ? "国内用户请填写 https://api.minimaxi.com/v1，国际用户可留空使用默认 endpoint"
                    : provider === "openai"
                      ? "留空使用官方 https://api.openai.com/v1，可填写第三方中转 base URL（自动拼接 /chat/completions）"
                      : provider === "anthropic"
                        ? "留空使用官方 https://api.anthropic.com，可填写代理 base URL（自动拼接 /v1/messages）"
                        : provider === "kimi"
                          ? "留空使用 Kimi Code 编码端点（256K 上下文 / kimi-for-coding 模型）；如需通用 Kimi 可填 https://api.moonshot.cn/v1 并改 model 为 moonshot-v1-128k"
                          : provider === "codex"
                            ? "留空使用官方 https://api.openai.com，可填写中转站 base URL（自动拼接 /v1/responses）。适配 GPT-5 / Codex 系列推理模型。"
                            : t("settings.customEndpointHint")}
                </p>
              </div>
            )}

            {provider === "codex" && (
              <div className="space-y-2">
                <Label>Reasoning effort</Label>
                <div className="flex flex-wrap gap-2">
                  {REASONING_EFFORTS.map((e) => (
                    <button
                      key={e.value}
                      onClick={() => setReasoningEffort(e.value)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                        reasoningEffort === e.value
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  控制模型思考深度。Minimal 最快但浅；Medium 默认；High 最深思考最慢，token 消耗最大。
                </p>
              </div>
            )}

            {provider === "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="ollamaUrl">{t("settings.ollamaUrl")}</Label>
                <Input
                  id="ollamaUrl"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
            )}

            {provider !== "ollama" && (
              <div className="space-y-2">
                <Label htmlFor="apiKey">{t("settings.apiKey")}</Label>
                <div className="relative">
                  <Input
                    id="apiKey"
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="pr-9 font-mono"
                    placeholder={
                      provider === "custom"
                        ? t("settings.customApiKey")
                        : t("settings.apiKeyPlaceholder", { provider: currentProvider?.label })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    tabIndex={-1}
                  >
                    {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="model">{t("settings.model")}</Label>
              {currentProvider && currentProvider.models.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {currentProvider.models.map((m) => (
                      <button
                        key={m}
                        onClick={() => setModel(m)}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          model === m
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("settings.customModel")}
                  />
                </div>
              ) : (
                <Input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t("settings.modelPlaceholder")}
                />
              )}
            </div>

            {/* Endpoint preview + connection test */}
            <div className="space-y-2 border-t pt-4">
              {previewUrl && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">最终请求 URL</Label>
                  <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                    <code className="flex-1 truncate font-mono text-xs">{previewUrl}</code>
                    <button
                      type="button"
                      onClick={handleCopyUrl}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="复制 URL"
                    >
                      {urlCopied ? (
                        <Check className="size-3.5 text-green-600" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestConnection}
                  disabled={testing || !previewUrl}
                >
                  {testing ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Activity className="mr-2 size-4" />
                  )}
                  {testing ? "测试中…" : "测试连接"}
                </Button>

                {testResult && !testing && (
                  <div className="flex-1 text-xs">
                    {testResult.ok ? (
                      <span className="inline-flex items-center gap-1.5 text-green-600">
                        <CheckCircle2 className="size-4" />
                        连接成功 · {testResult.latencyMs}ms 首 token
                      </span>
                    ) : (
                      <span className="inline-flex items-start gap-1.5 text-red-600">
                        <XCircle className="mt-0.5 size-4 shrink-0" />
                        <span className="break-all">
                          {testResult.status ? `HTTP ${testResult.status} · ` : ""}
                          {testResult.error}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                测试发送一条最短消息，命中首 token 即判定连通；不会保存当前修改。
              </p>
            </div>
          </div>

          {/* Context Window Size */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Context Window</h3>
            <p className="text-xs text-muted-foreground">
              Maximum context size sent to the LLM. Larger context allows more wiki pages in each query but costs more tokens.
            </p>

            <div className="space-y-3">
              <ContextSizeSelector value={maxContextSize} onChange={setMaxContextSize} />
            </div>
          </div>

          {/* Web Search API section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Web Search (Deep Research)</h3>
            <p className="text-xs text-muted-foreground">
              Enable AI-powered web research to automatically find relevant sources for knowledge gaps.
            </p>

            <div className="space-y-2">
              <Label>Search Provider</Label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "none" as const, label: "Disabled" },
                  { value: "tavily" as const, label: "Tavily" },
                ].map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setSearchProvider(p.value)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      searchProvider === p.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {searchProvider !== "none" && (
              <div className="space-y-2">
                <Label htmlFor="searchApiKey">API Key</Label>
                <Input
                  id="searchApiKey"
                  type="password"
                  value={searchApiKey}
                  onChange={(e) => setSearchApiKey(e.target.value)}
                  placeholder="Enter your Tavily API key (tavily.com)"
                />
              </div>
            )}
          </div>

          {/* Embedding Search section */}
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Vector Search (Embedding)</h3>
              <button
                onClick={() => setEmbeddingEnabled(!embeddingEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  embeddingEnabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    embeddingEnabled ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Enable semantic search using embeddings. Uses the same LLM provider endpoint. Improves search quality for synonym matching and cross-domain discovery.
            </p>
            {embeddingEnabled && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Endpoint</Label>
                  <Input
                    value={embeddingEndpoint}
                    onChange={(e) => setEmbeddingEndpoint(e.target.value)}
                    placeholder="e.g. http://127.0.0.1:1234/v1/embeddings"
                  />
                </div>
                <div className="space-y-2">
                  <Label>API Key (optional)</Label>
                  <Input
                    type="password"
                    value={embeddingApiKey}
                    onChange={(e) => setEmbeddingApiKey(e.target.value)}
                    placeholder="Leave empty for local models"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Model</Label>
                  <Input
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    placeholder="e.g. text-embedding-qwen3-embedding-0.6b"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Embedding service can be different from the chat LLM. Supports any OpenAI-compatible /v1/embeddings endpoint.
                </p>
              </div>
            )}
          </div>

          {/* Web Clip extension pairing */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Web Clip 扩展配对</h3>
            <p className="text-xs text-muted-foreground">
              在浏览器扩展中输入此配对码，即可获取 Clip 访问令牌。配对码保存在本机，重启应用后不变。
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={clipPairingCode || "加载中…"}
                className="font-mono tracking-widest"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyClipPairingCode}
                disabled={!clipPairingCode}
              >
                {clipPairingCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          {/* Chat History section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Chat History</h3>
            <p className="text-xs text-muted-foreground">
              Number of previous messages included when talking to AI. More = better context but uses more tokens.
            </p>
            <div className="space-y-2">
              <Label>Max conversation messages sent to AI</Label>
              <div className="flex flex-wrap gap-2">
                {HISTORY_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setMaxHistoryMessages(n)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      maxHistoryMessages === n
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Currently: {maxHistoryMessages} messages ({maxHistoryMessages / 2} rounds of conversation)
              </p>
            </div>
          </div>

          {/* PostgreSQL Stock Code Source */}
          <PgConfigSection />

          {/* Schema Migration */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Schema v1 一次性迁移</h3>
            <p className="text-xs text-muted-foreground">
              <strong>步骤 1</strong>：将所有 wiki 页面的 frontmatter 升级为 Schema v1（包 ```yaml、补字段、清 sources、查 DB 覆写股票 code）。跑前自动 zip 备份。
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setMigrateOpen(true)}
            >
              <ArrowUpCircle className="mr-2 size-4" />
              迁移 Wiki 到 Schema v1
            </Button>
          </div>

          {/* Body Residue Cleanup (T25) */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Body 老 frontmatter 残骸清理</h3>
            <p className="text-xs text-muted-foreground">
              <strong>步骤 2</strong>：扫所有页面 body 头部，识别并剖除残留的老 frontmatter（如 <code>***</code> + <code>title:</code>）。从严匹配，抢救 sources/tags/aliases 三类 list 字段。不确定项进报告等手动审核。需先完成步骤 1。
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setResidueOpen(true)}
            >
              <FileScan className="mr-2 size-4" />
              清理 body 残骸
            </Button>
          </div>

          {/* Normalize Physical Dirs (T24) */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">物理目录归一化</h3>
            <p className="text-xs text-muted-foreground">
              <strong>步骤 3</strong>：把散乱目录（进化/市场模式/analysis/concept 等）合并到 9 个 canonical 中文目录，同步替换所有 wikilink。冲突文件按 updated 时间保留较新版，旧版进 .conflicts/ 隔离。需先完成步骤 2。
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setNormalizeOpen(true)}
            >
              <FolderTree className="mr-2 size-4" />
              归一化 Wiki 目录结构
            </Button>
          </div>

          {/* Cleanup Garbage Pages (T26) */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">清理 wiki/源文档/ + wiki/查询/ 历史垃圾页</h3>
            <p className="text-xs text-muted-foreground">
              <strong>步骤 4</strong>：扫描两个目录里的 .md 文件，识别 LLM 自动生成的「垃圾页」（chat 模板回流、空 slug 文件名、过短 body 等）。命中文件**归档到 wiki/.conflicts/garbage-*/，不删除**。需先完成步骤 1～3。
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setCleanupGarbageOpen(true)}
            >
              <Trash2 className="mr-2 size-4" />
              清理历史垃圾页
            </Button>
          </div>

          {/* Wiki Doctor section */}
          <div className="space-y-4 rounded-lg border p-4">
            <h3 className="font-semibold">Wiki 整理工具</h3>
            <p className="text-xs text-muted-foreground">
              检测并修复 Wiki 目录结构问题：重复文件夹、散落文件、索引合并等。
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setDoctorOpen(true)}
            >
              <Stethoscope className="mr-2 size-4" />
              打开 Wiki 整理医生
            </Button>
          </div>

          <Button onClick={handleSave} className="w-full">
            {saved ? t("settings.saved") : t("settings.save")}
          </Button>
        </div>
      </div>

      <WikiDoctorDialog open={doctorOpen} onOpenChange={setDoctorOpen} />
      <MigrateSchemaDialog open={migrateOpen} onOpenChange={setMigrateOpen} />
      <BodyResidueDialog open={residueOpen} onOpenChange={setResidueOpen} />
      <NormalizeDirsDialog open={normalizeOpen} onOpenChange={setNormalizeOpen} />
      <CleanupGarbageDialog open={cleanupGarbageOpen} onOpenChange={setCleanupGarbageOpen} />
    </div>
  )
}

// Context size presets matching common model context windows
const CONTEXT_PRESETS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
  { value: 204800, label: "200K" },
  { value: 262144, label: "256K" },
  { value: 524288, label: "512K" },
  { value: 1000000, label: "1M" },
]

function ContextSizeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  // Find closest preset index
  const closestIndex = CONTEXT_PRESETS.reduce((best, preset, i) => {
    return Math.abs(preset.value - value) < Math.abs(CONTEXT_PRESETS[best].value - value) ? i : best
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{formatSize(value)}</span>
        <span className="text-xs text-muted-foreground">
          ~{Math.floor(value * 0.6 / 1000)}K chars for wiki content
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={CONTEXT_PRESETS.length - 1}
        step={1}
        value={closestIndex}
        onChange={(e) => onChange(CONTEXT_PRESETS[parseInt(e.target.value)].value)}
        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-primary"
        style={{ background: `linear-gradient(to right, #4f46e5 ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%, #e5e7eb ${(closestIndex / (CONTEXT_PRESETS.length - 1)) * 100}%)` }}
      />
      <div className="flex justify-between mt-1">
        {CONTEXT_PRESETS.map((preset, i) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange(preset.value)}
            className={`text-[9px] px-0.5 ${
              i === closestIndex ? "text-primary font-bold" : "text-muted-foreground/50"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatSize(chars: number): string {
  if (chars >= 1000000) return `${(chars / 1000000).toFixed(1)}M characters`
  if (chars >= 1000) return `${Math.round(chars / 1000)}K characters`
  return `${chars} characters`
}

function PgConfigSection() {
  const project = useWikiStore((s) => s.project)
  const pgConfig = useWikiStore((s) => s.pgConfig)
  const setPgConfig = useWikiStore((s) => s.setPgConfig)

  const [host, setHost] = useState(pgConfig.host)
  const [port, setPort] = useState<string>(pgConfig.port?.toString() ?? "")
  const [user, setUser] = useState(pgConfig.user)
  const [password, setPassword] = useState(pgConfig.password)
  const [database, setDatabase] = useState(pgConfig.database)
  const [useTls, setUseTls] = useState<boolean | null>(pgConfig.useTls)
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [status, setStatus] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const loadStatus = useCallback(async () => {
    if (!project) {
      setStatus(null)
      return
    }
    try {
      const s = await getStockCodesStatus(project.path)
      setStatus(s)
    } catch (err) {
      console.warn("[PgConfig] load status failed:", err)
    }
  }, [project])

  useEffect(() => {
    setHost(pgConfig.host)
    setPort(pgConfig.port?.toString() ?? "")
    setUser(pgConfig.user)
    setPassword(pgConfig.password)
    setDatabase(pgConfig.database)
    setUseTls(pgConfig.useTls)
  }, [pgConfig])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  function currentConfig(): PgConfig {
    const portNum = port.trim() ? Number(port) : null
    return {
      host: host.trim(),
      port: Number.isFinite(portNum as number) ? (portNum as number) : null,
      user: user.trim(),
      password,
      database: database.trim(),
      useTls,
    }
  }

  function isComplete(cfg: PgConfig): boolean {
    return !!(cfg.host && cfg.port && cfg.user && cfg.password && cfg.database)
  }

  async function handleSave() {
    const cfg = currentConfig()
    setSaving(true)
    try {
      setPgConfig(cfg)
      await savePgConfig(cfg)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  async function handleRefresh() {
    if (!project) {
      setError("请先打开一个项目")
      return
    }
    const cfg = currentConfig()
    if (!isComplete(cfg)) {
      setError("PG 配置不完整，请填写全部 5 项")
      return
    }
    setError(null)
    setSyncing(true)
    try {
      // Persist current config before sync (so it's not lost on failure)
      setPgConfig(cfg)
      await savePgConfig(cfg)
      const result = await syncStockCodes(project.path, cfg, true)
      setStatus(result)
    } catch (err) {
      setError(typeof err === "string" ? err : String(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h3 className="font-semibold">PostgreSQL 股票代码源</h3>
      <p className="text-xs text-muted-foreground">
        Save to Wiki 写股票页时，由此处的 DB 覆写 code 字段（防止 LLM 瞎编）。表：cn_stock_name_wind。
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pgHost">Host</Label>
          <Input
            id="pgHost"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="127.0.0.1"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pgPort">Port</Label>
          <Input
            id="pgPort"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="5432"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pgDatabase">Database</Label>
          <Input
            id="pgDatabase"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="cn_stock_db"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pgUser">User</Label>
          <Input
            id="pgUser"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="用户名"
          />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="pgPassword">Password</Label>
          <div className="relative">
            <Input
              id="pgPassword"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-9 font-mono"
              placeholder="数据库密码"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
        <div className="col-span-2 flex items-center gap-2">
          <input
            id="pgUseTls"
            type="checkbox"
            checked={useTls ?? false}
            onChange={(e) => setUseTls(e.target.checked)}
          />
          <Label htmlFor="pgUseTls">使用 TLS 连接（远程数据库建议开启；本机 localhost 可关闭）</Label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "保存中…" : saved ? "已保存" : "保存配置"}
        </Button>
        <Button
          size="sm"
          onClick={handleRefresh}
          disabled={syncing || !project}
        >
          {syncing ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              同步中…
            </>
          ) : (
            "立即刷新股票代码库"
          )}
        </Button>
      </div>

      {error && (
        <p className="text-xs text-red-600 break-all">{error}</p>
      )}
      {status && (
        <p className="text-xs text-muted-foreground">
          上次同步：{status.synced_at} · 共 {status.count} 条
        </p>
      )}
      {!status && !error && (
        <p className="text-xs text-muted-foreground">
          {project ? "尚未同步过股票代码库" : "请先打开一个项目"}
        </p>
      )}
    </div>
  )
}
