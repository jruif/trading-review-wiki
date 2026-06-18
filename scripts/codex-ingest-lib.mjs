import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import vm from "node:vm"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

const execFileAsync = promisify(execFile)

export const PROJECT_PATH_ENV_VARS = ["TRADING_WIKI_PROJECT", "GANGTISE_MEETING_CLUES_PROJECT"]
export const REPORT_ROOT = ".llm-wiki/codex-ingest"
export const COMPANY_RESEARCH_ROOT = ".llm-wiki/company-research"
export const MANIFEST_SCHEMA = "codex-ingest-manifest-v1"
export const PAGE_BODY_LINE_SOFT_LIMIT = 2000
export const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex"
export const DEFAULT_CODEX_TIMEOUT_MS = 30 * 60 * 1000
export const SOURCE_PROMPT_CHAR_SOFT_LIMIT = 90000
export const METHODOLOGY_CONTEXT_TOTAL_CHAR_SOFT_LIMIT = 11000
export const METHODOLOGY_PAGE_CHAR_SOFT_LIMIT = 1600
export const METHODOLOGY_STAGE3_RULE_CHAR_SOFT_LIMIT = 2200

export const METHODOLOGY_CONTEXT_PATHS = [
  "wiki/策略/四层嵌套决策体系.md",
  "wiki/策略/L4执行控制层.md",
  "wiki/策略/Tier-1退出机制.md",
  "wiki/策略/催化剂L4必问清单.md",
  "wiki/策略/催化剂复盘流程.md",
  "wiki/策略/催化剂评分交易规则.md",
  "wiki/概念/催化剂层级框架.md",
  "wiki/错误/事件催化替代买点纪律.md",
  "wiki/策略/WKID四步法.md",
]

export const WIKI_TYPES = [
  "股票",
  "概念",
  "策略",
  "模式",
  "错误",
  "人物",
  "总结",
  "查询",
  "源文档",
  "事件",
]

export const WIKI_STATUS = ["活跃", "观察", "归档", "废弃", "迭代中"]
export const CONFIDENCE = ["高", "中", "低"]

const SUMMARY_MIN = 50
const SUMMARY_MAX = 160
const STOCK_CODE_REGEX = /^(?:(?:SZ|SH|BJ)\d{6}|HK\d{5}|[A-Z]{1,5}(?:\.[A-Z])?)$/
const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export function sanitizeTextControlCharacters(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
}

function parseLocalTimestampParts(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/)
  if (!match) return null
  return {
    date: match[1],
    time: match[2] ? (match[2].length === 5 ? `${match[2]}:00` : match[2]) : null,
  }
}

function formatTimestampFromDate(date) {
  const pad = (n) => n.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function normalizeWikiTimestamp(value, fallback = nowLocalTimestamp()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatTimestampFromDate(value)
  }

  const text = String(value ?? "").trim().replace(/^['"]|['"]$/g, "")
  if (!text) return fallback
  if (TIMESTAMP_REGEX.test(text)) return text

  const parts = parseLocalTimestampParts(text)
  if (parts) {
    return `${parts.date} ${parts.time ?? "00:00:00"}`
  }

  const parsedMs = Date.parse(text)
  if (Number.isFinite(parsedMs)) {
    return formatTimestampFromDate(new Date(parsedMs))
  }

  return fallback
}

export function normalizeFrontmatterFields(fm, options = {}) {
  const fallback = options.now ?? nowLocalTimestamp()
  const next = { ...(fm ?? {}) }
  for (const field of ["created", "updated", "last_reviewed"]) {
    next[field] = normalizeWikiTimestamp(next[field], fallback)
  }
  return next
}

function buildFallbackSummary(title, body) {
  const paragraph = String(body ?? "")
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk && !chunk.startsWith("#") && !chunk.startsWith("```") && !chunk.startsWith("---"))
  let summary = paragraph?.replace(/\s+/g, " ").slice(0, SUMMARY_MAX) ?? ""
  if ([...summary].length < SUMMARY_MIN) {
    summary = `${title}页面，由 ingest 基于 raw 资料自动整理生成，后续可继续补充证据链与交叉引用。`
  }
  while ([...summary].length < SUMMARY_MIN) summary += "。"
  return summary.slice(0, SUMMARY_MAX)
}

export function coerceWikiPageFrontmatter(fm, relativePath, body, options = {}) {
  const next = normalizeFrontmatterFields({ ...(fm ?? {}) }, options)

  if (next.schema_version !== 1) next.schema_version = 1

  if (!next.title || typeof next.title !== "string" || !next.title.trim()) {
    const heading = String(body ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim()
    next.title = heading || pathToTitle(relativePath)
  }

  next.type = normalizeTypeAlias(next.type) ?? inferTypeFromPath(relativePath)

  if (typeof next.summary !== "string" || next.summary.trim().length === 0) {
    next.summary = buildFallbackSummary(next.title, body)
  }

  if (!CONFIDENCE.includes(next.confidence)) next.confidence = "中"
  next.status = normalizeStatusAlias(next.status) ?? "活跃"

  for (const field of ["aliases", "tags", "related", "sources"]) {
    if (next[field] == null) next[field] = []
    else if (!Array.isArray(next[field])) next[field] = [String(next[field])]
  }

  return next
}

export function normalizeWikiPageContent(content, options = {}) {
  const relativePath = options.relativePath ?? ""
  const { fm, body } = parseFrontmatter(content)
  const shouldCoerce = relativePath.startsWith("wiki/") && relativePath.endsWith(".md") && !isReservedWikiPath(relativePath)
  const normalizedFm = shouldCoerce
    ? coerceWikiPageFrontmatter(fm, relativePath, body, options)
    : normalizeFrontmatterFields(fm, options)
  const serialized = serializeFrontmatter(normalizedFm, body)
  return serialized
}

function extractJsonFromModelText(text) {
  const source = String(text ?? "")
  const fencedJson = source.match(/```json\s*\n([\s\S]*?)```/i)
  const rawJson = fencedJson?.[1] ?? source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1)
  if (!rawJson.trim()) throw new Error("Model output did not contain a JSON object")
  return rawJson
}

function escapeControlCharactersInJsonStrings(raw) {
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inString = false
      continue
    }
    const code = ch.charCodeAt(0)
    if (code < 0x20) {
      if (ch === "\n") out += "\\n"
      else if (ch === "\r") out += "\\r"
      else if (ch === "\t") out += "\\t"
      continue
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
  }

  return out
}

export function parseModelJson(text) {
  const rawJson = extractJsonFromModelText(text)
  const attempts = [
    () => JSON.parse(rawJson),
    () => JSON.parse(rawJson.replace(/^\uFEFF/, "")),
    () => JSON.parse(escapeControlCharactersInJsonStrings(rawJson)),
    () => JSON.parse(escapeControlCharactersInJsonStrings(rawJson.replace(/[\u201C\u201D]/g, '"'))),
  ]

  let lastError = null
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error("Model output did not contain valid JSON")
}
const WIKILINK_REGEX = /^\[\[[^\]]+\]\]$/
const RESERVED_WIKI_PATHS = new Set(["wiki/index.md", "wiki/overview.md", "wiki/log.md"])
const DAILY_LOG_REGEX = /^wiki\/logs\/log-\d{4}-\d{2}-\d{2}\.md$/

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text", ".log"])
const ASK_NAVIGATION_PATHS = ["wiki/index.md", "wiki/overview.md"]
const ASK_DEFAULT_TOP_WIKI = 12
const ASK_DEFAULT_TOP_RAW = 12
const ASK_DEFAULT_GRAPH_NEIGHBORS = 8
const ASK_DEFAULT_GRAPH_DEPTH = 1
const ASK_MAX_GRAPH_DEPTH = 2
const ASK_DEFAULT_SOURCE_K = 3
const ASK_DEFAULT_TOP_FACTS = 8
const ASK_DEFAULT_TOP_BRAIN = 8
const ASK_DEFAULT_SQL_LIMIT = 200
export const TEMPORAL_FACTS_RELATIVE_PATH = "data/facts/temporal_edges.jsonl"
export const TEMPORAL_FACT_INDEX_RELATIVE_PATH = "data/facts/temporal_edges.index.json"
export const TEMPORAL_FACT_PREDICATES = [
  "HAS_CATALYST",
  "HAS_ORDER",
  "HAS_ORDER_RUMOR",
  "HAS_ORDER_INTENT",
  "HAS_CONFIRMED_ORDER",
  "HAS_DELIVERY_VALIDATION",
  "HAS_CUSTOMER",
  "HAS_CAPACITY",
  "HAS_PRICE_SIGNAL",
  "HAS_POLICY_SUPPORT",
  "HAS_PRODUCT",
  "HAS_TECH_PROGRESS",
  "HAS_SUPPLY_CONSTRAINT",
  "HAS_VALIDATION_SIGNAL",
  "PRICE_VALIDATED",
  "VOLUME_VALIDATED",
  "CUSTOMER_VALIDATED",
  "TECH_VALIDATED",
  "FUNDAMENTAL_VALIDATED",
  "HAS_RISK",
  "HAS_CLARIFICATION_RISK",
  "HAS_COMPETITION_RISK",
  "HAS_DEMAND_RISK",
  "HAS_SUPPLY_CHAIN_RISK",
  "HAS_VALUATION_RISK",
  "VALIDATES",
  "CONTRADICTS",
]
export const TEMPORAL_FACT_STATUSES = ["active", "superseded", "invalidated", "expired"]
export const TEMPORAL_FACT_EVIDENCE_LEVELS = ["A", "B", "C", "D"]
export const TEMPORAL_FACT_SOURCE_KINDS = [
  "official_announcement",
  "financial_report",
  "exchange_interaction",
  "government_policy",
  "company_ir",
  "broker_research",
  "industry_database",
  "expert_meeting",
  "media_report",
  "social_chat",
  "market_price",
  "manual_review",
]
const ASK_STOCK_DAILY_KEYCHAIN_SERVICE = "trading-wiki-cn-stock-db"
const ASK_STOCK_DAILY_KEYCHAIN_ACCOUNT = "shihao"
const ASK_STOCK_DAILY_DEFAULT_DATABASE = "cn_stock_db"
const ASK_STOCK_DAILY_DEFAULT_SCHEMA = "public"
const ASK_STOCK_DAILY_DEFAULT_TABLE = "cn_stock_price_daily_wind"
const COMPANY_TUSHARE_KEYCHAIN_SERVICE = "trading-wiki-tushare-token"
const COMPANY_TUSHARE_KEYCHAIN_ACCOUNT = "tushare"
const COMPANY_TAVILY_KEYCHAIN_SERVICE = "trading-wiki-tavily-api-key"
const COMPANY_TAVILY_KEYCHAIN_ACCOUNT = "tavily"
const COMPANY_RESEARCH_TEMPLATE_VERSION = "company-research-model-v1"
const COMPANY_DEEP_TEMPLATE_VERSION = "company-research-deep-v1"
const COMPANY_FINANCIAL_MODEL_V2_VERSION = "company-financial-model-v2"
const ASK_WIKI_EXCERPT_CHARS = 3600
const ASK_RAW_EXCERPT_CHARS = 2800
const ASK_GRAPH_EXCERPT_CHARS = 2200
const ASK_NAV_EXCERPT_CHARS = 2600
const ASK_FACTS_EXCERPT_CHARS = 1800
const ASK_BRAIN_EXCERPT_CHARS = 1800
const ASK_SQL_EXCERPT_CHARS = 1800
const ASK_TIME_TOKENS = new Set(["最近", "近一", "一周", "近7天", "本周", "这周", "最近一周", "近一个月", "最近一个月", "本月", "这个月", "今天", "当日", "昨天", "昨日"])
const ASK_SOURCE_IDS = ["wiki_pages", "raw_text", "wiki_graph", "facts_jsonl", "brain_memory", "stock_daily_sql"]
export const RETRIEVAL_MODES = Object.freeze({
  ASK: "ask",
  INGEST: "ingest",
})
const ASK_SOURCE_ALIASES = new Map(
  Object.entries({
    auto: "auto",
    wiki: "wiki_pages",
    wikis: "wiki_pages",
    "wiki-pages": "wiki_pages",
    wiki_pages: "wiki_pages",
    raw: "raw_text",
    raws: "raw_text",
    "raw-text": "raw_text",
    raw_text: "raw_text",
    graph: "wiki_graph",
    "wiki-graph": "wiki_graph",
    wiki_graph: "wiki_graph",
    facts: "facts_jsonl",
    "facts-jsonl": "facts_jsonl",
    facts_jsonl: "facts_jsonl",
    brain: "brain_memory",
    memory: "brain_memory",
    "brain-memory": "brain_memory",
    brain_memory: "brain_memory",
    "stock-price": "stock_daily_sql",
    "stock-daily": "stock_daily_sql",
    stock: "stock_daily_sql",
    sql: "stock_daily_sql",
    stock_daily_sql: "stock_daily_sql",
  }),
)
const STOCK_DAILY_KEYWORD_REGEX = /(?:股价|价格|收盘|开盘|最高|最低|涨跌|涨幅|跌幅|成交量|成交额|换手|日线|k线|K线|量价|均线|振幅|交易日|最近\d+|近\d+|涨了|跌了)/
const TRADE_REVIEW_KEYWORD_REGEX = /(?:错误|模式|复盘|高开|接盘|打板|割肉|回撤|交割单|交易|买入|卖出|持仓|亏损|盈利|执行|纪律|仓位)/
const FACTS_KEYWORD_REGEX = /(?:案例|观察|事实|验证|预测|计划|证伪|样本|记录)/
const BRAIN_KEYWORD_REGEX = /(?:记忆|纠错|偏好|卫语句|guardrail|自训练|训练|置信度|待验证|验证|预测|复盘|错误|偏好|样本)/
const RAW_NEWS_KEYWORD_REGEX = /(?:最近|近期|本周|新闻|舆情|研报|会议|调研|微信|gangtise|投研|催化|涨价|订单|纪要)/
const METHODOLOGY_IMPORTANT_LINE_REGEX = /(?:L1|L2|L3|L4|四层|嵌套|决策|执行|控制|退出|卖出|买点|催化|事实|证据|验证|观察|纪律|仓位|风控|预期|兑现|WKID|四步法|明日|清单|盘前|盘中|盘后|硬催化|软催化|评分|层级|替代|证伪|主线|非主线|吸收|分歧|确认)/
const INGEST_SEGMENT_DEFAULT_MAX = 12
const INGEST_SEGMENT_WIKI_LIMIT = 8
const INGEST_SEGMENT_RAW_LIMIT = 4
const INGEST_SOURCE_FIELD_TOKENS = new Set([
  "title",
  "theme",
  "theme_id",
  "theme_date",
  "type",
  "type_code",
  "name",
  "code",
  "date",
  "category",
  "category_name",
  "source",
  "source_db",
  "source_field",
  "content_sha256",
  "content",
  "entry_time",
  "field",
  "full",
  "hot",
  "update_time",
  "hot_score",
  "hot_status",
  "hot_reasons",
  "metadata",
  "frontmatter",
  "yaml",
  "markdown",
  "raw",
  "full_content",
  "public",
  "alternative",
  "cn_alternative_db",
  "gangtise_themes",
  "sha256",
  "status",
  "strong",
  "themes",
])
const INGEST_IMPORTANT_PHRASE_REGEX = /(?:具身智能|人形机器人|谐波减速器|灵巧手|执行器|算电协同|电力运营商|数据中心|光模块|液冷|固态电池|低空经济|覆铜板|订单节点|量产节点)/
const INGEST_GENERIC_SOURCE_TOKENS = new Set([
  "今日",
  "核心",
  "叙事",
  "逻辑",
  "验证",
  "原文",
  "元数据",
  "复盘",
  "晨报",
  "产业趋势",
  "热门",
  "非热门",
  "行业",
  "当前",
  "主线",
  "白名单",
  "公司",
  "公司动态",
  "动态",
  "关注",
  "今日关注",
  "今日及近期关注事件",
  "近期",
  "近一周展望",
  "重点资讯与公告",
  "完整调研原文",
  "同步与窗口",
  "舆情更新",
  "舆情摘要",
  "市场情绪",
  "重点板块",
  "风险与待验证",
  "待验证",
  "政策",
  "事件",
  "重点",
  "公告",
  "资讯",
  "机构",
  "推荐",
  "观点",
  "更新",
  "进入",
  "成为",
  "显示",
  "指出",
])
const INGEST_UPPERCASE_KEEP_TOKENS = new Set([
  "AI",
  "PCB",
  "CPO",
  "NPO",
  "TGV",
  "HBM",
  "MLCC",
  "HVDC",
  "PSPI",
  "SOP",
  "PPA",
  "IPO",
  "CEO",
  "NV",
  "GB200",
  "GB300",
  "ASIC",
])
const STOCK_CODE_LIKE_REGEX = /\b(?:(?:SZ|SH|BJ)\d{6}|\d{6}\.(?:SZ|SH|BJ)|\d{6})\b/gi
const STOCK_DAILY_COLUMN_CANDIDATES = {
  ticker: ["ticker", "wind_code", "s_info_windcode", "stock_code", "code", "symbol", "ts_code"],
  date: ["date", "trade_date", "tradedate", "trade_dt", "trading_date", "s_info_windcode_date", "datetime"],
  open: ["open", "open_price", "s_dq_open", "s_dq_adjopen"],
  high: ["high", "high_price", "s_dq_high", "s_dq_adjhigh"],
  low: ["low", "low_price", "s_dq_low", "s_dq_adjlow"],
  close: ["close", "close_price", "s_dq_close", "s_dq_adjclose"],
  preClose: ["pre_close", "preclose", "s_dq_preclose", "s_dq_adjpreclose"],
  change: ["change", "chg", "s_dq_change"],
  pctChange: ["pct_cng", "pct_chg", "pct_change", "s_dq_pctchange", "s_dq_pchange"],
  volume: ["volume", "vol", "s_dq_volume"],
  amount: ["amount", "amt", "s_dq_amount"],
  turnover: ["turnover", "turnover_rate", "s_dq_turnover", "s_dq_turnoverrate"],
}
const BRAIN_TYPE_TO_FILE = new Map(
  Object.entries({
    thread: "active_threads.jsonl",
    active_thread: "active_threads.jsonl",
    correction: "corrections.jsonl",
    preference: "preferences.jsonl",
    guardrail: "guardrails.jsonl",
    prediction: "predictions.jsonl",
    validation: "validations.jsonl",
    event: "self_training_events.jsonl",
  }),
)
const DAILY_LOOP_DEFAULT_VALIDATION_WINDOWS = [1, 3, 5, 10, 20]
const DAILY_LOOP_VALIDATION_METHOD = "first_trading_day_after_prediction_v1"
const DAILY_LOOP_MODE_DEFAULT_COUNTS = new Map([
  ["premarket", 6],
  ["postclose", 8],
  ["full", 14],
])
const DAILY_LOOP_QUESTION_TYPES_BY_MODE = new Map([
  ["premarket", ["expected_difference", "expected_difference", "bottleneck_supplier", "bottleneck_supplier", "weak_to_strong_low_buy", "risk_counter"]],
  ["postclose", ["postclose_validation", "postclose_validation", "postclose_validation", "postclose_validation", "expected_difference", "bottleneck_supplier", "correction", "wiki_feedback"]],
  [
    "full",
    [
      "expected_difference",
      "expected_difference",
      "bottleneck_supplier",
      "bottleneck_supplier",
      "weak_to_strong_low_buy",
      "risk_counter",
      "postclose_validation",
      "postclose_validation",
      "postclose_validation",
      "postclose_validation",
      "expected_difference",
      "bottleneck_supplier",
      "correction",
      "wiki_feedback",
    ],
  ],
])
const DAILY_LOOP_QUESTION_TYPE_LABELS = {
  expected_difference: "预期差/补涨",
  bottleneck_supplier: "卡脖子不可替代供货商",
  weak_to_strong_low_buy: "强转弱低吸",
  risk_counter: "风险反证",
  postclose_validation: "盘后验证旧假设",
  correction: "错误/模式纠偏",
  wiki_feedback: "wiki反哺总结",
}
const DAILY_LOOP_EXTERNAL_MARKET_DEFAULT = "auto"
const EASTMONEY_KLINE_COLUMNS = {
  ticker: "ticker",
  date: "date",
  open: "open",
  high: "high",
  low: "low",
  close: "close",
  pctChange: "pctChange",
  change: "change",
  volume: "volume",
  amount: "amount",
  turnover: "turnover",
  ready: true,
}
const DAILY_LOOP_THEME_PROFILES = [
  {
    id: "ai-pcb-materials",
    branch: "PCB材料/工艺链",
    keywords: ["PCB", "CCL", "覆铜板", "电子布", "铜箔", "HVLP", "mSAP", "MSAP", "钻针", "光刻胶", "PTFE", "正交背板", "ABF", "载板"],
  },
  {
    id: "passive-components",
    branch: "MLCC/被动元件链",
    keywords: ["MLCC", "钽电容", "电容", "被动元件", "陶瓷粉体", "镍粉", "离型膜", "顺络", "风华", "三环", "国瓷"],
  },
  {
    id: "optical-upstream",
    branch: "光模块上游非成品链",
    keywords: ["光模块", "CPO", "NPO", "OCS", "InP", "CW光源", "FAU", "DFU", "保偏光纤", "测试设备", "硅光", "光芯片", "光通信"],
  },
  {
    id: "power-hvdc",
    branch: "电源管理/供电侧",
    keywords: ["AI电源", "电源管理", "HVDC", "SST", "800V", "DrMOS", "GaN", "软磁粉", "变压器", "AIDC", "Power Shelf", "VPD"],
  },
  {
    id: "storage-ai-data",
    branch: "存储/AI数据基础设施",
    keywords: ["存储", "SSD", "HDD", "HBM", "NAND", "长协", "数据湖", "KV cache", "内存池"],
  },
  {
    id: "robot-physical-ai",
    branch: "机器人/物理AI",
    keywords: ["机器人", "物理AI", "宇树", "Optimus", "传感器", "灵巧手", "减速器", "执行器"],
  },
]
const SELF_TRAIN_RULES = [
  "R1-concept-upgrade",
  "R2-concept-downgrade",
  "R3-pattern-solidify",
  "R4-cognitive-conflict",
  "R5-stale-validation-decay",
  "R6-error-guardrail-escalation",
  "R7-hypothesis-review",
]
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".avif",
  ".heic",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".exe",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".db",
  ".tmp",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
])

function normalizeRetrievalMode(mode) {
  const value = String(mode ?? "").trim().toLowerCase()
  if (value === RETRIEVAL_MODES.ASK || value === RETRIEVAL_MODES.INGEST) return value
  throw new Error(`Retrieval mode must be explicit: ${RETRIEVAL_MODES.ASK} or ${RETRIEVAL_MODES.INGEST}`)
}

const STOP_WORDS = new Set([
  "的",
  "是",
  "了",
  "什么",
  "在",
  "有",
  "和",
  "与",
  "对",
  "从",
  "这个",
  "一个",
  "以及",
  "进行",
  "the",
  "is",
  "a",
  "an",
  "what",
  "how",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "it",
  "its",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "this",
  "that",
  "these",
  "those",
])

const GENERIC_QUERY_TOKENS = new Set([
  "投资",
  "方向",
  "交易",
  "证据",
  "验证",
  "知识",
  "知识库",
  "已有",
  "反复",
  "哪些",
  "应该",
  "优先",
  "区分",
  "仍偏",
  "叙事",
  "环节",
  "标的",
  "节点",
  "最近",
  "一个月",
  "最近一个月",
  "产业",
  "链环",
  "要看",
  "来看",
])

const EVIDENCE_QUERY_TOKENS = new Set([
  "订单",
  "客户",
  "出货",
  "量价",
  "量产",
  "产能",
  "合同",
  "中标",
  "交付",
  "毛利",
  "价格",
  "涨价",
  "市占",
  "份额",
  "导入",
  "认证",
  "供应",
  "供应商",
  "客户节点",
  "验证节点",
  "出货量",
])

const TYPE_ALIASES = new Map(
  Object.entries({
    股票: "股票",
    个股档案: "股票",
    stock: "股票",
    stocks: "股票",
    entity: "股票",
    entities: "股票",
    概念: "概念",
    concept: "概念",
    concepts: "概念",
    策略: "策略",
    strategy: "策略",
    strategies: "策略",
    模式: "模式",
    市场模式: "模式",
    市场环境: "模式",
    进化: "模式",
    预测: "模式",
    pattern: "模式",
    patterns: "模式",
    错误: "错误",
    error: "错误",
    mistake: "错误",
    mistakes: "错误",
    人物: "人物",
    people: "人物",
    person: "人物",
    总结: "总结",
    分析: "总结",
    比较: "总结",
    synthesis: "总结",
    analysis: "总结",
    comparison: "总结",
    comparisons: "总结",
    查询: "查询",
    query: "查询",
    queries: "查询",
    源文档: "源文档",
    source: "源文档",
    sources: "源文档",
    事件: "事件",
    event: "事件",
    events: "事件",
  }),
)

const STATUS_ALIASES = new Map(
  Object.entries({
    活跃: "活跃",
    观察: "观察",
    归档: "归档",
    废弃: "废弃",
    迭代中: "迭代中",
    active: "活跃",
    watching: "观察",
    archived: "归档",
    deprecated: "废弃",
    iterating: "迭代中",
  }),
)

export function toPosixPath(input) {
  return input.replace(/\\/g, "/")
}

export function normalizePath(input) {
  return toPosixPath(path.resolve(input))
}

export function resolveProjectPathFromEnv(env = process.env) {
  const candidate =
    env.TRADING_WIKI_PROJECT?.trim() ||
    env.GANGTISE_MEETING_CLUES_PROJECT?.trim()
  return candidate ? normalizePath(candidate) : null
}

export function resolveProjectPath(options = {}, env = process.env) {
  const explicit = typeof options === "string" ? options : options.projectPath
  const candidate = String(explicit ?? "").trim() || resolveProjectPathFromEnv(env)
  if (!candidate) {
    throw new Error(
      `Missing wiki project path. Pass --project <path>, or set ${PROJECT_PATH_ENV_VARS.join(" / ")}.`,
    )
  }
  return normalizePath(candidate)
}

export function projectRelative(projectPath, targetPath) {
  return toPosixPath(path.relative(path.resolve(projectPath), path.resolve(targetPath)))
}

export function nowLocalTimestamp() {
  const d = new Date()
  const pad = (n) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function isTextSourcePath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return false
  return TEXT_EXTENSIONS.has(ext)
}

export async function readTextFile(filePath) {
  return fs.readFile(filePath, "utf8")
}

function truncateAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const boundary = Math.max(slice.lastIndexOf("\n- "), slice.lastIndexOf("\n## "), slice.lastIndexOf("\n【"))
  return `${slice.slice(0, boundary > maxChars * 0.55 ? boundary : maxChars).trimEnd()}\n...（本段因超大源文档做 prompt 压缩，完整证据见原始 raw 文件）`
}

function compactWechatSection(section, perSectionLimit) {
  const lines = section.split(/\r?\n/)
  const kept = []
  let skipOtherAttention = false
  let inCode = false
  let codeLines = 0

  for (const line of lines) {
    if (/^【其他关注】/.test(line)) {
      skipOtherAttention = true
      continue
    }
    if (/^【(?:市场情绪|重点板块\/标的|核心催化|完整调研原文)】/.test(line)) {
      skipOtherAttention = false
    }
    if (skipOtherAttention) {
      if (/^\s*原文：/.test(line) || /^\s*```/.test(line) || /^-\s*来源：/.test(line)) {
        skipOtherAttention = false
      } else if (/wx-cli|radar\.db|group_tags|local_id|chatroom|session|daemon|权限|last_success_at|stale|缺失核心群名|增量窗口/.test(line)) {
        continue
      }
    }

    if (/^\s*```/.test(line)) {
      inCode = !inCode
      codeLines = 0
      kept.push(line)
      continue
    }
    if (inCode) {
      codeLines += 1
      if (codeLines <= 45) kept.push(line)
      else if (codeLines === 46) kept.push("...（长原文节选，完整内容见 raw）")
      continue
    }
    if (/本半小时无显著新增舆情|本窗口内无新增可确认催化|本窗口内无新增完整调研类原文/.test(line)) continue
    kept.push(line)
  }

  return truncateAtBoundary(kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), perSectionLimit)
}

function stripHtmlForPrompt(text) {
  return String(text ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|h\d|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

function excerptForPrompt(text, maxChars) {
  const cleaned = stripHtmlForPrompt(text)
  if (cleaned.length <= maxChars) return cleaned
  if (maxChars <= 20) return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
  const budget = Math.max(1, maxChars - 3)
  const headChars = Math.max(1, Math.floor(budget * 0.62))
  const tailChars = Math.max(1, budget - headChars)
  return `${cleaned.slice(0, headChars).trimEnd()}...${cleaned.slice(-tailChars).trimStart()}`
}

function extractSectionAfterHeading(text, heading, stopHeadingRegex = /\n###? /) {
  const start = text.indexOf(heading)
  if (start < 0) return ""
  const bodyStart = start + heading.length
  const rest = text.slice(bodyStart)
  const stop = rest.search(stopHeadingRegex)
  return (stop >= 0 ? rest.slice(0, stop) : rest).trim()
}

function compactMeetingCluesContentForPrompt(sourceContent, sourcePath, sourceHash, maxChars) {
  const normalized = sourceContent.replace(/\r\n/g, "\n")
  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\n---\n/)
  const frontmatter = frontmatterMatch?.[0]?.trimEnd() ?? ""
  const overview = extractSectionAfterHeading(normalized, "## 今日概览")
  const detailStart = normalized.indexOf("\n## 明细")
  const details = detailStart >= 0 ? normalized.slice(detailStart) : normalized
  const records = details
    .split(/\n(?=### \d+\. )/)
    .map((s) => s.trim())
    .filter((s) => /^### \d+\. /.test(s))

  const overviewLimit = Math.min(Math.max(700, Math.floor(maxChars * 0.12)), 2400)
  const compactedOverview = overview ? excerptForPrompt(overview, overviewLimit) : "(missing 今日概览)"
  const intro = [
    frontmatter,
    "",
    "## 超大投研线索 prompt 压缩说明",
    "",
    `- 原始 sourcePath：${sourcePath}`,
    `- 原始 sourceHash：${sourceHash}`,
    `- 原始字符数：${sourceContent.length}`,
    `- 本段仅用于 Codex prompt：按每条 meeting clue 保留标题、发布时间、记录ID、主题/标的、detail_topic 和摘要/正文节选；manifest 和写入校验仍绑定原始 raw 文件。`,
    `- 保留记录数：${records.length}`,
    "",
    "## 今日概览",
    compactedOverview,
    "",
    "## 明细压缩版",
    "",
  ].join("\n")

  const buildRecord = (record, { excerptLimit, metaLimit, includePubTime, includeDetailTopic }) => {
    const lines = record.split("\n")
    const title = lines[0] ?? "### 记录"
    const pubTime = record.match(/^- 发布时间:\s*(.+)$/m)?.[1]?.trim()
    const recordId = record.match(/^- 记录 ID:\s*(.+)$/m)?.[1]?.trim()
    const topics = record.match(/^- 主题\/标的:\s*(.+)$/m)?.[1]?.trim()
    const detailTopic = record.match(/^- detail_topic:\s*([\s\S]*?)(?:\n\n#### |\n### |\n$)/)?.[1]?.trim()
    const aiSummary = extractSectionAfterHeading(record, "#### ai_summary", /\n#### |\n### /)
    const content = extractSectionAfterHeading(record, "#### content", /\n#### |\n### /)
    const preferred = aiSummary || content
    return [
      title,
      includePubTime && pubTime ? `- 发布时间: ${pubTime}` : "",
      recordId ? `- 记录 ID: ${recordId}` : "",
      topics ? `- 主题/标的: ${excerptForPrompt(topics, metaLimit)}` : "",
      includeDetailTopic && detailTopic && detailTopic !== "无"
        ? `- detail_topic: ${excerptForPrompt(detailTopic, Math.min(metaLimit, 220))}`
        : "",
      preferred ? `- 摘要/正文节选: ${excerptForPrompt(preferred, excerptLimit)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const buildCompacted = (options) => {
    const compactedRecords = records.map((record) => buildRecord(record, options))
    return `${intro}${compactedRecords.join("\n\n")}`
  }

  const budgetForRecords = Math.max(1000, maxChars - intro.length)
  const baseLimit = Math.max(80, Math.min(900, Math.floor(budgetForRecords / Math.max(1, records.length)) - 120))
  let options = {
    excerptLimit: baseLimit,
    metaLimit: Math.max(80, Math.min(240, baseLimit)),
    includePubTime: true,
    includeDetailTopic: true,
  }
  let compacted = buildCompacted(options)
  while (compacted.length > maxChars && options.excerptLimit > 80) {
    options = {
      ...options,
      excerptLimit: Math.max(80, Math.floor(options.excerptLimit * 0.7)),
      metaLimit: Math.max(80, Math.floor(options.metaLimit * 0.8)),
    }
    compacted = buildCompacted(options)
  }

  if (compacted.length <= maxChars) return compacted

  options = {
    excerptLimit: 45,
    metaLimit: 70,
    includePubTime: false,
    includeDetailTopic: false,
  }
  compacted = buildCompacted(options)
  while (compacted.length > maxChars && options.excerptLimit > 24) {
    options = {
      ...options,
      excerptLimit: Math.max(24, options.excerptLimit - 6),
      metaLimit: Math.max(48, options.metaLimit - 6),
    }
    compacted = buildCompacted(options)
  }
  return compacted.length <= maxChars ? compacted : truncateAtBoundary(compacted, maxChars)
}

export function compactSourceContentForPrompt(sourceContent, sourcePath, sourceHash, maxChars = SOURCE_PROMPT_CHAR_SOFT_LIMIT) {
  if (sourceContent.length <= maxChars) return sourceContent

  const normalized = sourceContent.replace(/\r\n/g, "\n")
  if (/source:\s*cn_alternative_db\.public\.gangtise_meeting_clues/.test(normalized)) {
    return compactMeetingCluesContentForPrompt(sourceContent, sourcePath, sourceHash, maxChars)
  }

  const headerEnd = normalized.search(/\n---\n\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  const header = headerEnd >= 0 ? normalized.slice(0, headerEnd + 5) : normalized.slice(0, 2500)
  const body = headerEnd >= 0 ? normalized.slice(headerEnd + 5) : normalized.slice(2500)
  const sections = body
    .split(/\n(?=## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 舆情更新)/)
    .map((s) => s.trim())
    .filter(Boolean)

  const informative = sections.filter((section) => {
    if (/本半小时无显著新增舆情/.test(section) && !/原文：|重点板块|核心催化|完整调研|强call|涨价|IPO|订单|发射|机器人|存储|光模块|电子布|工控|商业航天|半导体|算力|电力/.test(section)) {
      return false
    }
    if (/本窗口内未捕获到新增微信消息/.test(section) && !/原文：|来源：/.test(section)) return false
    return true
  })

  const budgetForSections = Math.max(12000, maxChars - header.length - 1200)
  const perSectionLimit = Math.max(1400, Math.floor(budgetForSections / Math.max(1, informative.length)))
  let compactedSections = informative.map((section) => compactWechatSection(section, perSectionLimit))
  let compacted = [
    header.trimEnd(),
    "",
    "## 超大源文档 prompt 压缩说明",
    "",
    `- 原始 sourcePath：${sourcePath}`,
    `- 原始 sourceHash：${sourceHash}`,
    `- 原始字符数：${sourceContent.length}`,
    `- 本段仅用于 Codex prompt：已剔除大量空窗口、wx-cli/radar 诊断噪声，并对超长原文做节选；manifest 和写入校验仍绑定原始 raw 文件。`,
    `- 保留窗口数：${compactedSections.length} / ${sections.length}`,
    "",
    ...compactedSections,
  ].join("\n")

  if (compacted.length <= maxChars) return compacted

  const tighterLimit = Math.max(900, Math.floor((budgetForSections * 0.75) / Math.max(1, informative.length)))
  compactedSections = informative.map((section) => compactWechatSection(section, tighterLimit))
  compacted = [
    header.trimEnd(),
    "",
    "## 超大源文档 prompt 压缩说明",
    "",
    `- 原始 sourcePath：${sourcePath}`,
    `- 原始 sourceHash：${sourceHash}`,
    `- 原始字符数：${sourceContent.length}`,
    `- 本段仅用于 Codex prompt：已剔除大量空窗口、wx-cli/radar 诊断噪声，并对超长原文做节选；manifest 和写入校验仍绑定原始 raw 文件。`,
    `- 保留窗口数：${compactedSections.length} / ${sections.length}`,
    "",
    ...compactedSections,
  ].join("\n")
  return truncateAtBoundary(compacted, maxChars)
}

async function readIfExists(filePath) {
  try {
    return await readTextFile(filePath)
  } catch {
    return ""
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex")
}

export function shortHash(text) {
  return sha256Hex(text).slice(0, 16)
}

function makeReportId(sourcePath) {
  const safeName = path.basename(sourcePath).replace(/[^\p{L}\p{N}._-]+/gu, "-")
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}`
}

async function writeJson(filePath, data) {
  await ensureDirectory(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

async function appendJsonl(filePath, record) {
  await ensureDirectory(path.dirname(filePath))
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8")
}

async function readJsonlFile(filePath) {
  const raw = await readIfExists(filePath)
  if (!raw.trim()) return []
  const records = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push({ value: JSON.parse(line), line: i + 1 })
    } catch {
      records.push({ value: line, line: i + 1, parseError: true })
    }
  }
  return records
}

function isObjectRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function stableJsonString(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonString(item)).join(",")}]`
  if (isObjectRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJsonString(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function normalizeFactRefList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === "string") {
    return value
      .split(/[,\s，、]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeTemporalFactStatus(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return "active"
  const lower = raw.toLowerCase()
  if (["active", "current", "valid", "pending", "observed"].includes(lower) || ["活跃", "当前", "有效", "观察", "待验证"].includes(raw)) {
    return "active"
  }
  if (["superseded", "replaced"].includes(lower) || ["被替代", "已替代"].includes(raw)) return "superseded"
  if (["invalidated", "contradicted", "retracted", "false"].includes(lower) || ["证伪", "被证伪", "失效", "已失效", "撤回"].includes(raw)) {
    return "invalidated"
  }
  if (["expired", "stale"].includes(lower) || ["过期", "陈旧"].includes(raw)) return "expired"
  return lower
}

function normalizeTemporalFactEvidenceLevel(value) {
  const raw = String(value ?? "").trim().toUpperCase()
  return raw && TEMPORAL_FACT_EVIDENCE_LEVELS.includes(raw) ? raw : raw || null
}

function normalizeTemporalFactSourceKind(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_") || null
}

function normalizeTemporalFactPredicate(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[-\s]+/g, "_")
}

function normalizeEntityAlias(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")
    .pop()
    .replace(/^wiki\//, "")
    .replace(/^(?:股票|概念|事件|模式|策略|错误)\//, "")
    .replace(/\.(?:md|markdown)$/i, "")
    .replace(/[（(]\s*(?:SZ|SH|BJ)?\d{6}(?:\.(?:SZ|SH|BJ))?\s*[）)]/gi, "")
    .replace(/\s+/g, "")
  return raw
}

function normalizeEntitySearchText(value) {
  return String(value ?? "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$1 $2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, "")
    .toLowerCase()
}

function entityKeyForSubject(subject, stockCode = null) {
  const code = normalizeStockCode(stockCode)
  if (code) return `stock:${code}`
  const normalized = normalizeEntityAlias(subject).toLowerCase()
  return normalized ? `entity:${normalized}` : null
}

function addEntityLookupAlias(lookup, alias, info) {
  const normalized = normalizeEntityAlias(alias)
  if (!normalized) return
  lookup.aliases.set(normalized.toLowerCase(), info)
}

async function loadTemporalEntityLookup(projectPath) {
  const pp = normalizePath(projectPath)
  const lookup = { aliases: new Map(), byKey: new Map() }
  const add = ({ subject, stockCode = null, aliases = [], wikiPath = null }) => {
    const canonicalSubject = normalizeEntityAlias(subject)
    if (!canonicalSubject) return null
    const normalizedCode = normalizeStockCode(stockCode)
    const entityKey = entityKeyForSubject(canonicalSubject, normalizedCode)
    if (!entityKey) return null
    const existing = lookup.byKey.get(entityKey)
    const mergedAliases = [...new Set([...(existing?.aliases ?? []), canonicalSubject, ...aliases.map(normalizeEntityAlias).filter(Boolean)])]
    const info = {
      entityKey,
      canonicalSubject: existing?.canonicalSubject ?? canonicalSubject,
      stockCode: existing?.stockCode ?? normalizedCode ?? null,
      aliases: mergedAliases,
      wikiPath: existing?.wikiPath ?? wikiPath ?? null,
    }
    lookup.byKey.set(entityKey, info)
    addEntityLookupAlias(lookup, canonicalSubject, info)
    if (normalizedCode) {
      addEntityLookupAlias(lookup, normalizedCode, info)
      addEntityLookupAlias(lookup, normalizedCode.replace(/^(SZ|SH|BJ)/, ""), info)
    }
    for (const alias of mergedAliases) addEntityLookupAlias(lookup, alias, info)
    return info
  }

  try {
    const raw = await fs.readFile(path.join(pp, ".llm-wiki", "stock-codes.json"), "utf8")
    const parsed = JSON.parse(raw)
    for (const [name, code] of Object.entries(parsed.mapping ?? {})) {
      add({ subject: name, stockCode: code })
    }
  } catch {}

  const stockFiles = await listFilesRecursive(path.join(pp, "wiki", "股票"), {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
  }).catch(() => [])
  for (const filePath of stockFiles) {
    try {
      const content = await fs.readFile(filePath, "utf8")
      const { fm } = parseFrontmatter(content)
      const wikiPath = projectRelative(pp, filePath)
      const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : path.basename(filePath, ".md")
      const aliases = Array.isArray(fm.aliases) ? fm.aliases : []
      add({ subject: title, stockCode: fm.code, aliases, wikiPath })
    } catch {}
  }

  return lookup
}

function resolveTemporalEntity(record, lookup) {
  const rawSubject = record.subject ?? record.entity ?? record.canonicalSubject ?? record.name ?? ""
  const explicitCode = normalizeStockCode(record.stockCode ?? record.code ?? record.ticker)
  if (explicitCode) {
    const key = `stock:${explicitCode}`
    const found = lookup.byKey.get(key)
    if (found) return found
    const subject = normalizeEntityAlias(rawSubject) || explicitCode
    return { entityKey: key, canonicalSubject: subject, stockCode: explicitCode, aliases: [subject, explicitCode], wikiPath: null }
  }
  const normalizedSubject = normalizeEntityAlias(rawSubject)
  const found = normalizedSubject ? lookup.aliases.get(normalizedSubject.toLowerCase()) : null
  if (found) return found
  const entityKey = entityKeyForSubject(normalizedSubject)
  return entityKey ? { entityKey, canonicalSubject: normalizedSubject, stockCode: null, aliases: normalizedSubject ? [normalizedSubject] : [], wikiPath: null } : null
}

function normalizeTemporalFactRecord(record, lookup) {
  const entity = resolveTemporalEntity(record, lookup)
  const subject = entity?.canonicalSubject ?? normalizeEntityAlias(record.subject ?? record.entity ?? record.canonicalSubject ?? "")
  const normalized = {
    ...record,
    type: record.type ?? "temporal_fact",
    status: normalizeTemporalFactStatus(record.status),
    subject: subject || record.subject,
    canonicalSubject: record.canonicalSubject ?? entity?.canonicalSubject ?? subject ?? null,
    entityKey: record.entityKey ?? entity?.entityKey ?? entityKeyForSubject(subject, record.stockCode ?? record.code ?? record.ticker),
    stockCode: normalizeStockCode(record.stockCode ?? record.code ?? record.ticker) ?? entity?.stockCode ?? null,
    aliases: [...new Set([...(Array.isArray(record.aliases) ? record.aliases.map(normalizeEntityAlias).filter(Boolean) : []), ...(entity?.aliases ?? [])])],
    wikiPath: record.wikiPath ?? entity?.wikiPath ?? null,
  }
  if (!normalized.id) normalized.id = temporalFactId(normalized)
  return normalized
}

function temporalFactIdentity(record) {
  const identity = {
    subject: record.subject ?? record.entity ?? null,
    canonicalSubject: record.canonicalSubject ?? null,
    entityKey: record.entityKey ?? null,
    stockCode: record.stockCode ?? null,
    predicate: record.predicate ?? record.relation ?? record.edgeType ?? null,
    object: record.object ?? record.target ?? record.value ?? null,
    claim: record.claim ?? record.text ?? record.summary ?? null,
    validAt: record.validAt ?? record.asOf ?? record.date ?? null,
    status: normalizeTemporalFactStatus(record.status),
    supersedes: normalizeFactRefList(record.supersedes),
    invalidates: normalizeFactRefList(record.invalidates),
    contradicts: normalizeFactRefList(record.contradicts),
    sourcePath: record.sourcePath ?? record.source ?? null,
    sourceHash: record.sourceHash ?? null,
    wikiPath: record.wikiPath ?? null,
  }
  if (Object.values(identity).some((value) => value != null && String(value).trim() !== "")) {
    return stableJsonString(identity)
  }
  const fallback = { ...record }
  delete fallback.id
  delete fallback.createdAt
  delete fallback.updatedAt
  return stableJsonString(fallback)
}

function temporalFactId(record) {
  return `tf_${shortHash(temporalFactIdentity(record))}`
}

function isTemporalFactRecord(record) {
  return isObjectRecord(record) && (record.type === "temporal_fact" || record.temporal === true || record.validAt || record.supersedes || record.invalidates || record.contradicts)
}

function assertSafeTemporalFactsPath(relativePath) {
  const normalized = toPosixPath(String(relativePath ?? TEMPORAL_FACTS_RELATIVE_PATH)).replace(/^\/+/, "")
  if (normalized.includes("..")) throw new Error(`Refusing temporal fact path traversal: ${relativePath}`)
  if (normalized !== TEMPORAL_FACTS_RELATIVE_PATH) {
    throw new Error(`Temporal facts must be written only to ${TEMPORAL_FACTS_RELATIVE_PATH}: ${relativePath}`)
  }
  return normalized
}

function normalizeManifestFactWrites(manifest) {
  const factWrites = manifest.factWrites ?? manifest.facts ?? []
  if (!Array.isArray(factWrites)) throw new Error("Manifest factWrites must be an array when present")
  return factWrites.map((raw, index) => {
    if (!isObjectRecord(raw)) throw new Error(`Invalid factWrites[${index}]: expected an object`)
    const relativePath = assertSafeTemporalFactsPath(raw.targetPath ?? raw.relativePath ?? raw.filePath ?? raw.file ?? raw.path ?? TEMPORAL_FACTS_RELATIVE_PATH)
    let payload
    if (isObjectRecord(raw.fact)) {
      payload = { ...raw.fact }
    } else if (isObjectRecord(raw.record)) {
      payload = { ...raw.record }
    } else if (isObjectRecord(raw.content)) {
      payload = { ...raw.content }
    } else {
      payload = { ...raw }
      delete payload.action
      delete payload.targetPath
      delete payload.relativePath
      delete payload.filePath
      delete payload.file
      delete payload.path
      delete payload.content
    }
    const record = {
      ...payload,
      type: payload.type ?? "temporal_fact",
      status: normalizeTemporalFactStatus(payload.status),
      predicate: normalizeTemporalFactPredicate(payload.predicate ?? payload.relation ?? payload.edgeType),
      evidenceLevel: normalizeTemporalFactEvidenceLevel(payload.evidenceLevel ?? payload.evidence_level),
      sourceKind: normalizeTemporalFactSourceKind(payload.sourceKind ?? payload.source_kind),
      sourceHash: payload.sourceHash ?? manifest.sourceHash ?? null,
      sourcePath: payload.sourcePath ?? payload.source ?? manifest.sourcePath ?? null,
      createdAt: payload.createdAt ?? nowLocalTimestamp(),
    }
    if (payload.id) record.id = payload.id
    return {
      action: raw.action ?? "append",
      path: relativePath,
      record,
      identity: temporalFactIdentity(record),
    }
  })
}

async function readTemporalFactEntries(projectPath, entityLookup = null) {
  const filePath = path.join(normalizePath(projectPath), TEMPORAL_FACTS_RELATIVE_PATH)
  entityLookup = entityLookup ?? await loadTemporalEntityLookup(projectPath)
  const entries = (await readJsonlFile(filePath)).map((entry) => ({
    ...entry,
    value: isObjectRecord(entry.value) ? normalizeTemporalFactRecord(entry.value, entityLookup) : entry.value,
  }))
  const statusById = new Map()
  const statusByIdentity = new Map()

  for (const entry of entries) {
    const record = entry.value
    if (!isObjectRecord(record)) continue
    const sourceId = record.id ? String(record.id) : null
    const supersededRefs = normalizeFactRefList(record.supersedes)
    const invalidatedRefs = [
      ...normalizeFactRefList(record.invalidates),
      ...normalizeFactRefList(record.contradicts),
      ...normalizeFactRefList(record.contradictedFacts),
    ]
    for (const ref of supersededRefs) statusById.set(ref, { status: "superseded", by: sourceId, line: entry.line })
    for (const ref of invalidatedRefs) statusById.set(ref, { status: "invalidated", by: sourceId, line: entry.line })
    for (const ref of normalizeFactRefList(record.supersedesIdentity)) statusByIdentity.set(ref, { status: "superseded", by: sourceId, line: entry.line })
    for (const ref of normalizeFactRefList(record.invalidatesIdentity)) statusByIdentity.set(ref, { status: "invalidated", by: sourceId, line: entry.line })
  }

  return entries.map((entry) => {
    const record = entry.value
    if (!isObjectRecord(record)) return { ...entry, status: "invalidated", statusReason: null, identity: null }
    const identity = temporalFactIdentity(record)
    const explicitStatus = normalizeTemporalFactStatus(record.status)
    const linkStatus = (record.id ? statusById.get(String(record.id)) : null) ?? statusByIdentity.get(identity)
    let status = explicitStatus
    let statusReason = null
    if (record.supersededBy || record.replacedBy) status = "superseded"
    if (record.invalidatedBy || record.contradictedBy || record.retractedAt || record.invalidatedAt || record.expiredAt) status = status === "superseded" ? status : "invalidated"
    if (linkStatus) {
      status = linkStatus.status
      statusReason = linkStatus
    }
    return { ...entry, status, statusReason, identity }
  })
}

async function planTemporalFactWrites(projectPath, factWrites) {
  const entityLookup = await loadTemporalEntityLookup(projectPath)
  factWrites = factWrites.map((item) => {
    const record = normalizeTemporalFactRecord(item.record, entityLookup)
    return {
      ...item,
      record,
      identity: temporalFactIdentity(record),
    }
  })
  const existingEntries = await readTemporalFactEntries(projectPath, entityLookup)
  const existingIds = new Map()
  const existingIdentities = new Map()
  for (const entry of existingEntries) {
    if (!isObjectRecord(entry.value)) continue
    if (entry.value.id) existingIds.set(String(entry.value.id), entry)
    if (entry.identity) existingIdentities.set(entry.identity, entry)
  }

  const plannedFactWrites = []
  const duplicateFacts = []
  const pendingIds = new Set(existingIds.keys())
  const pendingIdentities = new Set(existingIdentities.keys())

  for (const item of factWrites) {
    const id = String(item.record.id)
    const duplicateEntry = existingIds.get(id) ?? existingIdentities.get(item.identity)
    if (duplicateEntry || pendingIds.has(id) || pendingIdentities.has(item.identity)) {
      duplicateFacts.push({
        id,
        path: item.path,
        line: duplicateEntry?.line ?? null,
        reason: duplicateEntry ? "already_present" : "duplicate_in_manifest",
      })
      continue
    }
    plannedFactWrites.push(item)
    pendingIds.add(id)
    pendingIdentities.add(item.identity)
  }

  const supersededFacts = []
  const invalidatedFacts = []
  const collectRefs = (record, fields) => fields.flatMap((field) => normalizeFactRefList(record[field]))
  for (const item of plannedFactWrites) {
    for (const ref of collectRefs(item.record, ["supersedes"])) {
      const existing = existingIds.get(ref) ?? existingIdentities.get(ref)
      supersededFacts.push({
        id: ref,
        by: item.record.id,
        path: TEMPORAL_FACTS_RELATIVE_PATH,
        line: existing?.line ?? null,
        found: Boolean(existing),
      })
    }
    for (const ref of collectRefs(item.record, ["invalidates", "contradicts", "contradictedFacts"])) {
      const existing = existingIds.get(ref) ?? existingIdentities.get(ref)
      invalidatedFacts.push({
        id: ref,
        by: item.record.id,
        path: TEMPORAL_FACTS_RELATIVE_PATH,
        line: existing?.line ?? null,
        found: Boolean(existing),
      })
    }
  }

  return {
    plannedFactWrites,
    duplicateFacts,
    supersededFacts,
    invalidatedFacts,
  }
}

function makeTemporalFactIssue(item, field, message, fatal = false) {
  return {
    path: item.path,
    id: item.record?.id ?? null,
    field,
    message,
    fatal,
  }
}

function validateTemporalFactWrite(item) {
  const record = item.record ?? {}
  const issues = []
  const subject = String(record.subject ?? record.canonicalSubject ?? "").trim()
  const predicate = normalizeTemporalFactPredicate(record.predicate)
  const claim = String(record.claim ?? record.text ?? record.summary ?? "").trim()
  const status = normalizeTemporalFactStatus(record.status)
  const evidenceLevel = normalizeTemporalFactEvidenceLevel(record.evidenceLevel)
  const sourceKind = normalizeTemporalFactSourceKind(record.sourceKind)

  if (!subject) issues.push(makeTemporalFactIssue(item, "subject", "Temporal fact must include subject/canonicalSubject.", true))
  if (!predicate) issues.push(makeTemporalFactIssue(item, "predicate", "Temporal fact must include predicate.", true))
  else if (!TEMPORAL_FACT_PREDICATES.includes(predicate)) {
    issues.push(makeTemporalFactIssue(item, "predicate", `Unknown temporal fact predicate: ${predicate}. See docs/temporal-facts-v1.md.`, true))
  }
  if (!claim) issues.push(makeTemporalFactIssue(item, "claim", "Temporal fact must include a one-sentence claim.", true))
  else if (charLength(claim) > 220) {
    issues.push(makeTemporalFactIssue(item, "claim", "Claim is too long for an atomic fact; split it into smaller factWrites.", false))
  }
  if (!TEMPORAL_FACT_STATUSES.includes(status)) {
    issues.push(makeTemporalFactIssue(item, "status", `Unknown temporal fact status: ${status}.`, true))
  }
  if (!record.validAt && !record.eventDate && !record.sourceDate && !record.observedAt) {
    issues.push(makeTemporalFactIssue(item, "validAt", "Temporal fact should include validAt, eventDate, sourceDate, or observedAt.", false))
  }
  if (!evidenceLevel) {
    issues.push(makeTemporalFactIssue(item, "evidenceLevel", "Temporal fact should include evidenceLevel A/B/C/D.", false))
  } else if (!TEMPORAL_FACT_EVIDENCE_LEVELS.includes(evidenceLevel)) {
    issues.push(makeTemporalFactIssue(item, "evidenceLevel", `Unknown evidenceLevel: ${evidenceLevel}.`, true))
  }
  if (!sourceKind) {
    issues.push(makeTemporalFactIssue(item, "sourceKind", "Temporal fact should include sourceKind.", false))
  } else if (!TEMPORAL_FACT_SOURCE_KINDS.includes(sourceKind)) {
    issues.push(makeTemporalFactIssue(item, "sourceKind", `Unknown sourceKind: ${sourceKind}.`, true))
  }
  if (!record.sourcePath) issues.push(makeTemporalFactIssue(item, "sourcePath", "Temporal fact should carry sourcePath for audit.", false))
  if (!record.sourceHash) issues.push(makeTemporalFactIssue(item, "sourceHash", "Temporal fact should carry sourceHash for replay safety.", false))
  if (status === "active" && (evidenceLevel === "C" || evidenceLevel === "D")) {
    issues.push(makeTemporalFactIssue(item, "evidenceLevel", "C/D evidence may be active only as a weak/pending claim; keep claim wording explicit and avoid treating it as confirmed.", false))
  }
  if (status === "active" && sourceKind === "social_chat") {
    issues.push(makeTemporalFactIssue(item, "sourceKind", "social_chat facts should be worded as rumor/watchlist/pending, not confirmed fact.", false))
  }
  if ((predicate === "CONTRADICTS" || status === "invalidated" || status === "superseded") && !normalizeFactRefList(record.supersedes).length && !normalizeFactRefList(record.invalidates).length && !normalizeFactRefList(record.contradicts).length) {
    issues.push(makeTemporalFactIssue(item, "supersedes", "Contradiction/replacement facts should reference old fact ids through supersedes, invalidates, or contradicts when available.", false))
  }
  return issues
}

function validateTemporalFactPlan(factPlan) {
  return factPlan.plannedFactWrites.flatMap((item) => validateTemporalFactWrite(item))
}

function compactTemporalFactEntry(entry) {
  const record = entry.value
  return {
    id: record.id ?? null,
    line: entry.line,
    status: entry.status,
    entityKey: record.entityKey ?? null,
    canonicalSubject: record.canonicalSubject ?? record.subject ?? null,
    stockCode: record.stockCode ?? null,
    predicate: record.predicate ?? record.relation ?? record.edgeType ?? null,
    object: record.object ?? record.target ?? record.value ?? null,
    claim: record.claim ?? record.text ?? record.summary ?? null,
    validAt: record.validAt ?? record.asOf ?? record.date ?? null,
    sourcePath: record.sourcePath ?? record.source ?? null,
    wikiPath: record.wikiPath ?? null,
    supersedes: normalizeFactRefList(record.supersedes),
    invalidates: normalizeFactRefList(record.invalidates),
    contradicts: normalizeFactRefList(record.contradicts),
  }
}

function extractTemporalEntityCandidates(sourceContent, sourcePath, candidates, lookup, maxItems = 24) {
  const sourceText = `${path.basename(sourcePath)}\n${String(sourceContent ?? "")}`
  const normalizedSource = normalizeEntitySearchText(sourceText)
  const scores = new Map()

  const bump = (info, score, reason) => {
    if (!info?.entityKey) return
    const existing = scores.get(info.entityKey) ?? { ...info, score: 0, reasons: [] }
    existing.score += score
    if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason)
    scores.set(info.entityKey, existing)
  }

  for (const info of lookup.byKey.values()) {
    for (const alias of info.aliases ?? []) {
      const normalizedAlias = normalizeEntityAlias(alias).toLowerCase()
      if (normalizedAlias && normalizedSource.includes(normalizedAlias)) {
        bump(info, normalizedAlias.length >= 4 ? 4 : 2, `source_alias:${alias}`)
      }
    }
    for (const code of stockCodeAlternatives(info.stockCode)) {
      if (code && String(sourceContent ?? "").toUpperCase().includes(code.toUpperCase())) bump(info, 5, `source_code:${code}`)
    }
  }

  for (const item of candidates?.wikiCandidates ?? []) {
    if (!String(item.path ?? "").startsWith("wiki/股票/")) continue
    const info = resolveTemporalEntity({ subject: item.title ?? path.basename(item.path, ".md") }, lookup)
    bump(info, 3, `wiki_candidate:${item.path}`)
  }

  for (const segment of candidates?.segments ?? []) {
    const segmentInfo = resolveTemporalEntity({ subject: segment.title }, lookup)
    bump(segmentInfo, 1.5, `segment:${segment.id}`)
    for (const item of segment.wikiCandidates ?? []) {
      if (!String(item.path ?? "").startsWith("wiki/股票/")) continue
      const info = resolveTemporalEntity({ subject: item.title ?? path.basename(item.path, ".md") }, lookup)
      bump(info, 2, `segment_wiki:${segment.id}`)
    }
  }

  for (const match of String(sourceContent ?? "").matchAll(/\b(?:SZ|SH|BJ)?\d{6}(?:\.(?:SZ|SH|BJ))?\b/gi)) {
    const code = normalizeStockCode(match[0])
    const info = code ? lookup.byKey.get(`stock:${code}`) ?? { entityKey: `stock:${code}`, canonicalSubject: code, stockCode: code, aliases: [code], wikiPath: null } : null
    bump(info, 4, `code:${match[0]}`)
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.canonicalSubject.localeCompare(b.canonicalSubject))
    .slice(0, maxItems)
    .map((item) => ({
      entityKey: item.entityKey,
      canonicalSubject: item.canonicalSubject,
      stockCode: item.stockCode ?? null,
      aliases: (item.aliases ?? []).slice(0, 8),
      wikiPath: item.wikiPath ?? null,
      score: Number(item.score.toFixed(2)),
      reasons: item.reasons.slice(0, 6),
    }))
}

function scoreTemporalFactEntry(entry, tokens, entityKeys) {
  const record = entry.value
  if (!isObjectRecord(record)) return 0
  const text = `${record.entityKey ?? ""}\n${record.canonicalSubject ?? ""}\n${jsonLineSearchText(record)}`
  let score = tokenMatchScore(text, tokens)
  if (record.entityKey && entityKeys.has(record.entityKey)) score += 8
  if (entry.status === "active") score += 1
  else score += 0.25
  if (score > 0 && record.validAt) score += Math.max(0, getRecencyBoost(String(record.validAt), "最近"))
  return score
}

function relatedTemporalFactsForText(entries, text, sourcePath, entityCandidates, maxItems = 12) {
  const tokens = extractSourceTokens(text, sourcePath, 90)
  const entityKeys = new Set(entityCandidates.map((item) => item.entityKey).filter(Boolean))
  return entries
    .map((entry) => ({ entry, score: scoreTemporalFactEntry(entry, tokens, entityKeys) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.line - b.entry.line)
    .slice(0, maxItems)
    .map(({ entry, score }) => ({
      ...compactTemporalFactEntry(entry),
      score: Number(score.toFixed(2)),
    }))
}

function buildSegmentFactSeeds({ sourcePath, segments, entries, lookup, maxSegments = 12 }) {
  return (segments ?? []).slice(0, maxSegments).map((segment) => {
    const segmentText = segment.searchText ?? segment.text ?? segment.textPreview ?? segment.title
    const entityCandidates = extractTemporalEntityCandidates(segmentText, `${sourcePath}#${segment.id}`, { wikiCandidates: segment.wikiCandidates ?? [], segments: [] }, lookup, 8)
    return {
      id: segment.id,
      title: segment.title,
      heat: segment.heat || "",
      lineStart: segment.lineStart,
      lineEnd: segment.lineEnd,
      textPreview: segment.textPreview,
      tokens: extractSourceTokens(segmentText, `${sourcePath}#${segment.id}`, 24),
      entityCandidates,
      relatedFacts: relatedTemporalFactsForText(entries, segmentText, `${sourcePath}#${segment.id}`, entityCandidates, 6),
    }
  })
}

async function buildTemporalFactContext({ projectPath, sourcePath, sourceContent, candidates, options = {} }) {
  const lookup = await loadTemporalEntityLookup(projectPath)
  const entries = await readTemporalFactEntries(projectPath, lookup)
  const entityCandidates = extractTemporalEntityCandidates(sourceContent, sourcePath, candidates, lookup, options.maxEntities ?? 24)
  const relatedFacts = relatedTemporalFactsForText(entries, sourceContent, sourcePath, entityCandidates, options.maxFacts ?? 18)
  const segmentFactSeeds = buildSegmentFactSeeds({
    sourcePath,
    segments: candidates?.segments ?? [],
    entries,
    lookup,
    maxSegments: options.maxSegments ?? INGEST_SEGMENT_DEFAULT_MAX,
  })
  return {
    factsPath: TEMPORAL_FACTS_RELATIVE_PATH,
    indexPath: TEMPORAL_FACT_INDEX_RELATIVE_PATH,
    counts: {
      totalFacts: entries.filter((entry) => isObjectRecord(entry.value)).length,
      activeFacts: entries.filter((entry) => isObjectRecord(entry.value) && entry.status === "active").length,
      inactiveFacts: entries.filter((entry) => isObjectRecord(entry.value) && entry.status !== "active").length,
      entityCandidates: entityCandidates.length,
      relatedFacts: relatedFacts.length,
      segmentFactSeeds: segmentFactSeeds.length,
    },
    entityCandidates,
    relatedFacts,
    segmentFactSeeds,
  }
}

async function buildTemporalFactsIndex(projectPath) {
  const entries = await readTemporalFactEntries(projectPath)
  const facts = entries
    .filter((entry) => isObjectRecord(entry.value))
    .map((entry) => compactTemporalFactEntry(entry))
  const entities = new Map()
  for (const fact of facts) {
    const key = fact.entityKey ?? entityKeyForSubject(fact.canonicalSubject)
    if (!key) continue
    const existing = entities.get(key) ?? {
      entityKey: key,
      canonicalSubject: fact.canonicalSubject,
      stockCode: fact.stockCode ?? null,
      activeFactIds: [],
      inactiveFactIds: [],
      predicates: [],
      lastValidAt: null,
    }
    if (fact.status === "active") existing.activeFactIds.push(fact.id)
    else existing.inactiveFactIds.push(fact.id)
    if (fact.predicate && !existing.predicates.includes(fact.predicate)) existing.predicates.push(fact.predicate)
    if (fact.validAt && (!existing.lastValidAt || String(fact.validAt) > String(existing.lastValidAt))) existing.lastValidAt = fact.validAt
    entities.set(key, existing)
  }
  const activeFacts = facts.filter((fact) => fact.status === "active").length
  return {
    version: 1,
    generatedAt: nowLocalTimestamp(),
    factsPath: TEMPORAL_FACTS_RELATIVE_PATH,
    counts: {
      totalFacts: facts.length,
      activeFacts,
      inactiveFacts: facts.length - activeFacts,
      entities: entities.size,
    },
    entities: Object.fromEntries([...entities.entries()].sort(([a], [b]) => a.localeCompare(b))),
    facts,
  }
}

async function writeTemporalFactsIndex(projectPath) {
  const index = await buildTemporalFactsIndex(projectPath)
  await writeJson(path.join(normalizePath(projectPath), TEMPORAL_FACT_INDEX_RELATIVE_PATH), index)
  return {
    path: TEMPORAL_FACT_INDEX_RELATIVE_PATH,
    counts: index.counts,
  }
}

const TEMPORAL_FACT_AUDIT_ROOT = ".llm-wiki/temporal-facts"
const TEMPORAL_PREDICATE_AUDIT_RULES = [
  { suggestedPredicate: "HAS_CATALYST", terms: ["催化", "催化剂", "事件驱动", "发布会", "新品发布", "政策预期"] },
  {
    suggestedPredicate: "HAS_ORDER",
    candidatePredicates: ["HAS_ORDER_RUMOR", "HAS_CONFIRMED_ORDER"],
    terms: ["订单"],
    reviewNote: "订单是歧义词，需按信源和上下文区分传闻、意向、确认订单。",
  },
  { suggestedPredicate: "HAS_ORDER_RUMOR", terms: ["小作文", "群聊截图", "加单传闻", "未确认订单", "传闻订单"], reviewNote: "传闻、群聊、小作文只能作为待验证订单观察。" },
  { suggestedPredicate: "HAS_ORDER_INTENT", terms: ["定点", "客户意向", "送样后预计导入"], reviewNote: "客户意向或定点不等于正式订单。" },
  { suggestedPredicate: "HAS_CONFIRMED_ORDER", terms: ["中标", "合同", "正式订单", "公告订单", "项目落地"], reviewNote: "需要公告、合同、中标或等价强信源支撑。" },
  { suggestedPredicate: "HAS_DELIVERY_VALIDATION", terms: ["批量供货", "持续交付", "放量出货"], reviewNote: "交付放量比订单传闻更接近产业兑现。" },
  { suggestedPredicate: "CUSTOMER_VALIDATED", terms: ["客户", "供应客户", "进入供应链", "供应链", "下游客户", "绑定客户"] },
  { suggestedPredicate: "HAS_CAPACITY", terms: ["产能", "扩产", "投产", "产线", "产量", "稼动率"] },
  { suggestedPredicate: "PRICE_VALIDATED", terms: ["涨价", "提价", "报价", "价格", "ASP", "涨价落地"] },
  { suggestedPredicate: "HAS_POLICY_SUPPORT", terms: ["政策", "补贴", "规划", "文件", "产业政策", "目录"] },
  { suggestedPredicate: "HAS_PRODUCT", terms: ["产品", "材料", "设备", "工艺", "业务线", "新品"] },
  { suggestedPredicate: "VOLUME_VALIDATED", terms: ["放量", "产量", "稼动率"] },
  { suggestedPredicate: "TECH_VALIDATED", terms: ["认证", "样品", "量产", "良率", "验证通过"] },
  { suggestedPredicate: "FUNDAMENTAL_VALIDATED", terms: ["兑现", "业绩兑现", "财报映射", "订单转收入"] },
  { suggestedPredicate: "HAS_TECH_PROGRESS", terms: ["技术"] },
  { suggestedPredicate: "HAS_SUPPLY_CONSTRAINT", terms: ["缺货", "紧缺", "瓶颈", "供给约束", "卡脖子", "扩产瓶颈"] },
  {
    suggestedPredicate: "HAS_VALIDATION_SIGNAL",
    candidatePredicates: ["PRICE_VALIDATED", "VOLUME_VALIDATED", "CUSTOMER_VALIDATED", "TECH_VALIDATED", "FUNDAMENTAL_VALIDATED"],
    terms: ["验证", "反馈", "确认", "量价验证"],
    reviewNote: "泛验证词需要进一步拆成价格、量、客户、技术或财报兑现。",
  },
  { suggestedPredicate: "HAS_RISK", terms: ["风险"] },
  { suggestedPredicate: "HAS_CLARIFICATION_RISK", terms: ["澄清", "否认", "未确认", "撤回", "口径冲突", "不属实"] },
  { suggestedPredicate: "HAS_COMPETITION_RISK", terms: ["竞争", "替代风险", "同业扩产"] },
  { suggestedPredicate: "HAS_DEMAND_RISK", terms: ["不及预期", "下修", "降价", "需求不及预期", "价格下修", "订单下修"] },
  { suggestedPredicate: "HAS_SUPPLY_CHAIN_RISK", terms: ["良率风险", "供应链卡点", "良率不达标", "扩产不及预期"] },
  { suggestedPredicate: "HAS_VALUATION_RISK", terms: ["透支", "预期兑现", "高开低走", "追高", "利好集中兑现"] },
  { suggestedPredicate: "CONTRADICTS", terms: ["证伪", "反证"] },
]

const TEMPORAL_AUDIT_TAG_PROMOTE_CONCEPTS = new Set([
  "国产替代", "AI服务器", "PCB", "先进封装", "商业航天", "光模块", "数据中心", "AI算力",
  "CPO", "AI硬件", "液冷", "半导体设备", "存储", "半导体", "半导体材料", "光通信",
  "AIDC", "MLCC", "国产算力", "玻璃基板", "算力租赁", "HBM", "消费电子", "人形机器人",
  "储能", "CCL", "具身智能", "智能驾驶", "mSAP", "光互联", "物理AI", "电子布",
  "硅光", "创新药", "固态电池", "涨价链", "Rubin", "AI眼镜", "NPO", "TGV",
  "SST", "AI电源",
].map((item) => normalizeEntityAlias(item).toLowerCase()))

const TEMPORAL_AUDIT_TAG_METADATA_ONLY = new Set([
  "Gangtise", "行业复盘", "行业晨报", "微信舆情", "周末舆情", "股票", "港股", "科技",
  "AI", "L4执行", "L4执行控制", "涨价", "小作文", "Call", "IPO", "Q1", "Q2", "Q3",
].map((item) => normalizeEntityAlias(item).toLowerCase()))

const TEMPORAL_AUDIT_TAG_METHOD_PAGES = new Set([
  "事实强度", "交易纪律", "交易错误", "信源分级", "舆情过滤", "风控", "风险控制",
  "仓位管理", "催化剂", "主线判断", "预期兑现",
].map((item) => normalizeEntityAlias(item).toLowerCase()))

const TEMPORAL_AUDIT_ABBREVIATION_ALIAS_WHITELIST = new Set([
  "CPO", "NPO", "MLCC", "SLCC", "AIDC", "CoPoS", "CoWoS", "TGV", "TSV", "DrMOS",
  "SST", "HVDC", "mSAP", "ABF", "CCL", "HBM", "ASIC", "TPU", "GPU", "CPU",
  "PSU", "InP", "SiC", "WF6", "PTFE", "PCIe", "OCS", "NAND", "DRAM", "SSD",
  "ASP", "ARR", "MPO", "Chiplet", "BS-PDN", "D2C",
].map((item) => normalizeEntityAlias(item).toLowerCase()))

const TEMPORAL_AUDIT_ABBREVIATION_ALIAS_BLACKLIST = new Set([
  "AI", "Call", "L4", "L3", "L2", "L1", "IPO", "Q1", "Q2", "Q3", "IP", "PC",
  "V3", "Tier", "Token", "Agent", "Switch", "Logic", "Folding", "Beta", "Meta",
  "Google", "NVIDIA", "SpaceX", "Rubin", "DeepSeek", "Gangtise",
].map((item) => normalizeEntityAlias(item).toLowerCase()))

const TEMPORAL_AUDIT_ALIAS_RULINGS = [
  { alias: "8英寸SiC衬底", decision: "merge_to", target: "8英寸SiC衬底供需缺口", note: "SiC碳化硅AI电源主线只做 related。" },
  { alias: "AHF涨价链", decision: "merge_to", target: "电子级氢氟酸涨价链", note: "半导体材料涨价链做上位概念。" },
  { alias: "AIDC电力", decision: "keep_parent", target: "AIDC电力", note: "下挂 AIDC电源与SST / SST固态变压器与AIDC电力。" },
  { alias: "AIPCB材料涨价链", decision: "keep_parent", target: "AIPCB材料涨价链", note: "作为上位交易链，下挂 AI PCB油墨涨价链 / 电子布涨价链。" },
  { alias: "AI数据中心电源", decision: "merge_to", target: "AIDC电源", note: "AIDC电源与SST做专题页。" },
  { alias: "AI服务器电源", decision: "keep_parent", target: "AI服务器电源链", note: "不直接合并到 PSU 或 DrMOS。" },
  { alias: "AI服务器电源链", decision: "keep_parent", target: "AI服务器电源链", note: "价值量提升和 AIDC/SST 是不同切片。" },
  { alias: "AI电子布", decision: "merge_to", target: "电子布涨价链", note: "AI服务器PCB价值量提升做 related。" },
  { alias: "AI电源价值量提升", decision: "merge_to", target: "AI服务器电源价值量提升", note: "" },
  { alias: "AI硬件材料涨价链", decision: "merge_to", target: "半导体材料涨价链", note: "AI-PCB油墨涨价链是子链。" },
  { alias: "AI铜箔", decision: "merge_to", target: "PCB铜箔涨价周期", note: "AI服务器PCB价值量提升做 related。" },
  { alias: "BGB-43395", decision: "merge_to", target: "CDK4选择性抑制剂", note: "百济神州是公司实体，药物代码不做公司 alias。" },
  { alias: "BlankMask", decision: "merge_to", target: "BlankMask与先进制程多重曝光", note: "Blank-Mask 重复页并入。" },
  { alias: "BuriedMask", decision: "merge_to", target: "BuriedMask与3D封装材料", note: "不要并入 BlankMask。" },
  { alias: "Coherent-lite", decision: "merge_to", target: "2.4T相干光模块", note: "2-4t相干光模块视为格式噪声/错写。" },
  { alias: "COUPE", decision: "merge_to", target: "台积电COUPE光互联平台", note: "台积电COUPE硅光整合平台合并进去。" },
  { alias: "CoWoP+mSAP", decision: "merge_to", target: "CoWoP与mSAP", note: "封装级PCB技术代差做 related。" },
  { alias: "CPO/NPO光引擎", decision: "merge_to", target: "CPO-NPO光引擎", note: "光互联Scale-Up-十年大周期是上位。" },
  { alias: "CPO光引擎", decision: "merge_to", target: "CPO-NPO光引擎", note: "" },
  { alias: "Dato-DXd", decision: "merge_to", target: "TROP2ADC一线肺癌竞争", note: "第一三共是公司实体。" },
  { alias: "DCI算力专网", decision: "keep_slice", target: "DCI算力专网", note: "related 到 AI算力财报映射链和光互联Scale-Up。" },
  { alias: "H200不买", decision: "merge_to", target: "H200不买与国产AI芯片自主研发", note: "" },
  { alias: "H200口径冲突", decision: "merge_to", target: "H200不买与国产AI芯片自主研发", note: "标记为风险/口径冲突事件。" },
  { alias: "H200未谈", decision: "merge_to", target: "H200不买与国产AI芯片自主研发", note: "" },
  { alias: "HBM逻辑泛化", decision: "merge_to", target: "HBM逻辑泛化到全部存储股", note: "错误页。" },
  { alias: "LPU垂直供电PCB", decision: "merge_to", target: "NV-LPU垂直供电PCB", note: "VPD垂直供电是上位技术。" },
  { alias: "MicroLED光互连", decision: "merge_to", target: "MicroLED光互联", note: "不要并入玻璃基板。" },
  { alias: "MicroLED光通信", decision: "merge_to", target: "MicroLED光互联", note: "" },
  { alias: "MicrosoftMOSAIC", decision: "merge_to", target: "微软MOSAIC光互联方案", note: "MicroLED光互联做 related。" },
  { alias: "PCB半导体化", decision: "keep_independent", target: "PCB半导体化", note: "技术范式，不是某条 PCB 或 CIPB 子链。" },
  { alias: "PD-1/VEGF双抗", decision: "merge_to", target: "PD-1与VEGF双抗肺癌竞争", note: "康方生物是公司实体。" },
  { alias: "Rubin互连芯片", decision: "merge_to", target: "英伟达Rubin互连芯片增量", note: "" },
  { alias: "Rubin互连芯片增量", decision: "merge_to", target: "英伟达Rubin互连芯片增量", note: "英伟达Rubin拆解价值量做上位。" },
  { alias: "Rubin正交背板", decision: "merge_to", target: "Rubin正交背板PCB链", note: "PTFE正交背板材料是材料切片。" },
  { alias: "sac-TMT", decision: "merge_to", target: "TROP2ADC一线肺癌竞争", note: "科伦博泰做公司 related。" },
  { alias: "SKB264", decision: "merge_to", target: "TROP2ADC一线肺癌竞争", note: "科伦博泰做公司 related。" },
  { alias: "SolidStateTransformer", decision: "merge_to", target: "SST固态变压器", note: "" },
  { alias: "SpaceX上市催化", decision: "merge_to", target: "SpaceX-IPO催化", note: "统一 SpaceX IPO 催化格式。" },
  { alias: "SST", decision: "merge_to", target: "SST固态变压器", note: "SST固态变压器与AIDC电力是应用场景。" },
  { alias: "Token算力", decision: "keep_parent", target: "Token算力", note: "关联 Token工厂与聚合运营商业模式 / 算力Token化。" },
  { alias: "VeraRubin互连芯片", decision: "merge_to", target: "英伟达Rubin互连芯片增量", note: "" },
  { alias: "τ定律", decision: "merge_to", target: "华为τ定律与LogicFolding", note: "" },
  { alias: "主线对标的错", decision: "merge_to", target: "主线判断正确但标的选择错误", note: "主线正确但标的错误作为 alias。" },
  { alias: "事实强度传播热度矩阵", decision: "merge_to", target: "催化剂事实强度传播热度矩阵", note: "事实强度与传播热度分离是原则页。" },
  { alias: "产能兑现型不等于透支区", decision: "merge_to", target: "产能兑现型主线", note: "产业兑现驱动的科技主升是更上位框架。" },
  { alias: "产能兑现型主线", decision: "keep_concept", target: "产能兑现型主线", note: "不要并入产业兑现驱动的科技主升。" },
  { alias: "京东方康宁合作备忘录", decision: "merge_to", target: "京东方康宁玻璃基光互联合作", note: "" },
  { alias: "企业级SSD供需紧张", decision: "merge_to", target: "NAND供需紧张至2027", note: "铠侠产能售罄是事件/厂商切片。" },
  { alias: "伊朗油洗白", decision: "merge_to", target: "伊朗油洗白与VLCC周期", note: "美伊谈判与霍尔木兹海峡风险是宏观上位。" },
  { alias: "光模块上游MLCC-SLCC", decision: "merge_to", target: "SLCC与1.6T光模块增量", note: "AI服务器被动元件供需紧张做 related。" },
  { alias: "光通信检测设备", decision: "merge_to", target: "光模块检测设备", note: "光模块检测设备量价齐升是验证/交易切片。" },
  { alias: "几内亚铝土矿", decision: "merge_to", target: "几内亚铝土矿出口管制", note: "" },
  { alias: "利好集中兑现日", decision: "merge_to", target: "盘前利好集中兑现日", note: "舆情强一致后的高开低走是相邻模式。" },
  { alias: "千帆星座", decision: "keep_parent", target: "千帆星座", note: "下挂千帆星座组网催化/组网进度。" },
  { alias: "半导体全链路瓶颈传导", decision: "merge_to", target: "半导体涨价全链路扩散", note: "半导体涨价扩散是概念简写。" },
  { alias: "华为τ定律", decision: "merge_to", target: "华为τ定律与LogicFolding", note: "" },
  { alias: "固态变压器", decision: "merge_to", target: "SST固态变压器", note: "" },
  { alias: "国产AI芯片自主研发", decision: "merge_to", target: "国产AI芯片自主可控", note: "H200不买是事件驱动切片。" },
  { alias: "国产算力供不应求", decision: "merge_to", target: "国产AI芯片供不应求", note: "算力租赁涨价与卖方市场做 related。" },
  { alias: "国产算力链", decision: "keep_parent", target: "国产算力链", note: "下挂国产算力替代加速/国产算力链兑现期。" },
  { alias: "LogicFolding", decision: "merge_to", target: "华为τ定律与LogicFolding", note: "优先归入华为τ定律与LogicFolding；3D堆叠仍是先进封装上位技术。" },
]

const TEMPORAL_AUDIT_CONCEPT_HIERARCHIES = [
  {
    root: "AI硬件 / AI服务器 / AI服务器PCB价值量提升",
    children: ["AI PCB上游短缺体系", "AI PCB油墨涨价链", "电子布涨价链", "PCB铜箔涨价周期", "AI PCB钻针三重通胀", "mSAP工艺预期差", "ABF载板涨价"],
    principle: "AI服务器PCB价值量提升是主概念，短缺、涨价、价值量提升是不同交易切片，不做简单同义合并。",
  },
  {
    root: "先进封装",
    children: ["Chiplet与3D堆叠封装", "TSV与3D堆叠先进封装", "华为τ定律与LogicFolding", "BS-PDN背面供电", "玻璃基板与TGV先进封装", "CoPoS面板级封装", "BlankMask与先进制程多重曝光", "BuriedMask与3D封装材料"],
    principle: "3D堆叠是技术总称，不直接等于 LogicFolding。",
  },
  {
    root: "光通信 / 光模块 / 光互联",
    children: ["800G到1.6T光模块升级", "2.4T相干光模块", "光模块检测设备", "光互联Scale-Up-十年大周期", "CPO-NPO光引擎", "DCI算力专网", "台积电COUPE光互联平台", "MicroLED光互联", "硅光芯片全链条布局"],
    principle: "光互联Scale-Up 是上位大周期，不吞并具体器件页。",
  },
  {
    root: "数据中心 / AIDC / AIDC电源",
    children: ["AI服务器电源链", "AI服务器电源价值量提升", "DrMOS与AI服务器电源", "PSU高功率电源", "SST固态变压器", "800V HVDC数据中心供电架构", "液冷单柜价值量提升", "AIDC储能从备用电源到基础设施", "算电协同"],
    principle: "AIDC电力是上位主题，SST 是技术实体，价值量提升是投资切片。",
  },
  {
    root: "国产算力",
    children: ["国产AI芯片自主可控", "H200不买与国产AI芯片自主研发", "国产AI芯片供不应求", "国产算力链兑现期", "国产算力替代加速", "算力租赁涨价与卖方市场", "Token工厂与算力网"],
    principle: "国产算力链是上位主题，不直接并入替代加速。",
  },
  {
    root: "商业航天",
    children: ["千帆星座", "千帆星座组网进度", "千帆星座组网催化", "D2C卫星直连手机", "太空算力", "轨道数据中心", "在轨数据中心", "SpaceX-IPO催化"],
    principle: "千帆星座是上位主题，太空数据中心相关命名先统一方向，再决定是否建子页。",
  },
]

const TEMPORAL_AUDIT_ALIAS_RULING_BY_KEY = new Map(
  TEMPORAL_AUDIT_ALIAS_RULINGS.map((item) => [normalizeEntityAlias(item.alias).toLowerCase(), item]),
)

function classifyTemporalAuditTag(tag) {
  const key = normalizeEntityAlias(tag).toLowerCase()
  if (TEMPORAL_AUDIT_TAG_PROMOTE_CONCEPTS.has(key)) {
    return { classification: "promote_concept", action: "晋升或维护为正式概念页" }
  }
  if (TEMPORAL_AUDIT_TAG_METHOD_PAGES.has(key)) {
    return { classification: "method_or_error_page", action: "进入方法论、模式或错误页体系" }
  }
  if (TEMPORAL_AUDIT_TAG_METADATA_ONLY.has(key)) {
    return { classification: "metadata_only", action: "只做元数据/来源标签，不晋升为概念页" }
  }
  return { classification: "review", action: "人工判断是否承载产业链、时间线、公司映射或交易框架" }
}

function classifyTemporalAuditAbbreviation(abbreviation) {
  const key = normalizeEntityAlias(abbreviation).toLowerCase()
  if (TEMPORAL_AUDIT_ABBREVIATION_ALIAS_WHITELIST.has(key)) {
    return { classification: "alias_whitelist", action: "可作为 alias 候选，但仍需绑定到正确概念或实体" }
  }
  if (TEMPORAL_AUDIT_ABBREVIATION_ALIAS_BLACKLIST.has(key)) {
    return { classification: "blocked_alias", action: "不要自动挂靠为 alias；如有价值，应作为实体/主题词单独处理" }
  }
  return { classification: "review", action: "人工判断是有效简称、产品代码、公司代码还是噪声" }
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function temporalAuditSnippet(text, index, termLength, maxChars = 120) {
  const start = Math.max(0, index - Math.floor(maxChars / 2))
  const end = Math.min(String(text).length, index + termLength + Math.floor(maxChars / 2))
  return String(text).slice(start, end).replace(/\s+/g, " ").trim()
}

function addTemporalAuditMapItem(map, key, patch) {
  const existing = map.get(key) ?? {
    key,
    count: 0,
    pages: new Set(),
    examples: [],
  }
  existing.count += patch.count ?? 1
  if (patch.page) existing.pages.add(patch.page)
  if (patch.example && existing.examples.length < 5) existing.examples.push(patch.example)
  for (const [field, value] of Object.entries(patch)) {
    if (["count", "page", "example"].includes(field)) continue
    if (value !== undefined) existing[field] = value
  }
  map.set(key, existing)
}

const TEMPORAL_AUDIT_CONFIDENCE_RANK = {
  high: 3,
  medium: 2,
  low: 1,
}

function dedupeTemporalAuditRows(rows) {
  const deduped = new Map()
  for (const row of rows) {
    const key = normalizeEntityAlias(row.alias).toLowerCase()
    const existing = deduped.get(key)
    if (!existing || (TEMPORAL_AUDIT_CONFIDENCE_RANK[row.confidence] ?? 0) > (TEMPORAL_AUDIT_CONFIDENCE_RANK[existing.confidence] ?? 0)) {
      deduped.set(key, row)
    }
  }
  return [...deduped.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

function extractTemporalAuditAliases({ title, fm }) {
  const rows = []
  const add = (alias, source, confidence = "medium") => {
    const normalized = normalizeEntityAlias(alias)
    if (!normalized || normalized === normalizeEntityAlias(title)) return
    if (normalized.length < 2 || normalized.length > 32) return
    rows.push({ alias: normalized, source, confidence })
  }

  for (const alias of frontmatterValues(fm, "aliases")) add(alias, "frontmatter.aliases", "high")

  const titleText = String(title ?? "")
  for (const part of titleText.split(/[\/／|｜、，,]/)) add(part, "title.split", "medium")
  for (const match of titleText.matchAll(/[（(]([^（）()]{2,32})[）)]/g)) add(match[1], "title.parenthetical", "medium")

  return dedupeTemporalAuditRows(rows)
}

function extractTemporalAuditTags({ title, fm }) {
  const rows = []
  for (const tag of frontmatterValues(fm, "tags")) {
    const normalized = normalizeEntityAlias(tag)
    if (!normalized || normalized === normalizeEntityAlias(title)) continue
    if (normalized.length < 2 || normalized.length > 32) continue
    rows.push({ alias: normalized, source: "frontmatter.tags", confidence: "low" })
  }
  return dedupeTemporalAuditRows(rows)
}

function extractTemporalAuditAbbreviations({ title, fm, body }) {
  const titleText = String(title ?? "")
  const abbreviationMatches = String(`${title}\n${frontmatterFieldSearchText(fm, "summary")}\n${body.slice(0, 6000)}`)
    .match(/\b[A-Za-z][A-Za-z0-9+.-]{1,14}\b/g) ?? []
  const abbreviationCounts = new Map()
  for (const raw of abbreviationMatches) {
    if (!/[A-Z0-9]/.test(raw)) continue
    if (/^(?:http|https|www|raw|wiki|markdown|json|schema|version)$/i.test(raw)) continue
    abbreviationCounts.set(raw, (abbreviationCounts.get(raw) ?? 0) + 1)
  }
  const rows = []
  for (const [alias, count] of abbreviationCounts.entries()) {
    const normalized = normalizeEntityAlias(alias)
    if (!normalized || normalized === normalizeEntityAlias(title)) continue
    if (normalized.length < 2 || normalized.length > 32) continue
    if (count >= 2 || titleText.includes(alias)) {
      rows.push({
        alias: normalized,
        source: `body.abbreviation:${count}`,
        confidence: count >= 4 || titleText.includes(alias) ? "medium" : "low",
        count,
      })
    }
  }
  return dedupeTemporalAuditRows(rows).sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.alias.localeCompare(b.alias))
}

function wikiAuditPageType(relativePath, fm) {
  if (typeof fm.type === "string" && fm.type.trim()) return fm.type.trim()
  const match = relativePath.match(/^wiki\/([^/]+)\//)
  return match?.[1] ?? "未知"
}

function auditEntityKeyForWikiPage({ title, type, fm, relativePath }) {
  const code = fm.code ?? fm.stockCode ?? fm.ticker
  if (type === "股票" || relativePath.startsWith("wiki/股票/")) return entityKeyForSubject(title, code)
  return entityKeyForSubject(title)
}

async function collectTemporalAuditWikiPages(projectPath, options = {}) {
  const pp = normalizePath(projectPath)
  const files = await listFilesRecursive(path.join(pp, "wiki"), {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".llm-wiki", ".obsidian", ".conflicts", "scripts", "templates", "archive", "assets"]),
    maxBytes: options.maxWikiBytes ?? 1024 * 1024,
    maxFiles: options.maxWikiFiles ? parsePositiveInteger(options.maxWikiFiles, null) : null,
  })
  const pages = []
  for (const filePath of files) {
    const relativePath = projectRelative(pp, filePath)
    if (isReservedWikiPath(relativePath)) continue
    const content = await readIfExists(filePath)
    if (!content.trim()) continue
    const { fm, body } = parseFrontmatter(content)
    const title = typeof fm.title === "string" && fm.title.trim()
      ? fm.title.trim()
      : path.basename(relativePath, ".md")
    const type = wikiAuditPageType(relativePath, fm)
    pages.push({
      path: relativePath,
      title,
      type,
      fm,
      body,
      content,
    })
  }
  return pages.sort((a, b) => a.path.localeCompare(b.path))
}

function auditPredicateCandidatesFromPages(pages, options = {}) {
  const map = new Map()
  const maxBodyChars = parsePositiveInteger(options.maxPredicateBodyChars, 16000)
  for (const page of pages) {
    const searchable = [
      page.title,
      frontmatterFieldSearchText(page.fm, "summary"),
      frontmatterFieldSearchText(page.fm, "tags"),
      frontmatterFieldSearchText(page.fm, "aliases"),
      page.body.slice(0, maxBodyChars),
    ].join("\n")
    for (const rule of TEMPORAL_PREDICATE_AUDIT_RULES) {
      for (const term of rule.terms) {
        const regex = new RegExp(escapeRegex(term), "g")
        let match
        while ((match = regex.exec(searchable)) !== null) {
          addTemporalAuditMapItem(map, `${rule.suggestedPredicate}:${term}`, {
            term,
            suggestedPredicate: rule.suggestedPredicate,
            candidatePredicates: rule.candidatePredicates ?? [rule.suggestedPredicate],
            reviewNote: rule.reviewNote ?? "",
            page: page.path,
            example: {
              path: page.path,
              title: page.title,
              snippet: temporalAuditSnippet(searchable, match.index, term.length),
            },
          })
        }
      }
    }
  }
  return [...map.values()]
    .map((item) => ({
      term: item.term,
      suggestedPredicate: item.suggestedPredicate,
      candidatePredicates: item.candidatePredicates ?? [item.suggestedPredicate],
      reviewNote: item.reviewNote ?? "",
      count: item.count,
      pageCount: item.pages.size,
      pages: [...item.pages].sort().slice(0, 20),
      examples: item.examples,
    }))
    .sort((a, b) => b.pageCount - a.pageCount || b.count - a.count || a.suggestedPredicate.localeCompare(b.suggestedPredicate))
}

function auditAliasCandidatesFromPages(pages) {
  const candidates = []
  const aliasOwners = new Map()
  const tagMap = new Map()
  const abbreviationMap = new Map()
  for (const page of pages) {
    if (!/^(股票|概念|事件|模式|策略|错误)$/.test(page.type) && !/^wiki\/(?:股票|概念|事件|模式|策略|错误)\//.test(page.path)) continue
    const aliases = extractTemporalAuditAliases({ title: page.title, fm: page.fm })
    const tagRows = extractTemporalAuditTags({ title: page.title, fm: page.fm })
    const abbreviationRows = extractTemporalAuditAbbreviations({ title: page.title, fm: page.fm, body: page.body })
    const entityKey = auditEntityKeyForWikiPage({ title: page.title, type: page.type, fm: page.fm, relativePath: page.path })
    const row = {
      canonicalSubject: normalizeEntityAlias(page.title),
      entityKey,
      type: page.type,
      path: page.path,
      aliases,
      aliasCount: aliases.length,
    }
    candidates.push(row)
    for (const alias of aliases) {
      const key = normalizeEntityAlias(alias.alias).toLowerCase()
      const owners = aliasOwners.get(key) ?? []
      owners.push({
        alias: alias.alias,
        canonicalSubject: row.canonicalSubject,
        entityKey: row.entityKey,
        path: row.path,
        source: alias.source,
        confidence: alias.confidence,
      })
      aliasOwners.set(key, owners)
    }
    for (const tag of tagRows) {
      const classification = classifyTemporalAuditTag(tag.alias)
      addTemporalAuditMapItem(tagMap, normalizeEntityAlias(tag.alias).toLowerCase(), {
        tag: tag.alias,
        confidence: tag.confidence,
        classification: classification.classification,
        action: classification.action,
        page: page.path,
        example: {
          canonicalSubject: row.canonicalSubject,
          entityKey: row.entityKey,
          path: row.path,
        },
      })
    }
    for (const abbreviation of abbreviationRows) {
      const classification = classifyTemporalAuditAbbreviation(abbreviation.alias)
      addTemporalAuditMapItem(abbreviationMap, normalizeEntityAlias(abbreviation.alias).toLowerCase(), {
        abbreviation: abbreviation.alias,
        confidence: abbreviation.confidence,
        classification: classification.classification,
        action: classification.action,
        count: abbreviation.count ?? 1,
        page: page.path,
        example: {
          canonicalSubject: row.canonicalSubject,
          entityKey: row.entityKey,
          path: row.path,
          count: abbreviation.count ?? 1,
        },
      })
    }
  }
  const aliasConflicts = [...aliasOwners.values()]
    .filter((owners) => new Set(owners.map((item) => item.entityKey)).size > 1)
    .map((owners) => ({
      alias: owners[0].alias,
      owners: owners.sort((a, b) => a.path.localeCompare(b.path)),
      ruling: TEMPORAL_AUDIT_ALIAS_RULING_BY_KEY.get(normalizeEntityAlias(owners[0].alias).toLowerCase()) ?? null,
    }))
    .sort((a, b) => b.owners.length - a.owners.length || a.alias.localeCompare(b.alias))
  const aliasOwnerKeys = new Set(aliasOwners.keys())
  const curatedAliasRulings = TEMPORAL_AUDIT_ALIAS_RULINGS
    .map((ruling) => {
      const key = normalizeEntityAlias(ruling.alias).toLowerCase()
      const owners = aliasOwners.get(key) ?? []
      return {
        ...ruling,
        matchedConflict: owners.length > 1,
        ownerCount: new Set(owners.map((item) => item.entityKey)).size,
        seenInAliases: aliasOwnerKeys.has(key),
      }
    })
    .sort((a, b) => Number(b.matchedConflict) - Number(a.matchedConflict) || Number(b.seenInAliases) - Number(a.seenInAliases) || a.alias.localeCompare(b.alias))
  return {
    aliasCandidates: candidates
      .filter((item) => item.aliases.length > 0)
      .sort((a, b) => b.aliasCount - a.aliasCount || a.path.localeCompare(b.path)),
    aliasConflicts,
    curatedAliasRulings,
    tagCandidates: [...tagMap.values()]
      .map((item) => ({
        tag: item.tag,
        confidence: item.confidence,
        classification: item.classification,
        action: item.action,
        count: item.count,
        pageCount: item.pages.size,
        pages: [...item.pages].sort().slice(0, 20),
        examples: item.examples,
      }))
      .sort((a, b) => b.pageCount - a.pageCount || b.count - a.count || a.tag.localeCompare(b.tag)),
    abbreviationCandidates: [...abbreviationMap.values()]
      .map((item) => ({
        abbreviation: item.abbreviation,
        confidence: item.confidence,
        classification: item.classification,
        action: item.action,
        count: item.count,
        pageCount: item.pages.size,
        pages: [...item.pages].sort().slice(0, 20),
        examples: item.examples,
      }))
      .sort((a, b) => b.pageCount - a.pageCount || b.count - a.count || a.abbreviation.localeCompare(b.abbreviation)),
  }
}

function buildTemporalFactsAuditMarkdown(result, topN = 50) {
  const predicateRows = result.predicateCandidates
    .slice(0, topN)
    .map((item) => `| ${item.term} | ${item.suggestedPredicate} | ${(item.candidatePredicates ?? [item.suggestedPredicate]).join("<br>")} | ${item.count} | ${item.pageCount} | ${item.pages.slice(0, 3).join("<br>")} | ${item.reviewNote ?? ""} |`)
    .join("\n")
  const aliasRows = result.aliasCandidates
    .slice(0, topN)
    .map((item) => `| ${item.canonicalSubject} | ${item.entityKey ?? ""} | ${item.type} | ${item.path} | ${item.aliases.slice(0, 8).map((alias) => `${alias.alias}(${alias.confidence})`).join("<br>")} |`)
    .join("\n")
  const conflictRows = result.aliasConflicts
    .slice(0, topN)
    .map((item) => `| ${item.alias} | ${item.owners.map((owner) => `${owner.canonicalSubject} ${owner.entityKey ?? ""} ${owner.path}`).join("<br>")} | ${item.ruling ? `${item.ruling.decision} -> ${item.ruling.target}` : ""} | ${item.ruling?.note ?? ""} |`)
    .join("\n")
  const curatedRulingRows = result.curatedAliasRulings
    .slice(0, topN)
    .map((item) => `| ${item.alias} | ${item.decision} | ${item.target} | ${item.matchedConflict ? "yes" : "no"} | ${item.seenInAliases ? "yes" : "no"} | ${item.note ?? ""} |`)
    .join("\n")
  const tagRows = result.tagCandidates
    .slice(0, topN)
    .map((item) => `| ${item.tag} | ${item.classification} | ${item.count} | ${item.pageCount} | ${item.pages.slice(0, 3).join("<br>")} | ${item.action ?? ""} |`)
    .join("\n")
  const abbreviationRows = result.abbreviationCandidates
    .slice(0, topN)
    .map((item) => `| ${item.abbreviation} | ${item.classification} | ${item.confidence} | ${item.count} | ${item.pageCount} | ${item.pages.slice(0, 3).join("<br>")} | ${item.action ?? ""} |`)
    .join("\n")
  const hierarchyRows = result.conceptHierarchyRules
    .map((item) => `| ${item.root} | ${item.children.slice(0, 10).join("<br>")} | ${item.principle} |`)
    .join("\n")
  const unmappedNote = [
    "本报告只给候选，不自动改词表或别名表。",
    "Predicate 候选需要人工确认后，再加入 `TEMPORAL_FACT_PREDICATES` 和 docs/temporal-facts-v1.md。",
    "Alias 候选只保留 frontmatter aliases、标题拆分和括号同义；tags 与正文缩写已拆成独立候选，避免泛主题词制造假冲突。",
    "Alias 冲突如果命中 curated ruling，只代表人工裁决建议，不自动改 wiki 页面。",
    "交易 wiki 的规则是先分层再合并：上位主题、事件催化、供需切片、价格切片、价值量切片不要混成同义词。",
  ].map((line) => `- ${line}`).join("\n")
  return [
    "# Temporal Facts Audit",
    "",
    `- generatedAt: ${result.generatedAt}`,
    `- projectPath: ${result.projectPath}`,
    `- wikiFiles: ${result.counts.wikiFiles}`,
    `- predicateCandidates: ${result.counts.predicateCandidates}`,
    `- aliasCandidates: ${result.counts.aliasCandidates}`,
    `- aliasConflicts: ${result.counts.aliasConflicts}`,
    `- curatedAliasRulings: ${result.counts.curatedAliasRulings}`,
    `- tagCandidates: ${result.counts.tagCandidates}`,
    `- abbreviationCandidates: ${result.counts.abbreviationCandidates}`,
    `- conceptHierarchyRules: ${result.counts.conceptHierarchyRules}`,
    "",
    "## Review Notes",
    "",
    unmappedNote,
    "",
    "## Predicate Candidates",
    "",
    "| term | suggestedPredicate | candidatePredicates | count | pages | sample pages | review note |",
    "|---|---|---|---:|---:|---|---|",
    predicateRows || "| none |  | 0 | 0 |  |",
    "",
    "## Alias Candidates",
    "",
    "| canonicalSubject | entityKey | type | path | aliases |",
    "|---|---|---|---|---|",
    aliasRows || "| none |  |  |  |  |",
    "",
    "## Alias Conflicts",
    "",
    "| alias | owners | curated ruling | note |",
    "|---|---|---|---|",
    conflictRows || "| none |  |  |  |",
    "",
    "## Curated Alias Rulings",
    "",
    "| alias | decision | target | matched conflict | seen in aliases | note |",
    "|---|---|---|---|---|---|",
    curatedRulingRows || "| none |  |  |  |  |  |",
    "",
    "## Tag Candidates",
    "",
    "| tag | classification | count | pages | sample pages | action |",
    "|---|---|---:|---:|---|---|",
    tagRows || "| none |  | 0 | 0 |  |  |",
    "",
    "## Abbreviation Candidates",
    "",
    "| abbreviation | classification | confidence | count | pages | sample pages | action |",
    "|---|---|---|---:|---:|---|---|",
    abbreviationRows || "| none |  |  | 0 | 0 |  |  |",
    "",
    "## Concept Hierarchy Rules",
    "",
    "| root | children / slices | principle |",
    "|---|---|---|",
    hierarchyRows || "| none |  |  |",
  ].join("\n")
}

export async function runTemporalFactsAudit(options = {}) {
  const projectPath = resolveProjectPath(options)
  const topN = parsePositiveInteger(options.topN ?? options.top, 50)
  const generatedAt = nowLocalTimestamp()
  const pages = await collectTemporalAuditWikiPages(projectPath, options)
  const predicateCandidates = auditPredicateCandidatesFromPages(pages, options)
  const { aliasCandidates, aliasConflicts, curatedAliasRulings, tagCandidates, abbreviationCandidates } = auditAliasCandidatesFromPages(pages)
  const result = {
    schema: "temporal-facts-audit-v1",
    generatedAt,
    projectPath,
    counts: {
      wikiFiles: pages.length,
      predicateCandidates: predicateCandidates.length,
      aliasCandidates: aliasCandidates.length,
      aliasConflicts: aliasConflicts.length,
      curatedAliasRulings: curatedAliasRulings.length,
      tagCandidates: tagCandidates.length,
      abbreviationCandidates: abbreviationCandidates.length,
      conceptHierarchyRules: TEMPORAL_AUDIT_CONCEPT_HIERARCHIES.length,
    },
    predicateCandidates,
    aliasCandidates,
    aliasConflicts,
    curatedAliasRulings,
    tagCandidates,
    abbreviationCandidates,
    conceptHierarchyRules: TEMPORAL_AUDIT_CONCEPT_HIERARCHIES,
    outputs: null,
  }
  const markdown = buildTemporalFactsAuditMarkdown(result, topN)
  if (options.write) {
    const stamp = generatedAt.replace(/[: ]/g, "-")
    const reportId = options.reportId ?? `audit-${stamp}`
    const outputDir = path.join(projectPath, TEMPORAL_FACT_AUDIT_ROOT)
    const jsonPath = path.join(outputDir, `${reportId}.json`)
    const markdownPath = path.join(outputDir, `${reportId}.md`)
    result.outputs = {
      json: projectRelative(projectPath, jsonPath),
      markdown: projectRelative(projectPath, markdownPath),
    }
    await writeJson(jsonPath, result)
    await ensureDirectory(outputDir)
    await fs.writeFile(markdownPath, markdown, "utf8")
  }
  return { ...result, markdown }
}

function parsePositiveInteger(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

function dailyLogPathFromTimestamp(timestamp) {
  const day = String(timestamp ?? nowLocalTimestamp()).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return `wiki/logs/log-${nowLocalTimestamp().slice(0, 10)}.md`
  return `wiki/logs/log-${day}.md`
}

function isLogPath(relativePath) {
  return relativePath === "wiki/log.md" || DAILY_LOG_REGEX.test(relativePath)
}

function isReservedWikiPath(relativePath) {
  return RESERVED_WIKI_PATHS.has(relativePath) || DAILY_LOG_REGEX.test(relativePath)
}

function housekeepingPaths(nowTs) {
  return ["wiki/index.md", "wiki/overview.md", dailyLogPathFromTimestamp(nowTs)]
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(parsePositiveInteger(concurrency, 1), items.length || 1))
  const results = new Array(items.length)
  let nextIndex = 0

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  await Promise.all(Array.from({ length: limit }, runNext))
  return results
}

async function listFilesRecursive(root, options = {}) {
  const {
    extensions = null,
    excludeDirNames = new Set([".git", "node_modules"]),
    maxBytes = null,
    maxFiles = null,
    preferRecent = false,
  } = options

  const out = []

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (excludeDirNames.has(entry.name)) continue
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (extensions && !extensions.has(ext)) continue
      if (maxBytes != null) {
        const stat = await fs.stat(fullPath)
        if (stat.size > maxBytes) continue
      }
      out.push(fullPath)
    }
  }

  await walk(root)
  if (preferRecent) out.sort(comparePathRecencyDesc)
  return maxFiles == null ? out : out.slice(0, maxFiles)
}

function pathDateToken(filePath) {
  return toPosixPath(filePath).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? ""
}

function comparePathRecencyDesc(a, b) {
  const dateA = pathDateToken(a)
  const dateB = pathDateToken(b)
  if (dateA && dateB && dateA !== dateB) return dateB.localeCompare(dateA)
  if (dateB && !dateA) return 1
  if (dateA && !dateB) return -1
  return toPosixPath(b).localeCompare(toPosixPath(a))
}

function queryDateHints(text) {
  return [...new Set(String(text ?? "").match(/\d{4}-\d{2}-\d{2}/g) ?? [])]
}

function filterRawFilesByQueryPolicy(rawFiles, query, options = {}) {
  const mode = normalizeRetrievalMode(options.mode ?? RETRIEVAL_MODES.ASK)
  const sorted = rawFiles.sort(comparePathRecencyDesc)
  if (mode === RETRIEVAL_MODES.INGEST) {
    return sorted.slice(0, options.maxRawFiles ?? 240)
  }
  const hints = queryDateHints(query)
  if (hints.length > 0) {
    const dated = sorted.filter((filePath) => hints.some((hint) => toPosixPath(filePath).includes(hint)))
    if (dated.length > 0) return dated.sort(comparePathRecencyDesc).slice(0, options.maxDatedRawFiles ?? 240)
  }
  return sorted.slice(0, options.maxRawFiles ?? 160)
}

async function pathSizeBytes(targetPath) {
  let total = 0
  async function walk(currentPath) {
    let stat
    try {
      stat = await fs.lstat(currentPath)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      total += stat.size
      return
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) await walk(path.join(currentPath, entry.name))
  }
  await walk(targetPath)
  return total
}

async function pathMetric(projectPath, relativePath) {
  const fullPath = path.join(projectPath, relativePath)
  if (!(await exists(fullPath))) {
    return { relativePath, exists: false, bytes: 0 }
  }
  return { relativePath, exists: true, bytes: await pathSizeBytes(fullPath) }
}

async function findLargeWikiMarkdown(projectPath, minBytes = 100 * 1024) {
  const wikiRoot = path.join(projectPath, "wiki")
  const files = await listFilesRecursive(wikiRoot, {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".llm-wiki", ".obsidian"]),
  })
  const rows = []
  for (const filePath of files) {
    const stat = await fs.stat(filePath)
    if (stat.size < minBytes) continue
    rows.push({
      relativePath: projectRelative(projectPath, filePath),
      bytes: stat.size,
    })
  }
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, 50)
}

async function listSuccessfulIngestReportDirs(projectPath, keepDays) {
  const root = path.join(projectPath, REPORT_ROOT)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const now = Date.now()
  const minAgeMs = keepDays * 24 * 60 * 60 * 1000
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirPath = path.join(root, entry.name)
    const reportPath = path.join(dirPath, "apply-report.json")
    if (!(await exists(reportPath))) continue
    const stat = await fs.stat(dirPath)
    const ageMs = Math.max(0, now - stat.mtimeMs)
    if (ageMs < minAgeMs) continue
    candidates.push({
      type: "delete_dir",
      relativePath: projectRelative(projectPath, dirPath),
      bytes: await pathSizeBytes(dirPath),
      ageDays: Number((ageMs / (24 * 60 * 60 * 1000)).toFixed(1)),
      reason: `successful codex-ingest report older than ${keepDays} days`,
    })
  }
  return candidates.sort((a, b) => b.bytes - a.bytes)
}

function assertSafeHygieneDelete(relativePath) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "")
  if (!normalized.startsWith(`${REPORT_ROOT}/`)) {
    throw new Error(`Refusing hygiene delete outside ${REPORT_ROOT}: ${relativePath}`)
  }
  if (normalized.includes("..")) throw new Error(`Refusing path traversal: ${relativePath}`)
  return normalized
}

async function buildHygieneAudit(projectPath, keepDays) {
  const targets = {
    codexIngestReports: await pathMetric(projectPath, REPORT_ROOT),
    lancedb: await pathMetric(projectPath, ".llm-wiki/lancedb"),
    lancedbVersions: await pathMetric(projectPath, ".llm-wiki/lancedb/wiki_vectors.lance/_versions"),
    lancedbTransactions: await pathMetric(projectPath, ".llm-wiki/lancedb/wiki_vectors.lance/_transactions"),
    backups: await pathMetric(projectPath, ".llm-wiki/backups"),
    cache: await pathMetric(projectPath, ".llm-wiki/cache"),
    raw: await pathMetric(projectPath, "raw"),
    wiki: await pathMetric(projectPath, "wiki"),
    legacyLog: await pathMetric(projectPath, "wiki/log.md"),
  }
  return {
    keepDays,
    targets,
    largeWikiMarkdown: await findLargeWikiMarkdown(projectPath),
    safety: {
      rawWrites: "never",
      wikiBodyCompression: "candidate-report-only",
      formalWikiPages: "not cleaned by hygiene",
      applyScope: `${REPORT_ROOT}/ successful report directories only`,
    },
  }
}

async function buildHygienePlan(projectPath, keepDays) {
  return {
    actions: await listSuccessfulIngestReportDirs(projectPath, keepDays),
    notes: [
      "No raw/** files are written or deleted.",
      "No formal wiki/** pages are compressed or deleted.",
      "LanceDB index maintenance is reported here; clear/rebuild is handled by vector maintenance commands.",
    ],
  }
}

export async function runHygiene(options = {}) {
  const action = options.action ?? "audit"
  if (!["audit", "plan", "apply"].includes(action)) {
    throw new Error("Unknown hygiene action. Use audit, plan, or apply.")
  }
  const projectPath = resolveProjectPath(options)
  const keepDays = parsePositiveInteger(options.keepDays, 14)
  const audit = await buildHygieneAudit(projectPath, keepDays)
  const plan = action === "audit" ? { actions: [], notes: [] } : await buildHygienePlan(projectPath, keepDays)
  const write = Boolean(options.write)
  const result = {
    action,
    projectPath,
    generatedAt: nowLocalTimestamp(),
    dryRun: action !== "apply" || !write,
    audit,
    plan,
    applied: [],
  }

  if (action !== "apply" || !write) return result

  for (const planned of plan.actions) {
    if (planned.type !== "delete_dir") continue
    const safePath = assertSafeHygieneDelete(planned.relativePath)
    const fullPath = path.join(projectPath, safePath)
    await fs.rm(fullPath, { recursive: true, force: true })
    result.applied.push({ ...planned, relativePath: safePath })
  }
  return result
}

export function normalizeTypeAlias(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()
  return TYPE_ALIASES.get(trimmed) ?? TYPE_ALIASES.get(trimmed.toLowerCase()) ?? null
}

export function normalizeStatusAlias(raw) {
  if (!raw) return null
  const trimmed = String(raw).trim()
  return STATUS_ALIASES.get(trimmed) ?? STATUS_ALIASES.get(trimmed.toLowerCase()) ?? null
}

export function inferTypeFromPath(filePath) {
  const norm = toPosixPath(filePath)
  const match = norm.match(/(?:^|\/)wiki\/([^/]+)\//)
  return normalizeTypeAlias(match?.[1] ?? "") ?? "总结"
}

function stripYamlWrapper(raw) {
  const match = raw.match(/^```yaml\s*\r?\n([\s\S]*?)\r?\n```\s*\r?\n?/)
  if (!match) return { content: raw, stripped: false }
  return { content: match[1], stripped: true }
}

export function parseFrontmatter(markdown) {
  const { content, stripped } = stripYamlWrapper(markdown)
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { fm: {}, body: content, hadYamlWrapper: stripped }
  let fm = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed
  } catch {
    fm = {}
  }
  return { fm, body: content.slice(match[0].length), hadYamlWrapper: stripped }
}

export function serializeFrontmatter(fm, body) {
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd()
  const cleanBody = body.startsWith("\n") ? body.slice(1) : body
  return `---\n${yaml}\n---\n\n${cleanBody}`
}

export function cleanSources(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    let source = item.trim()
    if (!source) continue
    if (source.includes("]]") || source.includes("：")) continue
    if (/^(好的|以下是|这份|现在写入)/.test(source)) continue
    source = source.replace(/\.md$/i, "")
    source = source.replace(/-\d+$/, "")
    if (source.length > 60) source = `${source.slice(0, 40)}...`
    if (!seen.has(source)) {
      seen.add(source)
      out.push(source)
    }
  }
  return out
}

export function validateFrontmatter(fm, filePath = "", body = "") {
  const coerced = filePath
    ? coerceWikiPageFrontmatter(fm, filePath, body, {})
    : normalizeFrontmatterFields(fm)
  const violations = []
  const add = (field, message, fatal = true) => violations.push({ field, message, fatal })

  if (coerced.schema_version !== 1) add("schema_version", "must be 1")
  if (!coerced.title || typeof coerced.title !== "string") add("title", "missing title")

  const normalizedType = normalizeTypeAlias(coerced.type)
  if (!normalizedType) add("type", `must be one of: ${WIKI_TYPES.join(" / ")}`)

  if (typeof coerced.summary !== "string" || coerced.summary.trim().length === 0) {
    add("summary", "missing summary")
  } else {
    const len = [...coerced.summary].length
    if (len < SUMMARY_MIN || len > SUMMARY_MAX) {
      add("summary", `summary should be ${SUMMARY_MIN}-${SUMMARY_MAX} characters`, false)
    }
  }

  for (const field of ["created", "updated", "last_reviewed"]) {
    const value = coerced[field]
    if (typeof value !== "string" || !TIMESTAMP_REGEX.test(value)) {
      add(field, "must use YYYY-MM-DD HH:mm:ss")
    }
  }

  if (!CONFIDENCE.includes(coerced.confidence)) add("confidence", `must be one of: ${CONFIDENCE.join(" / ")}`)

  const normalizedStatus = normalizeStatusAlias(coerced.status)
  if (!normalizedStatus) add("status", `must be one of: ${WIKI_STATUS.join(" / ")}`)

  if (normalizedType === "股票") {
    if (typeof coerced.code !== "string" || !STOCK_CODE_REGEX.test(coerced.code)) {
      add("code", "stock pages require code like SZ000001, HK09992, or AAPL")
    }
  }

  for (const [field, expectedArray] of [
    ["aliases", false],
    ["tags", false],
    ["related", true],
    ["sources", false],
  ]) {
    if (coerced[field] == null) continue
    if (!Array.isArray(coerced[field])) {
      add(field, "must be an array")
      continue
    }
    if (expectedArray) {
      for (const item of coerced[field]) {
        if (typeof item !== "string" || !WIKILINK_REGEX.test(item)) {
          add(field, `invalid wikilink in ${field}: ${String(item)}`)
        }
      }
    }
  }

  if (filePath) {
    const typeFromPath = inferTypeFromPath(filePath)
    if (normalizedType && typeFromPath !== "总结" && normalizedType !== typeFromPath) {
      add("type", `type ${normalizedType} does not match path type ${typeFromPath}`, false)
    }
  }

  return violations
}

export function validateWikiContent(relativePath, content) {
  if (isReservedWikiPath(relativePath)) return []
  if (!relativePath.startsWith("wiki/") || !relativePath.endsWith(".md")) return []
  const { fm, body } = parseFrontmatter(content)
  const issues = validateFrontmatter(fm, relativePath, body)
  const bodyLineCount = countBodyLines(body)
  if (bodyLineCount > PAGE_BODY_LINE_SOFT_LIMIT) {
    issues.push({
      field: "body_lines",
      message: `body has ${bodyLineCount} lines; soft limit is ${PAGE_BODY_LINE_SOFT_LIMIT}`,
      fatal: false,
    })
  }
  return issues
}

export function countBodyLines(body) {
  const trimmed = String(body ?? "").replace(/^\s+|\s+$/g, "")
  if (!trimmed) return 0
  return trimmed.split(/\r?\n/).length
}

function countAllLines(text) {
  if (!text) return 0
  return String(text).split(/\r?\n/).length
}

function validatePreserveLargeHousekeepingPage(relativePath, before, after) {
  if (!["wiki/index.md", "wiki/overview.md"].includes(relativePath)) return []
  const beforeLines = countAllLines(before)
  const afterLines = countAllLines(after)
  if (beforeLines < 50) return []
  if (afterLines >= Math.floor(beforeLines * 0.8)) return []
  return [
    {
      field: "preserve_existing_content",
      message: `${relativePath} would shrink from ${beforeLines} to ${afterLines} lines; keep existing content and append/merge instead`,
      fatal: true,
    },
  ]
}

export function extractTitle(content, filePath) {
  const fileName = path.basename(filePath)
  const { fm } = parseFrontmatter(content)
  if (typeof fm.title === "string" && fm.title.trim()) return fm.title.trim()
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  return fileName.replace(/\.md$/i, "")
}

function frontmatterSearchText(content) {
  const { fm } = parseFrontmatter(content)
  return [
    frontmatterFieldSearchText(fm, "title"),
    frontmatterFieldSearchText(fm, "type"),
    frontmatterFieldSearchText(fm, "summary"),
    frontmatterFieldSearchText(fm, "aliases"),
    frontmatterFieldSearchText(fm, "tags"),
    frontmatterFieldSearchText(fm, "related"),
    frontmatterFieldSearchText(fm, "sources"),
  ].filter(Boolean).join(" ")
}

function frontmatterValues(fm, field) {
  const value = fm?.[field]
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === "string" || typeof value === "number") return [String(value).trim()].filter(Boolean)
  return []
}

function frontmatterFieldSearchText(fm, field) {
  const values = frontmatterValues(fm, field)
  if (values.length === 0) return ""
  if (field === "related") {
    return values
      .flatMap((value) => [value, normalizeWikilinkTarget(value), normalizeWikilinkTarget(value).split("/").pop()])
      .filter(Boolean)
      .join(" ")
  }
  if (field === "sources") {
    return values
      .flatMap((value) => {
        const normalized = toPosixPath(value).replace(/\.md$/i, "")
        return [value, normalized, path.basename(normalized)]
      })
      .filter(Boolean)
      .join(" ")
  }
  return values.join(" ")
}

function scoreFrontmatterStructure(fm, tokens) {
  const fieldWeights = new Map([
    ["title", 5],
    ["aliases", 5],
    ["tags", 5],
    ["related", 6],
    ["sources", 6],
    ["summary", 3],
    ["type", 2],
  ])
  let score = 0
  const matches = []

  for (const [field, weight] of fieldWeights) {
    const text = frontmatterFieldSearchText(fm, field)
    if (!text) continue
    const tokenScore = tokenMatchScore(text, tokens)
    if (tokenScore <= 0) continue
    score += tokenScore * weight
    score += topicCoverageBonus(text, tokens) * 0.8
    matches.push(field)
  }

  return {
    score,
    matches,
    sources: frontmatterValues(fm, "sources"),
    related: frontmatterValues(fm, "related"),
    tags: frontmatterValues(fm, "tags"),
  }
}

function buildSnippet(content, tokens, maxLength = 180) {
  const lower = content.toLowerCase()
  const token = preferredEvidenceTokens(tokens).find((t) => lower.includes(t.toLowerCase()))
  if (!token) return content.slice(0, maxLength).replace(/\s+/g, " ").trim()
  const idx = lower.indexOf(token.toLowerCase())
  const start = Math.max(0, idx - 80)
  const end = Math.min(content.length, idx + token.length + 100)
  let snippet = content.slice(start, end).replace(/\s+/g, " ").trim()
  if (start > 0) snippet = `...${snippet}`
  if (end < content.length) snippet = `${snippet}...`
  return snippet
}

function charLength(token) {
  return [...String(token ?? "")].length
}

function isSingleCjkToken(token) {
  return charLength(token) === 1 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
}

function containsAnyToken(token, words) {
  for (const word of words) {
    if (word && token.includes(word)) return true
  }
  return false
}

function tokenWeight(token) {
  const normalized = String(token ?? "").toLowerCase()
  const length = charLength(normalized)
  if (EVIDENCE_QUERY_TOKENS.has(normalized)) return 2.4
  if (ASK_TIME_TOKENS.has(normalized)) return 0.2
  if (GENERIC_QUERY_TOKENS.has(normalized)) return 0.15
  if (isSingleCjkToken(normalized)) return 0.05
  if (length > 4 && containsAnyToken(normalized, ASK_TIME_TOKENS)) return 0.35
  if (length > 4 && containsAnyToken(normalized, GENERIC_QUERY_TOKENS)) return 0.35
  if (length > 10 && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(normalized)) return 0.35
  if (/[a-z0-9]/i.test(normalized)) return Math.min(3, 1 + length * 0.15)
  if (length >= 4) return 2.4
  if (length === 3) return 1.7
  return 1
}

function preferredEvidenceTokens(tokens) {
  const uniq = [...new Set(tokens.map((token) => String(token).trim()).filter(Boolean))]
  const topical = uniq
    .filter((token) => tokenWeight(token) >= 1)
    .sort((a, b) => tokenWeight(b) - tokenWeight(a) || charLength(b) - charLength(a))
  return topical.length > 0 ? topical : uniq
}

function titleCoverageBonus(titleText, tokens) {
  const topicalTokens = preferredEvidenceTokens(tokens)
    .filter((token) => !ASK_TIME_TOKENS.has(token))
    .slice(0, 8)
  if (topicalTokens.length === 0) return 0
  const lower = titleText.toLowerCase()
  const matched = topicalTokens.filter((token) => lower.includes(token.toLowerCase()))
  if (matched.length >= 2 && matched.length === topicalTokens.length) return 18
  if (matched.length >= 2) return matched.length * 5
  return 0
}

function topicCoverageBonus(text, tokens) {
  const lower = text.toLowerCase()
  const matched = preferredEvidenceTokens(tokens)
    .slice(0, 14)
    .filter((token) => lower.includes(token.toLowerCase()))
  if (matched.length === 0) return 0

  let score = matched.reduce((sum, token) => sum + tokenWeight(token) * 1.8, 0)
  if (matched.length >= 2) score += 6
  if (matched.length >= 4) score += 6
  return score
}

function rawPathQualityBonus(relativePath, title, tokens, options = {}) {
  const mode = normalizeRetrievalMode(options.mode)
  const normalizedPath = toPosixPath(relativePath).toLowerCase()
  const titleText = `${title} ${path.basename(relativePath)}`.toLowerCase()
  let score = 0

  const titleMatches = preferredEvidenceTokens(tokens)
    .slice(0, 12)
    .filter((token) => titleText.includes(token.toLowerCase()))
  if (titleMatches.length > 0) score += 18 + titleMatches.length * 5

  if (/(?:^|\/)(?:研报新闻|openclaw数据|产业链复盘|投研线索|日复盘)(?:\/|$)/.test(normalizedPath)) {
    score += 10
  }
  if (mode === RETRIEVAL_MODES.ASK && /(?:^|\/)微信聊天(?:\/|$)/.test(normalizedPath)) {
    score -= 15
  }

  return score
}

function normalizeSourceReference(value) {
  return toPosixPath(String(value ?? ""))
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
}

function isWeakSourceReference(value) {
  const normalized = normalizeSourceReference(value)
  if (!normalized) return true
  if (/^\d{4}(?:-\d{2}){0,2}$/.test(normalized)) return true
  if (/^(?:today|yesterday|daily|review|think|source|raw)$/.test(normalized)) return true
  if (!normalized.includes("/") && normalized.length < 8) return true
  return false
}

function sourceReferenceKeys(value) {
  const normalized = normalizeSourceReference(value)
  if (!normalized || isWeakSourceReference(normalized)) return []
  return [...new Set([normalized, path.posix.basename(normalized)].filter((item) => item.length >= 4))]
}

function boostRawResultsByWikiStructure(rawResults, wikiResults) {
  const sourceKeys = new Map()
  for (const wiki of wikiResults.slice(0, 18)) {
    for (const source of wiki.frontmatterSources ?? []) {
      for (const key of sourceReferenceKeys(source)) {
        if (!sourceKeys.has(key)) sourceKeys.set(key, [])
        sourceKeys.get(key).push(wiki.path)
      }
    }
  }
  if (sourceKeys.size === 0) return

  for (const raw of rawResults) {
    const rawPath = normalizeSourceReference(raw.path)
    const rawTitle = String(raw.title ?? "").toLowerCase()
    const haystack = `${rawPath} ${path.posix.basename(rawPath)} ${rawTitle}`
    const matchedFrom = []
    for (const [key, wikiPaths] of sourceKeys) {
      if (!haystack.includes(key)) continue
      matchedFrom.push(...wikiPaths)
    }
    if (matchedFrom.length === 0) continue
    const uniqueFrom = [...new Set(matchedFrom)]
    raw.score += 26 + Math.min(uniqueFrom.length, 5) * 3
    raw.structuredSourceMatch = uniqueFrom.slice(0, 8)
  }
}

function specificWikiTypeBonus(type) {
  if (["概念", "股票", "错误", "模式", "策略"].includes(type)) return 5
  if (["源文档", "总结", "查询"].includes(type)) return 0
  return 2
}

function compactFrontmatterForEvidence(fm) {
  const rows = []
  for (const field of ["title", "type", "summary", "confidence", "status"]) {
    if (typeof fm[field] === "string" || typeof fm[field] === "number") rows.push(`${field}: ${fm[field]}`)
  }
  for (const field of ["aliases", "tags", "related", "sources"]) {
    if (Array.isArray(fm[field]) && fm[field].length > 0) {
      rows.push(`${field}: ${fm[field].slice(0, 18).map((item) => String(item)).join(", ")}`)
    }
  }
  return rows.join("\n")
}

function buildEvidenceExcerpt(content, tokens, maxChars) {
  const { fm, body } = parseFrontmatter(content)
  const fmText = compactFrontmatterForEvidence(fm)
  const sourceText = body.trim() ? body : content
  const lower = sourceText.toLowerCase()
  const windows = []
  const usedRanges = []

  for (const token of preferredEvidenceTokens(tokens)) {
    if (windows.length >= 3) break
    const idx = lower.indexOf(token.toLowerCase())
    if (idx < 0) continue
    const start = Math.max(0, idx - 650)
    const end = Math.min(sourceText.length, idx + token.length + 1150)
    if (usedRanges.some(([a, b]) => Math.max(a, start) < Math.min(b, end))) continue
    usedRanges.push([start, end])
    windows.push(`${start > 0 ? "..." : ""}${sourceText.slice(start, end).trim()}${end < sourceText.length ? "..." : ""}`)
  }

  if (windows.length === 0 && sourceText.trim()) {
    windows.push(sourceText.slice(0, Math.min(sourceText.length, Math.max(900, maxChars - fmText.length - 120))).trim())
  }

  return truncateAtBoundary([fmText, ...windows].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n"), maxChars)
}

function wikiRelativePathToNodeId(relativePath) {
  const norm = toPosixPath(relativePath)
  if (!norm.startsWith("wiki/") || !norm.endsWith(".md")) return null
  return norm.slice("wiki/".length, -".md".length)
}

function normalizeWikilinkTarget(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    .trim()
    .replace(/^wiki\//, "")
    .replace(/\.md$/i, "")
}

function extractWikilinkTargets(content) {
  const links = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const target = normalizeWikilinkTarget(match[1])
    if (target) links.push(target)
  }
  return links
}

function resolveGraphTarget(rawTarget, nodeIds, basenameIndex) {
  const target = normalizeWikilinkTarget(rawTarget)
  if (!target) return null
  if (nodeIds.has(target)) return target
  const basename = target.includes("/") ? target.split("/").pop() : target
  const byBase = basenameIndex.get(basename)
  if (byBase?.length === 1) return byBase[0]
  const normalized = basename.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeIds) {
    const idBase = id.includes("/") ? id.split("/").pop() : id
    const idLower = idBase.toLowerCase()
    if (idLower === basename.toLowerCase() || idLower.replace(/\s+/g, "-") === normalized) return id
  }
  return null
}

function sortSearchResults(items) {
  return items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const dateA = a.path.match(/(\d{4})-(\d{2})-(\d{2})/)
    const dateB = b.path.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (dateA && dateB) return dateB[0].localeCompare(dateA[0])
    if (dateB) return 1
    if (dateA) return -1
    return a.path.localeCompare(b.path)
  })
}

export function tokenizeQuery(query) {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…【】《》|*#>[\]{}]+/)
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token))

  const tokens = []
  for (const token of rawTokens) {
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCjk && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
      for (let i = 0; i < chars.length - 2; i++) tokens.push(chars[i] + chars[i + 1] + chars[i + 2])
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) tokens.push(ch)
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

function tokenMatchScore(text, tokens) {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) score += tokenWeight(token)
  }
  return score
}

function getRecencyBoost(fileName, query) {
  const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!dateMatch) return 0
  const fileDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
  const now = new Date()
  const diffDays = (now.getTime() - fileDate.getTime()) / 86400000

  let boost = 0
  if (diffDays <= 7) boost += 6
  else if (diffDays <= 30) boost += 3
  else if (diffDays <= 90) boost += 1

  const patterns = [
    { regex: /最近一?个?月|本月|这个月|近30天|近一个月/, days: 30 },
    { regex: /最近一?周|本周|这周|近7天/, days: 7 },
    { regex: /昨日|昨天/, days: 1 },
    { regex: /今天|当日/, days: 0 },
  ]
  for (const p of patterns) {
    if (p.regex.test(query)) {
      if (diffDays <= p.days) boost += 15
      break
    }
  }
  return boost
}

const FRONTMATTER_FRESHNESS_FIELDS = ["updated", "last_reviewed", "created"]
const FRONTMATTER_STALE_SENSITIVE_TYPES = new Set(["概念", "股票", "总结", "源文档", "查询"])
const FRONTMATTER_STABLE_TYPES = new Set(["策略", "模式", "错误"])
const FRESHNESS_SENSITIVE_QUERY_REGEX =
  /最新|最近|近期|今日|今天|当日|昨日|昨天|本周|这周|本月|这个月|近\s*\d+|近[一二三四五六七八九十两]+(?:天|日|周|月)|催化|订单|进展|变化|更新|量产|业绩|公告|调研|会议|研报|新闻|舆情|成交|量价|涨跌幅|放量|缩量|验证/

function parseFrontmatterFreshnessDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { date: value, value: value.toISOString().slice(0, 19).replace("T", " ") }
  }

  const text = String(value ?? "").trim().replace(/^['"]|['"]$/g, "")
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 12),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  )
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null
  }
  return { date, value: text }
}

function frontmatterFreshnessTimestamp(fm) {
  const candidates = []
  for (const field of FRONTMATTER_FRESHNESS_FIELDS) {
    const parsed = parseFrontmatterFreshnessDate(fm?.[field])
    if (parsed) candidates.push({ ...parsed, field })
  }
  return candidates.sort((a, b) => b.date.getTime() - a.date.getTime())[0] ?? null
}

function localDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function frontmatterFreshnessScore(fm, query, type, now = new Date()) {
  const timestamp = frontmatterFreshnessTimestamp(fm)
  if (!timestamp) {
    return {
      score: 0,
      field: null,
      value: null,
      staleDays: null,
      timeSensitive: FRESHNESS_SENSITIVE_QUERY_REGEX.test(query),
    }
  }

  const diffDays = Math.max(
    0,
    Math.floor((localDateOnly(now).getTime() - localDateOnly(timestamp.date).getTime()) / 86400000),
  )
  const normalizedType = normalizeTypeAlias(type) ?? String(type ?? "")
  const timeSensitive = FRESHNESS_SENSITIVE_QUERY_REGEX.test(query)
  const stableType = FRONTMATTER_STABLE_TYPES.has(normalizedType)
  const staleSensitiveType = FRONTMATTER_STALE_SENSITIVE_TYPES.has(normalizedType)
  let score = 0

  if (diffDays <= 7) score += timeSensitive ? 10 : 4
  else if (diffDays <= 30) score += timeSensitive ? 6 : 2
  else if (diffDays <= 90) score += timeSensitive ? 2 : 1

  if (diffDays > 365) {
    if (timeSensitive) score -= stableType ? 2 : 10
    else if (staleSensitiveType) score -= 3
  } else if (diffDays > 180) {
    if (timeSensitive) score -= stableType ? 1 : 5
    else if (staleSensitiveType) score -= 1
  }

  return {
    score,
    field: timestamp.field,
    value: timestamp.value,
    staleDays: diffDays,
    timeSensitive,
  }
}

function extractSourceSearchSeed(sourceContent, sourcePath) {
  const searchableContent = String(sourceContent ?? "").replace(/<\/?[a-z][^>\n]*>/gi, " ")
  const headings = searchableContent
    .split(/\r?\n/)
    .filter((line) => /^#{1,4}\s+/.test(line.trim()) || /^[-*]\s*\*\*.+\*\*/.test(line.trim()))
    .slice(0, 80)
    .join("\n")
  const lead = searchableContent.slice(0, 16000)
  return `${path.basename(sourcePath)}\n${headings}\n${lead}`
}

function normalizeIngestToken(token) {
  return String(token ?? "")
    .trim()
    .replace(/^['"`*_#[\]()<>{}:：,，.。;；!?！？+-]+|['"`*_#[\]()<>{}:：,，.。;；!?！？+-]+$/g, "")
    .toLowerCase()
}

function isUsefulIngestSourceToken(token) {
  const normalized = normalizeIngestToken(token)
  if (!normalized) return false
  const upper = normalized.toUpperCase()
  const length = charLength(normalized)
  if (INGEST_UPPERCASE_KEEP_TOKENS.has(upper)) return true
  if (STOP_WORDS.has(normalized) || ASK_TIME_TOKENS.has(normalized)) return false
  if (GENERIC_QUERY_TOKENS.has(normalized) || INGEST_GENERIC_SOURCE_TOKENS.has(normalized)) return false
  if (INGEST_SOURCE_FIELD_TOKENS.has(normalized)) return false
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return false
  if (/^\d{4}(?:-\d{2}){0,2}$/.test(normalized)) return false
  if (/^[a-z0-9_.:-]+$/i.test(normalized)) {
    if (/[_.:-]/.test(normalized)) return false
    if (normalized.length <= 2) return false
    if (/^(?:cn|db|gt|md|html|http|https|www|com|mjs|json|txt|csv)$/.test(normalized)) return false
  }
  const cjkChars = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0
  if (cjkChars === 1 && !/[a-z]{2,}/i.test(normalized)) return false
  if (cjkChars === 0 && !/[a-z]{3,}/i.test(normalized) && !INGEST_UPPERCASE_KEEP_TOKENS.has(upper)) return false
  if (length > 24) return false
  return true
}

function extractSourceTopicSeed(sourceContent, sourcePath) {
  const { fm } = parseFrontmatter(sourceContent)
  const frontmatterHints = ["title", "name", "theme", "theme_name", "category_name"]
    .map((field) => (typeof fm[field] === "string" ? fm[field] : ""))
    .filter(Boolean)
  const basename = path.basename(sourcePath, path.extname(sourcePath))
  const pathHint = basename
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ")
    .replace(/(?:^|[-_/])(?:晨报|复盘|非热门)(?=$|[-_/])/g, " ")
  const headings = sourceContent
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+/.test(line.trim()))
    .slice(0, 16)
    .join("\n")
  return [pathHint, ...frontmatterHints, headings].join("\n")
}

function extractIngestPhraseTokens(text) {
  const tokens = []
  for (const seq of String(text ?? "").match(/[\u4e00-\u9fff\u3400-\u4dbf]{4,18}/g) ?? []) {
    const chars = [...seq]
    const maxN = Math.min(6, chars.length)
    for (let n = 4; n <= maxN; n++) {
      for (let i = 0; i <= chars.length - n; i++) {
        tokens.push(chars.slice(i, i + n).join(""))
      }
    }
    if (chars.length <= 10) tokens.push(seq)
  }
  return [...new Set(tokens)].filter(isUsefulIngestSourceToken)
}

function ingestSourceTokenSortWeight(token, phraseOnly) {
  let weight = tokenWeight(token)
  if (/^[a-z0-9]+$/i.test(token) && charLength(token) >= 3) weight += 0.45
  if (INGEST_IMPORTANT_PHRASE_REGEX.test(token)) weight += 1.1
  if (phraseOnly && !INGEST_IMPORTANT_PHRASE_REGEX.test(token)) weight -= 1.2
  return weight
}

export function extractSourceTokens(sourceContent, sourcePath, maxTokens = 180) {
  const seed = extractSourceSearchSeed(sourceContent, sourcePath)
  const topicSeed = extractSourceTopicSeed(sourceContent, sourcePath)
  const topicTokens = [
    ...tokenizeQuery(topicSeed),
    ...extractIngestPhraseTokens(topicSeed),
  ].filter(isUsefulIngestSourceToken)
  const lexicalTokens = tokenizeQuery(seed).filter(isUsefulIngestSourceToken)
  const phraseTokens = extractIngestPhraseTokens(seed)
  const weighted = new Map()
  const phraseOnly = new Set()
  const lowerSeed = seed.toLowerCase()
  for (const token of lexicalTokens) {
    const normalized = normalizeIngestToken(token)
    if (!normalized) continue
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const count = (lowerSeed.match(new RegExp(escaped, "g")) ?? []).length
    weighted.set(normalized, Math.max(weighted.get(normalized) ?? 0, count))
  }
  for (const token of phraseTokens) {
    const normalized = normalizeIngestToken(token)
    if (!normalized || weighted.has(normalized)) continue
    weighted.set(normalized, INGEST_IMPORTANT_PHRASE_REGEX.test(normalized) ? 1.05 : 0.6)
    phraseOnly.add(normalized)
  }
  for (const token of topicTokens) {
    const normalized = normalizeIngestToken(token)
    if (!normalized) continue
    weighted.set(normalized, (weighted.get(normalized) ?? 0) + 18)
    phraseOnly.delete(normalized)
  }
  return [...weighted.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] ||
        ingestSourceTokenSortWeight(b[0], phraseOnly.has(b[0])) - ingestSourceTokenSortWeight(a[0], phraseOnly.has(a[0])) ||
        charLength(b[0]) - charLength(a[0]),
    )
    .map(([token]) => token)
    .slice(0, maxTokens)
}

async function scoreFile({ filePath, projectPath, sourcePath, tokens, query, isRaw, mode }) {
  const retrievalMode = normalizeRetrievalMode(mode)
  let content
  try {
    content = await readTextFile(filePath)
  } catch {
    return null
  }

  const relativePath = projectRelative(projectPath, filePath)
  if (sourcePath && path.resolve(filePath) === path.resolve(sourcePath)) return null

  const title = extractTitle(content, filePath)
  const { fm } = parseFrontmatter(content)
  const type = normalizeTypeAlias(fm.type) ?? inferTypeFromPath(relativePath)
  const fmText = frontmatterSearchText(content)
  const fmStructure = scoreFrontmatterStructure(fm, tokens)
  const titleScore = tokenMatchScore(`${title} ${path.basename(filePath)}`, tokens)
  const contentScore = tokenMatchScore(content, tokens)
  const frontmatterScore = tokenMatchScore(fmText, tokens) * 1.5 + fmStructure.score
  let score = contentScore + frontmatterScore + topicCoverageBonus(content, tokens)
  if (titleScore > 0) score += 10 + titleScore
  score += titleCoverageBonus(`${title} ${path.basename(filePath)}`, tokens)
  if (isRaw && score > 0) score += 4 + rawPathQualityBonus(relativePath, title, tokens, { mode: retrievalMode })
  if (!isRaw && score > 0) score += specificWikiTypeBonus(type)
  let freshness = { score: 0, field: null, value: null, staleDays: null, timeSensitive: false }
  if (retrievalMode === RETRIEVAL_MODES.ASK) {
    freshness = frontmatterFreshnessScore(fm, query, type)
    if (score > 0) {
      score += getRecencyBoost(path.basename(filePath), query)
      score += freshness.score
    }
  }

  if (score <= 0) return null

  return {
    retrievalMode,
    path: relativePath,
    title,
    score,
    titleMatch: titleScore > 0,
    frontmatterMatch: frontmatterScore > 0,
    frontmatterMatches: fmStructure.matches,
    frontmatterSources: fmStructure.sources,
    frontmatterRelated: fmStructure.related,
    frontmatterTags: fmStructure.tags,
    frontmatterUpdated: freshness.value,
    frontmatterUpdatedField: freshness.field,
    staleDays: freshness.staleDays,
    freshnessScore: freshness.score,
    freshnessTimeSensitive: freshness.timeSensitive,
    raw: isRaw,
    type,
    snippet: buildSnippet(content, tokens),
  }
}

function buildWikiRelatedResolver(projectPath, wikiFiles) {
  const byNodeId = new Map()
  const byBasename = new Map()
  for (const filePath of wikiFiles) {
    const relativePath = projectRelative(projectPath, filePath)
    const nodeId = wikiRelativePathToNodeId(relativePath)
    if (!nodeId) continue
    byNodeId.set(nodeId, relativePath)
    const basename = nodeId.split("/").pop()
    if (!byBasename.has(basename)) byBasename.set(basename, [])
    byBasename.get(basename).push(relativePath)
  }

  return (rawTarget) => {
    const target = normalizeWikilinkTarget(rawTarget)
    if (!target || target.startsWith("raw/")) return null
    if (byNodeId.has(target)) return byNodeId.get(target)
    const basename = target.split("/").pop()
    const basenameMatches = byBasename.get(basename) ?? []
    if (basenameMatches.length === 1) return basenameMatches[0]
    const lowerTarget = target.toLowerCase()
    return basenameMatches.find((relativePath) => wikiRelativePathToNodeId(relativePath)?.toLowerCase() === lowerTarget) ?? null
  }
}

async function expandRelatedWikiCandidates({ projectPath, sourcePath, wikiFiles, wikiResults, tokens, query }) {
  if (wikiResults.length === 0) return []
  const resolveRelatedPath = buildWikiRelatedResolver(projectPath, wikiFiles)
  const byPath = new Map(wikiResults.map((item) => [item.path, item]))
  const relatedCandidates = []
  const seeds = sortSearchResults([...wikiResults]).filter((item) => item.type !== "总结").slice(0, 12)

  for (const seed of seeds) {
    for (const rawTarget of seed.frontmatterRelated ?? []) {
      const relatedPath = resolveRelatedPath(rawTarget)
      if (!relatedPath || isReservedWikiPath(relatedPath)) continue
      const inheritedScore = Math.max(1, seed.score * 0.38)
      const existing = byPath.get(relatedPath)
      if (existing) {
        existing.score = Math.max(existing.score, inheritedScore)
        existing.relatedFrom = [...new Set([...(existing.relatedFrom ?? []), seed.path])]
        continue
      }

      const filePath = path.join(projectPath, relatedPath)
      if (sourcePath && path.resolve(filePath) === path.resolve(sourcePath)) continue
      let content
      try {
        content = await readTextFile(filePath)
      } catch {
        continue
      }

      const { fm } = parseFrontmatter(content)
      const fmStructure = scoreFrontmatterStructure(fm, tokens)
      const candidate = {
        retrievalMode: RETRIEVAL_MODES.INGEST,
        path: relatedPath,
        title: extractTitle(content, filePath),
        score: inheritedScore + Math.min(fmStructure.score, 18),
        titleMatch: false,
        frontmatterMatch: true,
        frontmatterMatches: [...new Set(["related", ...fmStructure.matches])],
        frontmatterSources: fmStructure.sources,
        frontmatterRelated: fmStructure.related,
        frontmatterTags: fmStructure.tags,
        raw: false,
        type: normalizeTypeAlias(fm.type) ?? inferTypeFromPath(relatedPath),
        snippet: buildSnippet(content, tokens),
        relatedFrom: [seed.path],
      }
      byPath.set(relatedPath, candidate)
      relatedCandidates.push(candidate)
    }
  }
  return relatedCandidates
}

function lineNumberAtOffset(text, offset) {
  if (offset <= 0) return 1
  return text.slice(0, offset).split(/\r?\n/).length
}

function heatRank(heat) {
  const value = String(heat ?? "")
  if (/中高|较高/.test(value)) return 3
  if (/^高$|高热|很高/.test(value)) return 4
  if (/中/.test(value)) return 2
  if (/低/.test(value)) return 1
  return 0
}

function compactSegmentPreview(text, maxChars = 260) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
}

function isMultiTopicSourcePath(sourceRelativePath) {
  const relativePath = toPosixPath(sourceRelativePath)
  return /^raw\/(?:微信聊天|每日夜间交流)\//.test(relativePath)
}

function isDailyReviewSourcePath(sourceRelativePath) {
  const relativePath = toPosixPath(sourceRelativePath)
  return /^raw\/(?:日复盘|每日复盘)\//.test(relativePath) || /(?:^|\/)\d{4}-\d{2}-\d{2}-.{0,20}复盘\.md$/.test(relativePath)
}

function shouldBuildIngestSegments(sourceRelativePath, sourceContent, options = {}) {
  if (options.enableSegments === false || options.segmentedRetrieval === false) return false
  if (options.enableSegments === true || options.segmentedRetrieval === true) return true
  if (isMultiTopicSourcePath(sourceRelativePath)) return true
  return String(sourceContent ?? "").length > 45000 && /###\s*重点板块\/标的|^\d+\.\s+.+热度[:：]/m.test(String(sourceContent ?? ""))
}

function extractFocusBlocks(normalized) {
  const blocks = []
  const regex = /^###\s*重点板块\/标的\s*$/gm
  let match
  while ((match = regex.exec(normalized)) !== null) {
    const start = match.index + match[0].length
    const rest = normalized.slice(start)
    const endMatch = rest.search(/^###\s*(?:风险与待验证|完整调研原文|市场情绪|同步与窗口)\s*$|^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/m)
    const end = endMatch >= 0 ? start + endMatch : normalized.length
    blocks.push({ start, end, text: normalized.slice(start, end) })
  }
  return blocks
}

function parseFocusBlockSegments(normalized, block, startIndex) {
  const lines = block.text.split(/\n/)
  const segments = []
  let current = null
  let cursor = block.start

  function flush(endOffset) {
    if (!current) return
    const text = current.lines.join("\n").trim()
    if (text.length < 80) {
      current = null
      return
    }
    const title = current.title
    segments.push({
      id: `segment-${String(startIndex + segments.length + 1).padStart(2, "0")}`,
      title,
      heat: current.heat || "",
      sourceGroups: current.sourceGroups || "",
      sourceCount: current.sourceCount,
      lineStart: lineNumberAtOffset(normalized, current.startOffset),
      lineEnd: lineNumberAtOffset(normalized, endOffset),
      text,
      textPreview: compactSegmentPreview(text),
      searchText: [`${title} ${current.heat || ""} ${current.sourceGroups || ""}`, text].filter(Boolean).join("\n"),
    })
    current = null
  }

  for (const line of lines) {
    const lineStart = cursor
    cursor += line.length + 1
    const header = line.match(/^(\d+)\.\s+(.+?)\s*$/)
    if (header) {
      flush(lineStart)
      const rawTitle = header[2].trim()
      const title = rawTitle.split(/[｜|]/)[0].trim()
      const heat = rawTitle.match(/热度[:：]\s*([^｜|\n]+)/)?.[1]?.trim() ?? ""
      const sourceGroups = rawTitle.match(/命中群[:：]\s*([^｜|\n]+)/)?.[1]?.trim() ?? ""
      const sourceCountRaw = rawTitle.match(/原文数[:：]\s*(\d+)/)?.[1]
      current = {
        title,
        heat,
        sourceGroups,
        sourceCount: sourceCountRaw ? Number(sourceCountRaw) : null,
        startOffset: lineStart,
        lines: [line],
      }
      continue
    }
    if (current) current.lines.push(line)
  }
  flush(block.end)
  return segments
}

function parseLooseNumberedSegments(normalized, startIndex) {
  if (!/^\d+[.、)]\s+.+热度[:：]/m.test(normalized)) return []
  const lines = normalized.split(/\n/)
  const segments = []
  let current = null
  let cursor = 0

  function flush(endOffset) {
    if (!current) return
    const text = current.lines.join("\n").trim()
    if (text.length < 80) {
      current = null
      return
    }
    segments.push({
      id: `segment-${String(startIndex + segments.length + 1).padStart(2, "0")}`,
      title: current.title,
      heat: current.heat || "",
      sourceGroups: current.sourceGroups || "",
      sourceCount: current.sourceCount,
      lineStart: lineNumberAtOffset(normalized, current.startOffset),
      lineEnd: lineNumberAtOffset(normalized, endOffset),
      text,
      textPreview: compactSegmentPreview(text),
      searchText: [`${current.title} ${current.heat || ""} ${current.sourceGroups || ""}`, text].filter(Boolean).join("\n"),
    })
    current = null
  }

  for (const line of lines) {
    const lineStart = cursor
    cursor += line.length + 1
    const header = line.match(/^(\d+)[.、)]\s+(.+热度[:：].+?)\s*$/)
    if (header) {
      flush(lineStart)
      const rawTitle = header[2].trim()
      const title = rawTitle.split(/[｜|]/)[0].trim()
      const heat = rawTitle.match(/热度[:：]\s*([^｜|\n]+)/)?.[1]?.trim() ?? ""
      const sourceGroups = rawTitle.match(/命中群[:：]\s*([^｜|\n]+)/)?.[1]?.trim() ?? ""
      const sourceCountRaw = rawTitle.match(/原文数[:：]\s*(\d+)/)?.[1]
      current = {
        title,
        heat,
        sourceGroups,
        sourceCount: sourceCountRaw ? Number(sourceCountRaw) : null,
        startOffset: lineStart,
        lines: [line],
      }
      continue
    }
    if (/^#{2,3}\s+/.test(line) && current) {
      flush(lineStart)
      continue
    }
    if (current) current.lines.push(line)
  }
  flush(normalized.length)
  return segments
}

function extractIngestSourceSegments(sourceContent, sourcePath, sourceRelativePath, options = {}) {
  if (!shouldBuildIngestSegments(sourceRelativePath, sourceContent, options)) return []
  const normalized = String(sourceContent ?? "").replace(/\r\n/g, "\n")
  const focusBlocks = extractFocusBlocks(normalized)
  const segments = []
  for (const block of focusBlocks) {
    segments.push(...parseFocusBlockSegments(normalized, block, segments.length))
  }
  if (!segments.length) {
    segments.push(...parseLooseNumberedSegments(normalized, segments.length))
  }
  const maxSegments = options.maxSegments ?? INGEST_SEGMENT_DEFAULT_MAX
  return segments
    .filter((segment) => segment.title && !/^(同步与窗口|市场情绪|风险与待验证|完整调研原文)$/.test(segment.title))
    .sort((a, b) => heatRank(b.heat) - heatRank(a.heat) || (b.sourceCount ?? 0) - (a.sourceCount ?? 0) || a.lineStart - b.lineStart)
    .slice(0, maxSegments)
    .map((segment, index) => ({
      ...segment,
      id: `segment-${String(index + 1).padStart(2, "0")}`,
      sourcePath: sourceRelativePath,
    }))
}

function mergeMatchedSegments(existing, segmentRef) {
  const refs = [...(existing.matchedSegments ?? [])]
  if (!refs.some((item) => item.id === segmentRef.id)) refs.push(segmentRef)
  return refs
}

function segmentRef(segment) {
  return { id: segment.id, title: segment.title, heat: segment.heat || "" }
}

function cloneSegmentCandidate(item, segment) {
  return {
    ...item,
    matchedSegments: [segmentRef(segment)],
  }
}

function prioritizeNonSummaryCandidates(candidates, allowSummaryLead = false) {
  const sorted = sortSearchResults(candidates)
  if (allowSummaryLead) return sorted
  return sorted.sort((a, b) => {
    const aSummary = a.type === "总结" ? 1 : 0
    const bSummary = b.type === "总结" ? 1 : 0
    if (aSummary !== bSummary) return aSummary - bSummary
    return Number(b.score ?? 0) - Number(a.score ?? 0)
  })
}

function mergeSegmentedCandidateResults(base, segments, options = {}) {
  if (!segments.length) return { ...base, segments: [] }
  const summaryMultiplier = options.summaryCandidateMultiplier ?? 0.62
  const segmentMultiplier = options.segmentCandidateMultiplier ?? 0.95
  const wikiByPath = new Map()

  function addWikiCandidate(item, segment = null, multiplier = 1) {
    const scoreMultiplier = item.type === "总结" ? Math.min(multiplier, summaryMultiplier) : multiplier
    const candidate = {
      ...item,
      score: item.score * scoreMultiplier,
    }
    if (segment) {
      candidate.segmentOnly = true
      candidate.matchedSegments = mergeMatchedSegments(candidate, segmentRef(segment))
    }
    const existing = wikiByPath.get(candidate.path)
    if (!existing) {
      wikiByPath.set(candidate.path, candidate)
      return
    }
    existing.score = Math.max(existing.score, candidate.score)
    existing.frontmatterMatches = [...new Set([...(existing.frontmatterMatches ?? []), ...(candidate.frontmatterMatches ?? [])])]
    existing.relatedFrom = [...new Set([...(existing.relatedFrom ?? []), ...(candidate.relatedFrom ?? [])])]
    if (segment) existing.matchedSegments = mergeMatchedSegments(existing, segmentRef(segment))
  }

  for (const item of base.wikiCandidates) addWikiCandidate(item)
  for (const segment of segments) {
    for (const item of segment.wikiCandidates ?? []) addWikiCandidate(item, segment, segmentMultiplier)
  }

  const rawByPath = new Map()
  function addRawCandidate(item, segment = null, multiplier = 1) {
    const candidate = { ...item, score: item.score * multiplier }
    if (segment) candidate.matchedSegments = mergeMatchedSegments(candidate, segmentRef(segment))
    const existing = rawByPath.get(candidate.path)
    if (!existing) {
      rawByPath.set(candidate.path, candidate)
      return
    }
    existing.score = Math.max(existing.score, candidate.score)
    if (segment) existing.matchedSegments = mergeMatchedSegments(existing, segmentRef(segment))
  }
  for (const item of base.rawCandidates) addRawCandidate(item)
  for (const segment of segments) {
    for (const item of segment.rawCandidates ?? []) addRawCandidate(item, segment, segmentMultiplier)
  }

  return {
    ...base,
    wikiCandidates: prioritizeNonSummaryCandidates([...wikiByPath.values()], options.allowSummaryLead).slice(0, options.topWiki ?? 30),
    rawCandidates: sortSearchResults([...rawByPath.values()]).slice(0, options.topRaw ?? 20),
    segments,
  }
}

async function searchCandidatePagesCore({ projectPath, sourcePath, sourceContent, options, wikiFiles, rawFilesAll }) {
  const query = extractSourceSearchSeed(sourceContent, sourcePath)
  const tokens = extractSourceTokens(sourceContent, sourcePath, options.maxTokens ?? 180)
  const effectiveTokens = tokens.length > 0 ? tokens : tokenizeQuery(path.basename(sourcePath))
  const rawFiles = filterRawFilesByQueryPolicy(rawFilesAll, query, {
    ...options,
    mode: RETRIEVAL_MODES.INGEST,
    maxRawFiles: options.maxRawFiles ?? options.rawScanLimit ?? 240,
  })

  const wikiResults = []
  for (const filePath of wikiFiles) {
    const relativePath = projectRelative(projectPath, filePath)
    if (isReservedWikiPath(relativePath)) continue
    const scored = await scoreFile({
      filePath,
      projectPath,
      sourcePath,
      tokens: effectiveTokens,
      query,
      isRaw: false,
      mode: RETRIEVAL_MODES.INGEST,
    })
    if (scored) wikiResults.push(scored)
  }
  wikiResults.push(
    ...(await expandRelatedWikiCandidates({
      projectPath,
      sourcePath,
      wikiFiles,
      wikiResults,
      tokens: effectiveTokens,
      query,
    })),
  )

  const rawResults = []
  for (const filePath of rawFiles) {
    const scored = await scoreFile({
      filePath,
      projectPath,
      sourcePath,
      tokens: effectiveTokens,
      query,
      isRaw: true,
      mode: RETRIEVAL_MODES.INGEST,
    })
    if (scored) rawResults.push(scored)
  }

  const sortResults = (items) =>
    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const dateA = a.path.match(/(\d{4})-(\d{2})-(\d{2})/)
      const dateB = b.path.match(/(\d{4})-(\d{2})-(\d{2})/)
      if (dateA && dateB) return dateB[0].localeCompare(dateA[0])
      if (dateB) return 1
      if (dateA) return -1
      return a.path.localeCompare(b.path)
    })

  return {
    retrievalMode: RETRIEVAL_MODES.INGEST,
    tokens: effectiveTokens,
    wikiCandidates: sortResults(wikiResults).slice(0, options.topWiki ?? 30),
    rawCandidates: sortResults(rawResults).slice(0, options.topRaw ?? 20),
  }
}

async function buildSegmentedCandidateResults({ projectPath, sourcePath, sourceRelativePath, sourceContent, options, wikiFiles, rawFilesAll }) {
  const extracted = extractIngestSourceSegments(sourceContent, sourcePath, sourceRelativePath, options)
  const segments = []
  for (const segment of extracted) {
    const result = await searchCandidatePagesCore({
      projectPath,
      sourcePath,
      sourceContent: segment.searchText,
      options: {
        ...options,
        topWiki: options.segmentTopWiki ?? INGEST_SEGMENT_WIKI_LIMIT,
        topRaw: options.segmentTopRaw ?? INGEST_SEGMENT_RAW_LIMIT,
        maxTokens: options.segmentMaxTokens ?? 100,
      },
      wikiFiles,
      rawFilesAll,
    })
    segments.push({
      ...segment,
      retrievalMode: RETRIEVAL_MODES.INGEST,
      tokens: result.tokens,
      wikiCandidates: prioritizeNonSummaryCandidates(
        result.wikiCandidates.map((item) => cloneSegmentCandidate(item, segment)),
        options.allowSummaryLead,
      ),
      rawCandidates: result.rawCandidates.map((item) => cloneSegmentCandidate(item, segment)),
    })
  }
  return segments
}

export async function searchCandidatePages(projectPath, sourcePath, sourceContent, options = {}) {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const sourceRelativePath = projectRelative(pp, sp)

  const wikiFiles = await listFilesRecursive(path.join(pp, "wiki"), {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
  })

  const rawFilesAll = await listFilesRecursive(path.join(pp, "raw"), {
    extensions: TEXT_EXTENSIONS,
    excludeDirNames: new Set([".git", ".llm-wiki", ".obsidian", "scripts", "templates", "archive", "assets"]),
    maxBytes: options.maxRawBytes ?? 512000,
    preferRecent: true,
    maxFiles: options.rawScanLimit ?? 240,
  })

  const base = await searchCandidatePagesCore({
    projectPath: pp,
    sourcePath: sp,
    sourceContent,
    options,
    wikiFiles,
    rawFilesAll,
  })
  const segments = options.enableSegments === false
    ? []
    : await buildSegmentedCandidateResults({
        projectPath: pp,
        sourcePath: sp,
        sourceRelativePath,
        sourceContent,
        options: {
          ...options,
          allowSummaryLead: options.allowSummaryLead ?? isDailyReviewSourcePath(sourceRelativePath),
        },
        wikiFiles,
        rawFilesAll,
      })
  return mergeSegmentedCandidateResults(base, segments, {
    ...options,
    allowSummaryLead: options.allowSummaryLead ?? isDailyReviewSourcePath(sourceRelativePath),
  })
}

function compactMethodologyList(items, maxItems = 8) {
  if (!Array.isArray(items)) return ""
  return items
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxItems)
    .map((item) => item.trim())
    .join(", ")
}

function truncateMethodologyText(text, maxChars) {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const boundary = Math.max(slice.lastIndexOf("\n### "), slice.lastIndexOf("\n## "), slice.lastIndexOf("\n- "), slice.lastIndexOf("\n"))
  const end = boundary > maxChars * 0.55 ? boundary : maxChars
  return `${slice.slice(0, end).trimEnd()}\n...（本方法论摘录已截断，完整内容见对应 wiki 页面）`
}

function compactMethodologyLine(line, maxChars = 220) {
  const trimmed = line.replace(/\s+/g, " ").trim()
  if (!trimmed) return ""
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}...`
}

function selectMethodologyLines(body, options = {}) {
  const maxHeadingLines = options.maxHeadingLines ?? 18
  const maxImportantLines = options.maxImportantLines ?? 32
  const headings = []
  const important = []
  const seen = new Set()

  for (const rawLine of body.split(/\r?\n/)) {
    const line = compactMethodologyLine(rawLine)
    if (!line) continue
    if (/^```/.test(line)) continue
    if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue

    if (/^#{1,6}\s+/.test(line) && headings.length < maxHeadingLines) {
      headings.push(line)
    }

    if (important.length >= maxImportantLines) continue
    if (!METHODOLOGY_IMPORTANT_LINE_REGEX.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    important.push(line)
  }

  return { headings, important }
}

function parseMethodologyPage(content) {
  const wrapped = content.match(/^```yaml\s*\r?\n(---\r?\n[\s\S]*?\r?\n---)\r?\n```\s*\r?\n?/i)
  if (!wrapped) return parseFrontmatter(content)
  const { fm } = parseFrontmatter(`${wrapped[1]}\n`)
  return { fm, body: content.slice(wrapped[0].length) }
}

function compactMethodologyPage(relativePath, content, charLimit) {
  const title = extractTitle(content, relativePath)
  const { fm, body } = parseMethodologyPage(content)
  const type = normalizeTypeAlias(fm.type) ?? inferTypeFromPath(relativePath)
  const summary = typeof fm.summary === "string" ? compactMethodologyLine(fm.summary, 260) : ""
  const tags = compactMethodologyList(fm.tags, 10)
  const related = compactMethodologyList(fm.related, 10)
  const { headings, important } = selectMethodologyLines(body)
  const fallback = body
    .split(/\r?\n/)
    .map((line) => compactMethodologyLine(line))
    .filter(Boolean)
    .slice(0, 12)

  const lines = [
    `### ${relativePath} — ${title}`,
    `- type: ${type}`,
    summary ? `- summary: ${summary}` : "",
    tags ? `- tags: ${tags}` : "",
    related ? `- related: ${related}` : "",
    headings.length > 0 ? "- headings:" : "",
    ...headings.map((line) => `  - ${line.replace(/^#+\s*/, "")}`),
    important.length > 0 ? "- key excerpts:" : "- lead excerpts:",
    ...(important.length > 0 ? important : fallback).map((line) => `  - ${line.replace(/^[-*]\s*/, "")}`),
  ].filter(Boolean)

  return truncateMethodologyText(lines.join("\n"), charLimit)
}

function buildMethodologyStage3Rules(paths) {
  return truncateMethodologyText(
    [
      "## Methodology Guardrails",
      "- Stage 1/2 already received the full compact methodology pack; use this page-level snippet as hard writing rules.",
      "- Treat source text as evidence, and methodology pages as decision rules. Do not cite methodology snippets as new market facts.",
      "- Keep the ingest aligned with 盘前预测 / 盘中执行 / 盘后验证 / 明日验证清单.",
      "- Separate fact strength from heat: official disclosures, financial data, policy text, and verifiable market data outrank research inference, group chat, and unverified writeups.",
      "- Use the L1-L4 decision structure when deciding whether a theme is strategy-level, execution-level, observation-only, or error/discipline material.",
      "- For catalysts, distinguish hard catalyst, soft catalyst, price expectation, verification window, and evidence failure. High attention alone is not a buy point.",
      "- For errors and exits, preserve the trigger, violated rule, correct action, and next validation condition rather than writing a generic lesson.",
      "- For strategy pages, make the output operational: decision preconditions, execution trigger, invalidation/exit rule, and tomorrow's checklist.",
      `- Methodology source paths: ${paths.join(" / ")}`,
    ].join("\n"),
    METHODOLOGY_STAGE3_RULE_CHAR_SOFT_LIMIT,
  )
}

export async function buildMethodologyContext(projectPath, options = {}) {
  if (options === false || options.enabled === false) {
    return {
      enabled: false,
      markdown: "",
      stage3Rules: "",
      paths: [],
      missingPaths: [],
      stats: { sourceChars: 0, promptChars: 0 },
    }
  }

  const pp = normalizePath(projectPath)
  const paths = Array.isArray(options.paths) && options.paths.length > 0 ? options.paths : METHODOLOGY_CONTEXT_PATHS
  const perPageChars = parsePositiveInteger(options.perPageChars, METHODOLOGY_PAGE_CHAR_SOFT_LIMIT)
  const totalChars = parsePositiveInteger(options.totalChars, METHODOLOGY_CONTEXT_TOTAL_CHAR_SOFT_LIMIT)
  const pageSources = []
  const missingPaths = []
  let sourceChars = 0

  for (const rawRelativePath of paths) {
    const relativePath = toPosixPath(String(rawRelativePath ?? "").trim()).replace(/^\/+/, "")
    if (!relativePath || relativePath.includes("..") || !relativePath.startsWith("wiki/")) continue
    const fullPath = path.join(pp, relativePath)
    const content = await readIfExists(fullPath)
    if (!content.trim()) {
      missingPaths.push(relativePath)
      continue
    }
    sourceChars += content.length
    pageSources.push({
      path: relativePath,
      content,
    })
  }

  if (pageSources.length === 0) {
    return {
      enabled: true,
      markdown: "",
      stage3Rules: "",
      paths: [],
      missingPaths,
      stats: { sourceChars, promptChars: 0 },
    }
  }

  const headerLines = [
    "## Methodology Pre-read Pack",
    "",
    "Use this compact pack as durable trading-system methodology, not as source evidence. It exists to keep ingest decisions aligned with the user's execution framework.",
    "",
    "### Application Rules",
    "- Prefer execution-ready structure over generic summaries.",
    "- Map durable knowledge into 盘前预测 / 盘中执行 / 盘后验证 / 明日验证清单 when the source supports it.",
    "- Distinguish facts, inference, sentiment, catalyst quality, and price action absorption.",
    "- Do not upgrade chat heat or research conviction into verified fact strength.",
    "- For catalyst material, record catalyst level, verification window, invalidation signal, and whether it creates only observation or an actionable L4 setup.",
    "- For strategy/error material, preserve triggers, violated rules, correct action, and follow-up validation.",
    "",
    "### Source Page Extracts",
  ]
  const headerChars = headerLines.join("\n").length
  const totalPageBudget = Math.max(2400, totalChars - headerChars - 120)
  const effectivePerPageChars = Math.max(650, Math.min(perPageChars, Math.floor(totalPageBudget / pageSources.length)))
  const pages = pageSources.map((page) => ({
    path: page.path,
    markdown: compactMethodologyPage(page.path, page.content, effectivePerPageChars),
  }))
  const markdown = truncateMethodologyText([...headerLines, ...pages.map((page) => page.markdown)].join("\n"), totalChars)

  return {
    enabled: true,
    markdown,
    stage3Rules: buildMethodologyStage3Rules(pages.map((page) => page.path)),
    paths: pages.map((page) => page.path),
    missingPaths,
    stats: {
      sourceChars,
      promptChars: markdown.length,
      perPagePromptChars: effectivePerPageChars,
    },
  }
}

function parseJsonObjectFromModelText(text) {
  return parseModelJson(text)
}

function parseAskSourcesOption(value) {
  const raw = String(value ?? "auto").trim()
  if (!raw || raw === "auto") return null
  const sourceIds = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ASK_SOURCE_ALIASES.get(item) ?? item)
  const unknown = sourceIds.filter((id) => !ASK_SOURCE_IDS.includes(id))
  if (unknown.length > 0) throw new Error(`Unknown ask source(s): ${unknown.join(", ")}`)
  return [...new Set(sourceIds)]
}

function isStockDailyQuestion(query) {
  STOCK_CODE_LIKE_REGEX.lastIndex = 0
  return STOCK_DAILY_KEYWORD_REGEX.test(query) || STOCK_CODE_LIKE_REGEX.test(query)
}

function isTradeReviewQuestion(query) {
  return TRADE_REVIEW_KEYWORD_REGEX.test(String(query ?? "").replace(/交易日/g, ""))
}

function isFactsQuestion(query) {
  return FACTS_KEYWORD_REGEX.test(query)
}

function isBrainQuestion(query) {
  return BRAIN_KEYWORD_REGEX.test(query)
}

function isRawNewsQuestion(query) {
  return RAW_NEWS_KEYWORD_REGEX.test(query)
}

function readStockDailyPgConfigFile(env = process.env, options = {}) {
  const configPath = options.pgConfigPath ?? env.PG_SHIHAO_CONFIG_PATH
  if (!configPath) return { config: {}, error: null }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"))
    return {
      config: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
      error: null,
    }
  } catch (err) {
    return { config: {}, error: `PG_SHIHAO_CONFIG_PATH unreadable: ${safeErrorMessage(err)}` }
  }
}

function readStockDailyPgPasswordFromKeychain(env = process.env, options = {}) {
  if (options.disablePgKeychain || env.TRADING_WIKI_DISABLE_PG_KEYCHAIN === "1") return null
  if (env.VITEST || env.NODE_ENV === "test") return null
  const service = options.pgKeychainService ?? env.TRADING_WIKI_PG_KEYCHAIN_SERVICE ?? ASK_STOCK_DAILY_KEYCHAIN_SERVICE
  const account = options.pgKeychainAccount ?? env.TRADING_WIKI_PG_KEYCHAIN_ACCOUNT ?? ASK_STOCK_DAILY_KEYCHAIN_ACCOUNT
  if (!service || !account) return null
  try {
    const output = execFileSync(
      "security",
      ["find-generic-password", "-s", String(service), "-a", String(account), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500 },
    )
    const password = output.trim()
    return password || null
  } catch {
    return null
  }
}

function getStockDailyPgConfig(env = process.env, options = {}) {
  const fileConfig = readStockDailyPgConfigFile(env, options)
  const explicitPassword = options.pgPassword ?? env.PG_SHIHAO_PASSWORD ?? fileConfig.config.password
  const rawPort = options.pgPort ?? env.PG_SHIHAO_PORT ?? fileConfig.config.port
  return {
    host: options.pgHost ?? env.PG_SHIHAO_HOST ?? fileConfig.config.host,
    port: rawPort === undefined || rawPort === null || rawPort === "" ? undefined : Number(rawPort),
    user: options.pgUser ?? env.PG_SHIHAO_USER ?? fileConfig.config.user,
    password: explicitPassword ?? readStockDailyPgPasswordFromKeychain(env, options),
    database: options.pgDatabase ?? env.PG_SHIHAO_DATABASE ?? fileConfig.config.database ?? ASK_STOCK_DAILY_DEFAULT_DATABASE,
    schema: options.pgSchema ?? env.PG_SHIHAO_SCHEMA ?? fileConfig.config.schema ?? ASK_STOCK_DAILY_DEFAULT_SCHEMA,
    table: options.pgTable ?? env.PG_SHIHAO_STOCK_DAILY_TABLE ?? fileConfig.config.table ?? ASK_STOCK_DAILY_DEFAULT_TABLE,
    configError: fileConfig.error,
  }
}

function hasUsableStockDailyPgConfig(config) {
  return Boolean(config.host && config.port && config.user && config.password && config.database && config.schema && config.table)
}

function stockDailyPgConfigUnavailableReason(config) {
  if (config.configError) return config.configError
  const missing = []
  if (!config.host) missing.push("PG_SHIHAO_HOST")
  if (!Number.isFinite(config.port) || config.port <= 0) missing.push("PG_SHIHAO_PORT")
  if (!config.user) missing.push("PG_SHIHAO_USER")
  if (!config.password) missing.push("PG_SHIHAO_PASSWORD")
  if (!config.database) missing.push("PG_SHIHAO_DATABASE")
  if (!config.schema) missing.push("PG_SHIHAO_SCHEMA")
  if (!config.table) missing.push("PG_SHIHAO_STOCK_DAILY_TABLE")
  return missing.length > 0 ? `${missing.join(", ")} is not set` : "stock SQL config is not usable"
}

function redactPgConfig(config) {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    schema: config.schema,
    table: config.table,
    password: config.password ? "[redacted]" : undefined,
  }
}

function safeErrorMessage(err) {
  return String(err instanceof Error ? err.message : err ?? "unknown error").replace(/password=[^\s]+/gi, "password=[redacted]")
}

function quotePgIdentifier(identifier) {
  const clean = String(identifier ?? "")
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) throw new Error(`Unsafe PostgreSQL identifier: ${clean}`)
  return `"${clean.replace(/"/g, '""')}"`
}

function findColumn(columns, candidates) {
  const lowerToOriginal = new Map(columns.map((column) => [String(column).toLowerCase(), String(column)]))
  for (const candidate of candidates) {
    const found = lowerToOriginal.get(candidate.toLowerCase())
    if (found) return found
  }
  return null
}

function resolveStockDailyColumns(columns = []) {
  const names = [...new Set(columns.map((column) => String(column).trim()).filter(Boolean))]
  const resolved = {
    all: names,
    ticker: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.ticker),
    date: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.date),
    open: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.open),
    high: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.high),
    low: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.low),
    close: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.close),
    preClose: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.preClose),
    change: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.change),
    pctChange: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.pctChange),
    volume: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.volume),
    amount: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.amount),
    turnover: findColumn(names, STOCK_DAILY_COLUMN_CANDIDATES.turnover),
  }
  resolved.ready = Boolean(resolved.ticker && resolved.date)
  return resolved
}

async function loadPgClient() {
  const mod = await import("pg")
  const Client = mod.Client ?? mod.default?.Client
  if (!Client) throw new Error("Missing PostgreSQL Client export from pg")
  return Client
}

async function describeStockDailySqlSource(options = {}) {
  const config = getStockDailyPgConfig(process.env, options)
  if (Array.isArray(options.stockDailyColumns) && options.stockDailyColumns.length > 0) {
    const columns = resolveStockDailyColumns(options.stockDailyColumns)
    return { ok: columns.ready, config: redactPgConfig(config), columns, error: columns.ready ? null : "stockDailyColumns missing ticker/date columns" }
  }
  if (!hasUsableStockDailyPgConfig(config)) {
    return { ok: false, config: redactPgConfig(config), columns: resolveStockDailyColumns([]), error: stockDailyPgConfigUnavailableReason(config) }
  }
  const Client = await loadPgClient()
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: false,
    connectionTimeoutMillis: parsePositiveInteger(options.pgConnectTimeoutMs, 5000),
  })
  try {
    await client.connect()
    await client.query("select set_config('statement_timeout', $1, false)", [`${parsePositiveInteger(options.pgStatementTimeoutMs, 8000)}ms`])
    const result = await client.query(
      `
        select column_name
        from information_schema.columns
        where table_schema = $1
          and table_name = $2
        order by ordinal_position
      `,
      [config.schema, config.table],
    )
    const columns = resolveStockDailyColumns(result.rows.map((row) => row.column_name))
    return {
      ok: columns.ready,
      config: redactPgConfig(config),
      columns,
      error: columns.ready ? null : `Missing required ticker/date columns on ${config.schema}.${config.table}`,
    }
  } catch (err) {
    return { ok: false, config: redactPgConfig(config), columns: resolveStockDailyColumns([]), error: safeErrorMessage(err) }
  } finally {
    await client.end().catch(() => {})
  }
}

async function loadStockCodeMapping(projectPath) {
  const mapping = new Map()
  try {
    const raw = await fs.readFile(path.join(projectPath, ".llm-wiki", "stock-codes.json"), "utf8")
    const parsed = JSON.parse(raw)
    for (const [name, code] of Object.entries(parsed.mapping ?? {})) {
      if (name && code) mapping.set(String(name), String(code).toUpperCase())
    }
  } catch {}

  const stockDir = path.join(projectPath, "wiki", "股票")
  const files = await listFilesRecursive(stockDir, {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
  }).catch(() => [])
  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8")
      const { fm } = parseFrontmatter(content)
      const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : path.basename(filePath, ".md")
      if (typeof fm.code === "string" && fm.code.trim()) mapping.set(title, fm.code.trim().toUpperCase())
    } catch {}
  }
  return mapping
}

function normalizeStockCode(raw) {
  const value = String(raw ?? "").trim().toUpperCase()
  if (/^(?:SZ|SH|BJ)\d{6}$/.test(value)) return value
  const dot = value.match(/^(\d{6})\.(SZ|SH|BJ)$/)
  if (dot) return `${dot[2]}${dot[1]}`
  if (/^\d{6}$/.test(value)) {
    if (value.startsWith("6")) return `SH${value}`
    if (value.startsWith("8") || value.startsWith("4")) return `BJ${value}`
    return `SZ${value}`
  }
  return null
}

function stockCodeAlternatives(code) {
  const normalized = normalizeStockCode(code)
  if (!normalized) return []
  const exchange = normalized.slice(0, 2)
  const digits = normalized.slice(2)
  return [...new Set([normalized, `${digits}.${exchange}`, digits])]
}

function parseStockLookbackDays(query) {
  const numeric = String(query).match(/(?:最近|近)\s*(\d+)\s*(?:个)?(?:交易日|日|天)/)
  if (numeric) return Math.max(1, Math.min(Number(numeric[1]), 260))
  if (/最近一周|近一周|近7天|本周/.test(query)) return 5
  if (/最近一个月|近一个月|近30天|本月/.test(query)) return 22
  if (/最近三个月|近三个月|近90天/.test(query)) return 66
  return 20
}

export function parseStockDailyIntent(query, options = {}) {
  const text = String(query ?? "")
  STOCK_CODE_LIKE_REGEX.lastIndex = 0
  const explicitCodes = [...text.matchAll(STOCK_CODE_LIKE_REGEX)]
    .map((match) => normalizeStockCode(match[0]))
    .filter(Boolean)
  const mapping = options.stockCodeMapping instanceof Map ? options.stockCodeMapping : new Map(Object.entries(options.stockCodeMapping ?? {}))
  const nameMatches = []
  for (const [name, code] of mapping.entries()) {
    if (name && text.includes(name)) nameMatches.push({ name, code: normalizeStockCode(code) })
  }
  nameMatches.sort((a, b) => [...b.name].length - [...a.name].length || a.name.localeCompare(b.name))
  const primaryCode = explicitCodes[0] ?? nameMatches.find((item) => item.code)?.code ?? null
  return {
    isStockQuestion: isStockDailyQuestion(text),
    lookbackDays: parseStockLookbackDays(text),
    stockName: nameMatches[0]?.name ?? null,
    stockCode: primaryCode,
    tickerCandidates: stockCodeAlternatives(primaryCode),
    wantsVolume: /成交量|量能|放量|缩量|volume|vol/i.test(text),
    wantsAmount: /成交额|金额|amount|amt/i.test(text),
    wantsPctChange: /涨跌|涨幅|跌幅|收益|pct|change/i.test(text),
  }
}

export function buildStockDailySqlQuery(intent, descriptor, options = {}) {
  const columns = descriptor?.columns ?? resolveStockDailyColumns([])
  if (!columns.ready) throw new Error("stock_daily_sql is unavailable: missing ticker/date columns")
  if (!intent?.stockCode || intent.tickerCandidates.length === 0) throw new Error("stock_daily_sql needs a stock code or resolvable stock name")
  const config = getStockDailyPgConfig(process.env, options)
  const table = `${quotePgIdentifier(config.schema)}.${quotePgIdentifier(config.table)}`
  const selected = [
    columns.ticker,
    columns.date,
    columns.open,
    columns.high,
    columns.low,
    columns.close,
    columns.preClose,
    columns.change,
    columns.pctChange,
    columns.volume,
    columns.amount,
    columns.turnover,
  ].filter(Boolean)
  const uniqueSelected = [...new Set(selected)]
  const selectSql = uniqueSelected.map((column) => quotePgIdentifier(column)).join(", ")
  const limit = Math.min(parsePositiveInteger(options.sqlLimit, ASK_DEFAULT_SQL_LIMIT), Math.max(1, intent.lookbackDays))
  const sql = `
with recent_rows as (
  select ${selectSql}
  from ${table}
  where ${quotePgIdentifier(columns.ticker)} = any($1::text[])
  order by ${quotePgIdentifier(columns.date)} desc
  limit $2
)
select *
from recent_rows
order by ${quotePgIdentifier(columns.date)} asc
`.trim()
  return {
    language: "SQL",
    sql,
    params: [intent.tickerCandidates, limit],
    summary: `SELECT ${uniqueSelected.join(", ")} FROM ${config.schema}.${config.table} WHERE ${columns.ticker}=ANY($1) ORDER BY ${columns.date} DESC LIMIT ${limit}`,
    table: `${config.database}.${config.schema}.${config.table}`,
    limit,
    tickerCandidates: intent.tickerCandidates,
  }
}

async function executeStockDailyQuery(nativeQuery, options = {}) {
  if (options.stockDailyExecutor) return options.stockDailyExecutor({ nativeQuery, options })
  const config = getStockDailyPgConfig(process.env, options)
  if (!hasUsableStockDailyPgConfig(config)) throw new Error(stockDailyPgConfigUnavailableReason(config))
  const Client = await loadPgClient()
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: false,
    connectionTimeoutMillis: parsePositiveInteger(options.pgConnectTimeoutMs, 5000),
  })
  try {
    await client.connect()
    await client.query("begin read only")
    await client.query("select set_config('statement_timeout', $1, true)", [`${parsePositiveInteger(options.pgStatementTimeoutMs, 8000)}ms`])
    const result = await client.query(nativeQuery.sql, nativeQuery.params)
    await client.query("commit")
    return { rows: result.rows, rowCount: result.rowCount }
  } catch (err) {
    await client.query("rollback").catch(() => {})
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

function formatSqlCell(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  if (value == null) return ""
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : String(value)
  return String(value)
}

function sqlDateSortValue(value) {
  if (value instanceof Date) return value.getTime()
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : String(value ?? "")
}

function validationAnchorFromPrediction(prediction) {
  const parsed = parseLocalTimestampParts(prediction?.createdAt ?? prediction?.answeredAt ?? prediction?.date)
  if (!parsed?.date) return null
  return {
    date: parsed.date,
    exclusive: Boolean(parsed.time && parsed.time >= "15:00:00"),
    source: prediction?.createdAt ? "createdAt" : prediction?.answeredAt ? "answeredAt" : "date",
  }
}

function numberFromSqlCell(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (value == null) return null
  const parsed = Number(String(value).replace(/,/g, "").trim())
  return Number.isFinite(parsed) ? parsed : null
}

function averageNumbers(values) {
  const nums = values.map(numberFromSqlCell).filter((value) => value != null)
  if (nums.length === 0) return null
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

function roundMetric(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function stockDailyRowRef(row, columns, fallbackCode, tableName) {
  const ticker = row[columns.ticker] ?? fallbackCode ?? "UNKNOWN"
  const date = formatSqlCell(row[columns.date] ?? "unknown-date")
  return `sql:${tableName}#${ticker}/${date}`
}

function stockDailyRowsToEvidence({ rows, nativeQuery, descriptor, intent }) {
  const columns = descriptor.columns
  const tableName = nativeQuery.table.split(".").slice(-1)[0]
  return rows.map((row, index) => {
    const refPath = stockDailyRowRef(row, columns, intent.stockCode, tableName)
    const fields = Object.entries(row)
      .map(([key, value]) => `${key}=${formatSqlCell(value)}`)
      .join(", ")
    return {
      sourceId: "stock_daily_sql",
      path: refPath,
      title: `${intent.stockName ? `${intent.stockName} ` : ""}${intent.stockCode ?? ""} 日线 ${formatSqlCell(row[columns.date])}`,
      score: 30 - index * 0.2,
      type: "SQL",
      nativeQuery: nativeQuery.summary,
      excerpt: fields,
      row,
    }
  })
}

function inferMarketValidationDirection(query) {
  const text = String(query ?? "").replace(/涨跌幅|涨跌|跌幅/g, "")
  if (/(?:看空|下跌|走弱|风险|回撤|破位|跌)/.test(text)) return "bearish"
  if (/(?:看多|上涨|走强|补涨|突破|有空间|空间|强势|修复|反弹)/.test(text)) return "bullish"
  return "neutral"
}

function verdictFromMarketMove({ direction, periodReturnPct, lastVolumeVsAvg }) {
  if (periodReturnPct == null) return { verdict: "证据不足", reason: "SQL 日线缺少可计算的收盘价列" }
  if (direction === "bullish") {
    if (periodReturnPct >= 3 && (lastVolumeVsAvg == null || lastVolumeVsAvg >= 0.8)) {
      return { verdict: "验证通过", reason: "看多/补涨假设得到区间正收益支撑，且末日量能不明显弱于均量" }
    }
    if (periodReturnPct <= -3) return { verdict: "验证失败", reason: "看多/补涨假设与区间负收益冲突" }
    return { verdict: "待继续观察", reason: "区间收益幅度未达到明确验证阈值" }
  }
  if (direction === "bearish") {
    if (periodReturnPct <= -3) return { verdict: "验证通过", reason: "看空/风险假设得到区间负收益支撑" }
    if (periodReturnPct >= 3 && (lastVolumeVsAvg == null || lastVolumeVsAvg >= 0.8)) {
      return { verdict: "验证失败", reason: "看空/风险假设与区间正收益冲突" }
    }
    return { verdict: "待继续观察", reason: "区间收益幅度未达到明确验证阈值" }
  }
  return { verdict: "待继续观察", reason: "问题没有给出明确预测方向，日线结果只作为市场验证材料" }
}

function buildStockDailyMarketValidation(stockDaily, query) {
  if (!stockDaily || stockDaily.status === "skipped") return null
  const base = {
    sourceId: "stock_daily_sql",
    status: stockDaily.status,
    verdict: "证据不足",
    reason: stockDaily.warning ?? null,
    stockName: stockDaily.intent?.stockName ?? null,
    stockCode: stockDaily.intent?.stockCode ?? null,
    lookbackDays: stockDaily.intent?.lookbackDays ?? null,
    rowCount: stockDaily.results?.length ?? 0,
  }
  if (stockDaily.status !== "ok") return base
  const rows = (stockDaily.results ?? []).map((item) => item.row).filter(Boolean)
  const columns = stockDaily.descriptor?.columns ?? {}
  if (rows.length === 0) return { ...base, reason: stockDaily.warning ?? "SQL 源执行成功，但没有返回日线记录" }
  const first = rows[0]
  const last = rows[rows.length - 1]
  const firstClose = numberFromSqlCell(first[columns.close])
  const lastClose = numberFromSqlCell(last[columns.close])
  const periodReturnPct = firstClose != null && firstClose !== 0 && lastClose != null ? ((lastClose - firstClose) / firstClose) * 100 : null
  const avgVolume = columns.volume ? averageNumbers(rows.map((row) => row[columns.volume])) : null
  const lastVolume = columns.volume ? numberFromSqlCell(last[columns.volume]) : null
  const lastVolumeVsAvg = avgVolume && lastVolume != null ? lastVolume / avgVolume : null
  const avgAmount = columns.amount ? averageNumbers(rows.map((row) => row[columns.amount])) : null
  const lastAmount = columns.amount ? numberFromSqlCell(last[columns.amount]) : null
  const direction = inferMarketValidationDirection(query)
  const verdict = verdictFromMarketMove({ direction, periodReturnPct, lastVolumeVsAvg })
  return {
    ...base,
    status: rows.length >= 2 ? "ready" : "partial",
    verdict: rows.length >= 2 ? verdict.verdict : "证据不足",
    reason: rows.length >= 2 ? verdict.reason : "少于 2 条日线，无法形成区间验证",
    expectedDirection: direction,
    firstDate: formatSqlCell(first[columns.date]),
    lastDate: formatSqlCell(last[columns.date]),
    firstClose: roundMetric(firstClose, 4),
    lastClose: roundMetric(lastClose, 4),
    periodReturnPct: roundMetric(periodReturnPct, 2),
    avgVolume: roundMetric(avgVolume, 2),
    lastVolume: roundMetric(lastVolume, 2),
    lastVolumeVsAvg: roundMetric(lastVolumeVsAvg, 2),
    avgAmount: roundMetric(avgAmount, 2),
    lastAmount: roundMetric(lastAmount, 2),
    refs: stockDaily.results.map((item) => item.path),
  }
}

async function searchAskStockDaily(projectPath, query, options = {}) {
  const mapping = await loadStockCodeMapping(projectPath)
  const intent = parseStockDailyIntent(query, { stockCodeMapping: mapping })
  const descriptor = options.stockDailyDescriptor ?? (await describeStockDailySqlSource(options))
  if (!intent.isStockQuestion) {
    return { status: "skipped", intent, descriptor, nativeQuery: null, results: [], warning: null }
  }
  if (!intent.stockCode) {
    return { status: "insufficient", intent, descriptor, nativeQuery: null, results: [], warning: "未能从问题中解析股票代码或股票名" }
  }
  if (!descriptor.ok) {
    return { status: "unavailable", intent, descriptor, nativeQuery: null, results: [], warning: `SQL 源不可用: ${descriptor.error}` }
  }
  const nativeQuery = buildStockDailySqlQuery(intent, descriptor, options)
  try {
    const execution = await executeStockDailyQuery(nativeQuery, options)
    const rows = Array.isArray(execution?.rows) ? execution.rows : []
    return {
      status: "ok",
      intent,
      descriptor,
      nativeQuery,
      results: stockDailyRowsToEvidence({ rows, nativeQuery, descriptor, intent }),
      warning: rows.length > 0 ? null : "SQL 源执行成功，但没有返回日线记录",
    }
  } catch (err) {
    return { status: "error", intent, descriptor, nativeQuery, results: [], warning: `SQL 查询失败: ${safeErrorMessage(err)}` }
  }
}

function buildBaseAskSources(projectPath, options = {}) {
  const stockDailyConfig = getStockDailyPgConfig(process.env, options)
  const hasStockDailyConfig = hasUsableStockDailyPgConfig(stockDailyConfig)
  return [
    {
      id: "wiki_pages",
      label: "Wiki Pages",
      kind: "text",
      nativeLanguage: "free-text",
      available: true,
      descriptor: "Schema v1 Markdown wiki pages under wiki/**/*.md; rich frontmatter, titles, aliases, tags, related links, and page body.",
    },
    {
      id: "raw_text",
      label: "Raw Text",
      kind: "text",
      nativeLanguage: "free-text",
      available: true,
      descriptor: "Immutable source material under raw/**, including daily reviews, WeChat sentiment, research/news, meeting clues, and trade materials.",
    },
    {
      id: "wiki_graph",
      label: "Wiki Graph",
      kind: "graph",
      nativeLanguage: "bounded graph traversal",
      available: true,
      descriptor: "Local wiki graph from .llm-wiki/graph.json when present, otherwise wikilinks and shared sources derived from wiki pages.",
    },
    {
      id: "facts_jsonl",
      label: "Facts JSONL",
      kind: "jsonl",
      nativeLanguage: "JSONL filter/search",
      available: true,
      descriptor: "Structured fact files under data/facts/*.jsonl, including observations and cases.",
    },
    {
      id: "brain_memory",
      label: "Brain Memory",
      kind: "jsonl",
      nativeLanguage: "JSONL memory filter/search",
      available: true,
      descriptor: "Long-term MPA memory under data/brain/*.jsonl, including active threads, corrections, validations, guardrails, preferences, and self-training events.",
    },
    {
      id: "stock_daily_sql",
      label: "Stock Daily SQL",
      kind: "sql",
      nativeLanguage: "PostgreSQL SELECT",
      available: Boolean(options.stockDailyExecutor || options.stockDailyColumns || hasStockDailyConfig),
      descriptor: "Read-only PostgreSQL stock daily source configured by PG_SHIHAO_* or PG_SHIHAO_CONFIG_PATH; daily OHLCV/amount style stock price data.",
      config: redactPgConfig(stockDailyConfig),
      unavailableReason: hasStockDailyConfig || options.stockDailyExecutor || options.stockDailyColumns ? null : stockDailyPgConfigUnavailableReason(stockDailyConfig),
    },
  ]
}

export async function buildAskSourceRegistry(options = {}) {
  const projectPath = resolveProjectPath(options)
  const query = String(options.query ?? "")
  const sources = buildBaseAskSources(projectPath, options)
  const stockSource = sources.find((source) => source.id === "stock_daily_sql")
  if (stockSource && (options.stockDailyColumns || options.stockDailyExecutor || (isStockDailyQuestion(query) && hasUsableStockDailyPgConfig(getStockDailyPgConfig(process.env, options))))) {
    const descriptor = await describeStockDailySqlSource(options)
    stockSource.available = descriptor.ok || Boolean(options.stockDailyExecutor)
    stockSource.columns = descriptor.columns
    stockSource.config = descriptor.config
    stockSource.unavailableReason = descriptor.ok || options.stockDailyExecutor ? null : descriptor.error
    stockSource.descriptor = `${stockSource.descriptor} Columns: ${descriptor.columns.all.slice(0, 40).join(", ") || "unavailable"}.`
  }
  return { projectPath, sources }
}

function rankAskSourcesByRules(query, sources) {
  const stockIntent = isStockDailyQuestion(query)
  const tradeIntent = isTradeReviewQuestion(query)
  const factsIntent = isFactsQuestion(query)
  const brainIntent = isBrainQuestion(query)
  const rawIntent = isRawNewsQuestion(query)
  return sources.map((source) => {
    let score = 1
    let required = false
    const reasons = []
    if (source.id === "wiki_pages") {
      score += 8
      reasons.push("default wiki semantic source")
      if (!stockIntent) {
        required = true
        reasons.push("default compiled wiki source")
      }
      if (tradeIntent) {
        score += 15
        required = true
        reasons.push("trade review/error/pattern query")
      }
    }
    if (source.id === "raw_text") {
      score += 7
      reasons.push("default raw evidence source")
      if (tradeIntent || rawIntent) {
        score += 14
        required = true
        reasons.push("recent/review/news/source-material query")
      }
    }
    if (source.id === "wiki_graph") {
      score += 5
      reasons.push("default bounded relation expansion")
      if (!stockIntent) {
        required = true
        reasons.push("default graph expansion after wiki hits")
      }
      if (tradeIntent || /关联|关系|相关|链路|图谱|扩展/.test(query)) {
        score += 13
        required = true
        reasons.push("relationship or error/pattern expansion query")
      }
    }
    if (source.id === "facts_jsonl") {
      score += 2
      if (factsIntent) {
        score += 15
        required = true
        reasons.push("facts/cases/observations query")
      }
    }
    if (source.id === "brain_memory") {
      score += 4
      reasons.push("default long-term memory and correction source")
      if (!stockIntent || tradeIntent || factsIntent || brainIntent) {
        score += brainIntent ? 16 : 6
        required = true
        reasons.push("MPA memory/correction/validation recall")
      }
    }
    if (source.id === "stock_daily_sql") {
      if (stockIntent) {
        score += 30
        required = true
        reasons.push("price/volume/trading-day query")
      }
    }
    if (!source.available && source.id !== "stock_daily_sql") score -= 100
    return { sourceId: source.id, score, required, reasons }
  })
}

function buildSourceRoutingPrompt({ query, sources, sourceK }) {
  const rows = sources.map((source) => ({
    id: source.id,
    label: source.label,
    kind: source.kind,
    nativeLanguage: source.nativeLanguage,
    available: source.available,
    descriptor: source.descriptor,
    unavailableReason: source.unavailableReason,
  }))
  return [
    "# Ask Source Routing",
    "",
    `question: ${query}`,
    `max_sources: ${sourceK}`,
    "",
    "Select the most useful sources for answering the question. Return only JSON:",
    '{"source_ids":["wiki_pages","raw_text"],"rationale":{"wiki_pages":"..."}}',
    "",
    "Registered sources:",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
  ].join("\n")
}

async function rankAskSourcesWithLlm({ query, sources, sourceK, options }) {
  const provider = options.provider ?? "codex"
  const prompt = buildSourceRoutingPrompt({ query, sources, sourceK })
  const instructions = "You are a source router for a trading knowledge-base retrieval CLI. Return only the requested JSON object."
  let text
  if (options.requestSourceRoutingText) {
    text = await options.requestSourceRoutingText({ stage: "ask-source-routing", prompt, instructions, sources, query, sourceK })
  } else if (provider === "codex") {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-wiki-source-router-"))
    const outputPath = path.join(tmpDir, "sources.json")
    try {
      text = await requestCodexExecText({
        stage: "ask-source-routing",
        prompt,
        instructions,
        model: options.model,
        prepared: { projectPath: resolveProjectPath(options) },
        outputPath,
        codexBin: options.codexBin,
        codexProfile: options.codexProfile,
        codexProfileV2: options.codexProfileV2,
        codexTimeoutMs: options.codexTimeoutMs,
      })
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  } else if (provider === "openai") {
    const apiKey = resolveOpenAiApiKey(options)
    const model = options.model ?? process.env.OPENAI_MODEL
    if (!apiKey || !model) return { sourceIds: [], rationale: {}, warning: "OpenAI source routing skipped because api key/model is missing" }
    text = await requestOpenAiProviderText({
      apiKey,
      endpoint: options.endpoint,
      apiMode: options.apiMode,
      model,
      prompt,
      instructions,
      reasoningEffort: options.reasoningEffort ?? "low",
    })
  } else {
    return { sourceIds: [], rationale: {}, warning: `Unsupported source routing provider: ${provider}` }
  }
  const parsed = parseJsonObjectFromModelText(text)
  const sourceIds = Array.isArray(parsed.source_ids) ? parsed.source_ids.filter((id) => ASK_SOURCE_IDS.includes(id)) : []
  return { sourceIds, rationale: parsed.rationale && typeof parsed.rationale === "object" ? parsed.rationale : {}, warning: null }
}

export async function selectAskSources(options = {}) {
  const query = String(options.query ?? "").trim()
  const sourceK = parsePositiveInteger(options.sourceK, ASK_DEFAULT_SOURCE_K)
  const registry = await buildAskSourceRegistry(options)
  const rules = rankAskSourcesByRules(query, registry.sources)
  const sourceById = new Map(registry.sources.map((source) => [source.id, source]))
  const explicit = parseAskSourcesOption(options.sources)
  const warnings = []
  let llmRanking = { sourceIds: [], rationale: {}, warning: null }

  if (explicit) {
    const selectedSources = explicit.map((id) => ({ ...sourceById.get(id), routeReason: "explicit --sources" })).filter(Boolean)
    return { registry, selectedSources, route: { mode: "explicit", sourceK, rules, llmRanking, warnings } }
  }

  const shouldUseLlm = options.useLlmSourceRouting !== false && ["codex", "openai"].includes(options.provider ?? "")
  if (shouldUseLlm) {
    try {
      llmRanking = await rankAskSourcesWithLlm({ query, sources: registry.sources, sourceK, options })
      if (llmRanking.warning) warnings.push(llmRanking.warning)
    } catch (err) {
      warnings.push(`LLM source routing failed; using rules fallback: ${safeErrorMessage(err)}`)
    }
  }

  const ruleRanked = [...rules].sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
  const requiredIds = ruleRanked.filter((item) => item.required).map((item) => item.sourceId)
  const selectedIds = []
  const add = (id) => {
    if (!sourceById.has(id) || selectedIds.includes(id)) return
    selectedIds.push(id)
  }
  requiredIds.forEach(add)
  const targetSourceCount = Math.max(sourceK, requiredIds.length)
  llmRanking.sourceIds.forEach((id) => {
    if (selectedIds.length < targetSourceCount) add(id)
  })
  ruleRanked.forEach((item) => {
    if (selectedIds.length < targetSourceCount) add(item.sourceId)
  })
  if (selectedIds.length === 0) ["wiki_pages", "raw_text", "wiki_graph"].forEach(add)

  const ruleById = new Map(rules.map((rule) => [rule.sourceId, rule]))
  const selectedSources = selectedIds.map((id) => {
    const source = sourceById.get(id)
    const rule = ruleById.get(id)
    return {
      ...source,
      ruleScore: rule?.score ?? 0,
      routeReason: llmRanking.sourceIds.includes(id) ? llmRanking.rationale?.[id] ?? "LLM selected" : rule?.reasons?.join("; ") ?? "rules fallback",
    }
  })
  return {
    registry,
    selectedSources,
    route: {
      mode: shouldUseLlm && llmRanking.sourceIds.length > 0 ? "llm+rules" : "rules",
      sourceK,
      rules,
      llmRanking,
      warnings,
    },
  }
}

async function scoreAskFile({ filePath, projectPath, tokens, query, isRaw }) {
  const scored = await scoreFile({
    filePath,
    projectPath,
    sourcePath: null,
    tokens,
    query,
    isRaw,
    mode: RETRIEVAL_MODES.ASK,
  })
  if (!scored) return null
  return scored
}

async function searchAskCandidates(projectPath, query, options = {}) {
  const pp = normalizePath(projectPath)
  const tokens = tokenizeQuery(query)
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const topWiki = parsePositiveInteger(options.topWiki, ASK_DEFAULT_TOP_WIKI)
  const topRaw = parsePositiveInteger(options.topRaw, ASK_DEFAULT_TOP_RAW)

  const [wikiFiles, rawFiles] = await Promise.all([
    listFilesRecursive(path.join(pp, "wiki"), {
      extensions: new Set([".md"]),
      excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
    }),
    listFilesRecursive(path.join(pp, "raw"), {
      extensions: TEXT_EXTENSIONS,
      excludeDirNames: new Set([".git", ".llm-wiki", ".obsidian", "scripts", "templates", "archive", "assets"]),
      maxBytes: options.maxRawBytes ?? null,
      preferRecent: true,
      maxFiles: options.rawScanLimit ?? 320,
    }),
  ])
  const policyRawFiles = filterRawFilesByQueryPolicy(rawFiles, query, { ...options, mode: RETRIEVAL_MODES.ASK })

  const navigation = []
  for (const relativePath of ASK_NAVIGATION_PATHS) {
    const filePath = path.join(pp, relativePath)
    const scored = await scoreAskFile({ filePath, projectPath: pp, tokens: effectiveTokens, query, isRaw: false })
    if (scored) navigation.push({ ...scored, navigation: true })
  }

  const wikiResults = []
  for (const filePath of wikiFiles) {
    const relativePath = projectRelative(pp, filePath)
    if (isReservedWikiPath(relativePath)) continue
    const scored = await scoreAskFile({ filePath, projectPath: pp, tokens: effectiveTokens, query, isRaw: false })
    if (scored) wikiResults.push(scored)
  }

  const rawResults = []
  for (const filePath of policyRawFiles) {
    const scored = await scoreAskFile({ filePath, projectPath: pp, tokens: effectiveTokens, query, isRaw: true })
    if (scored) rawResults.push(scored)
  }
  boostRawResultsByWikiStructure(rawResults, sortSearchResults([...wikiResults]))

  return {
    retrievalMode: RETRIEVAL_MODES.ASK,
    query,
    projectPath: pp,
    tokens: effectiveTokens,
    navigation: sortSearchResults(navigation),
    wikiResults: sortSearchResults(wikiResults).slice(0, topWiki),
    rawResults: sortSearchResults(rawResults).slice(0, topRaw),
    counts: {
      wikiFiles: wikiFiles.length,
      rawFiles: policyRawFiles.length,
      wikiMatches: wikiResults.length,
      rawMatches: rawResults.length,
    },
  }
}

function jsonLineSearchText(value) {
  if (value == null) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map((item) => jsonLineSearchText(item)).join(" ")
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${jsonLineSearchText(item)}`)
      .join(" ")
  }
  return ""
}

function buildFactSearchResult({ relativePath, lineNumber, parsed, score, temporalStatus = null, statusReason = null }) {
  const title =
    (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title ?? parsed.name ?? parsed.subject ?? parsed.claim ?? parsed.id ?? parsed.date ?? parsed.created_at)) ||
    `${path.basename(relativePath)}:${lineNumber}`
  return {
    sourceId: "facts_jsonl",
    path: `facts:${relativePath}:${lineNumber}`,
    title: String(title),
    score,
    type: temporalStatus ? `TEMPORAL_${temporalStatus.toUpperCase()}` : "JSONL",
    temporalStatus,
    statusReason,
    nativeQuery: `JSONL token filter over ${relativePath}`,
    excerpt: excerptForPrompt(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2), ASK_FACTS_EXCERPT_CHARS),
    value: parsed,
  }
}

async function searchAskFactsSplit(projectPath, query, tokens, options = {}) {
  const pp = normalizePath(projectPath)
  const topFacts = parsePositiveInteger(options.topFacts, ASK_DEFAULT_TOP_FACTS)
  const includeInvalidated = Boolean(options.includeInvalidated)
  const files = await listFilesRecursive(path.join(pp, "data", "facts"), {
    extensions: new Set([".jsonl"]),
    excludeDirNames: new Set([".git", "node_modules"]),
    maxBytes: options.maxFactsBytes ?? 1024 * 1024 * 5,
  }).catch(() => [])
  const activeResults = []
  const invalidatedResults = []
  for (const filePath of files) {
    const relativePath = projectRelative(pp, filePath)
    if (relativePath === TEMPORAL_FACTS_RELATIVE_PATH) {
      const entries = await readTemporalFactEntries(pp)
      for (const entry of entries) {
        const parsed = entry.value
        const searchText = `${relativePath}\n${jsonLineSearchText(parsed)}`
        const score = tokenMatchScore(searchText, tokens) + getRecencyBoost(`${relativePath}:${entry.line}`, query)
        if (score <= 0) continue
        const inactive = entry.status !== "active"
        if (inactive && !includeInvalidated) continue
        const result = buildFactSearchResult({
          relativePath,
          lineNumber: entry.line,
          parsed,
          score: score + (inactive ? 1 : 3),
          temporalStatus: entry.status,
          statusReason: entry.statusReason,
        })
        if (inactive) invalidatedResults.push(result)
        else activeResults.push(result)
      }
      continue
    }
    const raw = await readIfExists(filePath)
    if (!raw.trim()) continue
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = line
      }
      const searchText = `${relativePath}\n${jsonLineSearchText(parsed)}`
      const score = tokenMatchScore(searchText, tokens) + getRecencyBoost(`${relativePath}:${i + 1}`, query)
      if (score <= 0) continue
      if (isTemporalFactRecord(parsed)) {
        const status = normalizeTemporalFactStatus(parsed.status)
        if (status !== "active" && !includeInvalidated) continue
        const result = buildFactSearchResult({
          relativePath,
          lineNumber: i + 1,
          parsed,
          score: score + (status === "active" ? 3 : 1),
          temporalStatus: status,
          statusReason: null,
        })
        if (status === "active") activeResults.push(result)
        else invalidatedResults.push(result)
      } else {
        activeResults.push(buildFactSearchResult({
          relativePath,
          lineNumber: i + 1,
          parsed,
          score: score + 3,
        }))
      }
    }
  }
  return {
    active: sortSearchResults(activeResults).slice(0, topFacts),
    invalidated: sortSearchResults(invalidatedResults).slice(0, topFacts),
  }
}

async function searchAskFacts(projectPath, query, tokens, options = {}) {
  const results = await searchAskFactsSplit(projectPath, query, tokens, options)
  return results.active
}

function brainDir(projectPath) {
  return path.join(normalizePath(projectPath), "data", "brain")
}

function brainFileForType(type) {
  const normalized = String(type ?? "").trim().toLowerCase().replace(/-/g, "_")
  const fileName = BRAIN_TYPE_TO_FILE.get(normalized)
  if (!fileName) throw new Error(`Unknown brain memory type: ${type}`)
  return fileName
}

function normalizeBrainTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeBrainResult(result) {
  const raw = String(result ?? "").trim().toLowerCase()
  const aliases = new Map([
    ["success", "success"],
    ["pass", "success"],
    ["passed", "success"],
    ["验证通过", "success"],
    ["成功", "success"],
    ["failure", "failure"],
    ["fail", "failure"],
    ["failed", "failure"],
    ["验证失败", "failure"],
    ["失败", "failure"],
    ["uncertain", "uncertain"],
    ["pending", "uncertain"],
    ["观察", "uncertain"],
    ["待继续观察", "uncertain"],
    ["存疑", "uncertain"],
  ])
  return aliases.get(raw) ?? raw
}

function resultToValidationVerdict(result) {
  const normalized = normalizeBrainResult(result)
  if (normalized === "success") return "验证通过"
  if (normalized === "failure") return "验证失败"
  if (normalized === "uncertain") return "待继续观察"
  return String(result ?? "证据不足")
}

function makeBrainRecordId(type, seed) {
  return `brain_${String(type).replace(/[^a-z0-9_-]+/gi, "-")}_${shortHash(`${nowLocalTimestamp()} ${seed ?? ""} ${Math.random()}`)}`
}

function buildBrainRecord({ type, text, title, status, source, tags, related, metadata }) {
  const cleanType = String(type ?? "").trim().toLowerCase().replace(/-/g, "_")
  if (!BRAIN_TYPE_TO_FILE.has(cleanType)) throw new Error(`Unknown brain memory type: ${type}`)
  const body = String(text ?? "").trim()
  if (!body && !metadata?.prediction) throw new Error("Missing brain memory text")
  const now = nowLocalTimestamp()
  return {
    id: metadata?.id ?? makeBrainRecordId(cleanType, body || metadata?.prediction),
    type: cleanType,
    title: String(title ?? metadata?.title ?? body.slice(0, 48) ?? cleanType).trim(),
    text: body,
    status: String(status ?? metadata?.status ?? (cleanType === "thread" ? "open" : "active")),
    source: source ? String(source) : metadata?.source ?? "manual",
    tags: normalizeBrainTags(tags ?? metadata?.tags),
    related: normalizeBrainTags(related ?? metadata?.related),
    createdAt: metadata?.createdAt ?? now,
    updatedAt: metadata?.updatedAt ?? now,
    ...Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !["id", "title", "status", "source", "tags", "related", "createdAt", "updatedAt"].includes(key))),
  }
}

export async function rememberBrainMemory(options = {}) {
  const projectPath = resolveProjectPath(options)
  const record = buildBrainRecord(options)
  const fileName = brainFileForType(record.type)
  const filePath = path.join(brainDir(projectPath), fileName)
  await appendJsonl(filePath, record)
  return { projectPath, filePath, relativePath: projectRelative(projectPath, filePath), record }
}

async function listBrainFiles(projectPath) {
  return listFilesRecursive(brainDir(projectPath), {
    extensions: new Set([".jsonl"]),
    excludeDirNames: new Set([".git", "node_modules"]),
    maxBytes: 1024 * 1024 * 5,
  }).catch(() => [])
}

async function readBrainRecords(projectPath) {
  const pp = normalizePath(projectPath)
  const files = await listBrainFiles(pp)
  const records = []
  for (const filePath of files) {
    const relativePath = projectRelative(pp, filePath)
    const parsed = await readJsonlFile(filePath)
    for (const item of parsed) {
      records.push({
        ...item,
        path: relativePath,
        filePath,
      })
    }
  }
  return records
}

async function searchAskBrain(projectPath, query, tokens, options = {}) {
  const pp = normalizePath(projectPath)
  const topBrain = parsePositiveInteger(options.topBrain, ASK_DEFAULT_TOP_BRAIN)
  const records = await readBrainRecords(pp)
  const results = []
  for (const item of records) {
    const parsed = item.value
    const searchText = `${item.path}\n${jsonLineSearchText(parsed)}`
    const score = tokenMatchScore(searchText, tokens) + getRecencyBoost(`${item.path}:${item.line}`, query)
    if (score <= 0) continue
    const title =
      (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.title ?? parsed.subject ?? parsed.id ?? parsed.type ?? parsed.createdAt)) ||
      `${path.basename(item.path)}:${item.line}`
    results.push({
      sourceId: "brain_memory",
      path: `brain:${item.path}:${item.line}`,
      title: String(title),
      score: score + 4,
      type: "BRAIN",
      nativeQuery: `JSONL memory filter over ${item.path}`,
      excerpt: excerptForPrompt(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2), ASK_BRAIN_EXCERPT_CHARS),
      value: parsed,
    })
  }
  return sortSearchResults(results).slice(0, topBrain)
}

export async function getBrainStatus(options = {}) {
  const projectPath = resolveProjectPath(options)
  const records = await readBrainRecords(projectPath)
  const byFile = {}
  const byType = {}
  const byStatus = {}
  for (const item of records) {
    const value = item.value && typeof item.value === "object" && !Array.isArray(item.value) ? item.value : {}
    byFile[item.path] = (byFile[item.path] ?? 0) + 1
    byType[value.type ?? "unknown"] = (byType[value.type ?? "unknown"] ?? 0) + 1
    byStatus[value.status ?? "unknown"] = (byStatus[value.status ?? "unknown"] ?? 0) + 1
  }
  return { projectPath, total: records.length, byFile, byType, byStatus }
}

export async function resolveBrainMemory(options = {}) {
  const projectPath = resolveProjectPath(options)
  const targetId = String(options.id ?? options.targetId ?? "").trim()
  const result = normalizeBrainResult(options.result)
  if (!targetId) throw new Error("Missing brain memory id")
  if (!["success", "failure", "uncertain"].includes(result)) throw new Error("Brain resolve result must be success, failure, or uncertain")
  const record = {
    id: makeBrainRecordId("event", targetId),
    type: "event",
    eventType: "manual-resolution",
    targetId,
    result,
    verdict: resultToValidationVerdict(result),
    note: String(options.note ?? "").trim(),
    createdAt: nowLocalTimestamp(),
  }
  const filePath = path.join(brainDir(projectPath), brainFileForType("event"))
  await appendJsonl(filePath, record)
  return { projectPath, filePath, relativePath: projectRelative(projectPath, filePath), record }
}

function validationTarget(record) {
  return String(record.target ?? record.subject ?? record.concept ?? record.pattern ?? record.stockCode ?? record.stockName ?? record.prediction ?? record.id ?? "unknown")
}

function validationResult(record) {
  const raw = record.result ?? record.validationResult ?? record.verdict ?? record.marketValidation?.verdict
  const normalized = normalizeBrainResult(raw)
  if (normalized === "success" || normalized === "failure" || normalized === "uncertain") return normalized
  if (/通过|成功|确认/.test(String(raw ?? ""))) return "success"
  if (/失败|证伪|反向/.test(String(raw ?? ""))) return "failure"
  return "uncertain"
}

function validationHorizonTrackKey(record) {
  const explicit = record.horizonTrackKey ?? record.supersessionKey
  if (explicit) return String(explicit)
  if (record.predictionId && record.stockCode) return `${record.predictionId}:${record.stockCode}`
  return null
}

function isCurrentDailyValidationRecord(record) {
  return record.validationMethod === DAILY_LOOP_VALIDATION_METHOD
}

function validationWindowSortValue(record) {
  const n = Number(record.windowDays ?? record.marketValidation?.lookbackDays)
  if (Number.isFinite(n)) return n
  return 0
}

function collapseValidationHorizonTracks(records) {
  const passthrough = []
  const byTrack = new Map()
  for (const record of records) {
    const trackKey = validationHorizonTrackKey(record)
    if (!trackKey) {
      passthrough.push(record)
      continue
    }
    if (!byTrack.has(trackKey)) byTrack.set(trackKey, [])
    byTrack.get(trackKey).push(record)
  }
  const collapsed = [...passthrough]
  for (const [trackKey, items] of byTrack.entries()) {
    const currentMethodItems = items.filter(isCurrentDailyValidationRecord)
    const effectiveItems = currentMethodItems.length > 0 ? currentMethodItems : items
    const ordered = [...effectiveItems].sort(
      (a, b) =>
        validationWindowSortValue(a) - validationWindowSortValue(b) ||
        String(a.validationEndDate ?? a.createdAt ?? "").localeCompare(String(b.validationEndDate ?? b.createdAt ?? "")),
    )
    const concreteResults = new Set(ordered.map(validationResult).filter((item) => item === "success" || item === "failure"))
    const latest = ordered[ordered.length - 1]
    if (concreteResults.has("success") && concreteResults.has("failure")) {
      collapsed.push({
        ...latest,
        id: latest.id ? `${latest.id}_horizon_conflict` : `horizon_conflict_${shortHash(trackKey)}`,
        result: "uncertain",
        verdict: "窗口冲突待归因",
        conflict: true,
        eventType: "horizon-conflict",
        horizonTrackKey: trackKey,
        horizonResults: ordered.map((item) => ({
          id: item.id,
          windowDays: item.windowDays ?? item.marketValidation?.lookbackDays ?? null,
          result: validationResult(item),
          verdict: item.verdict ?? item.marketValidation?.verdict ?? null,
          validationStartDate: item.validationStartDate ?? item.marketValidation?.firstDate ?? null,
          validationEndDate: item.validationEndDate ?? item.marketValidation?.lastDate ?? null,
        })),
      })
    } else {
      collapsed.push({ ...latest, horizonTrackKey: trackKey })
    }
  }
  return collapsed
}

function daysSince(value) {
  const date = new Date(String(value ?? "").slice(0, 10))
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((Date.now() - date.getTime()) / 86400000)
}

function buildSelfTrainingActionsFromRecords(records) {
  const validationRecords = records
    .map((item) => item.value)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.type === "validation" || item.kind === "validation" || item.marketValidation)
  const collapsedValidationRecords = collapseValidationHorizonTracks(validationRecords)
  const correctionRecords = records
    .map((item) => item.value)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => item.type === "correction" || item.type === "guardrail" || item.kind === "mistake-case")
  const actions = []
  const byTarget = new Map()
  for (const record of collapsedValidationRecords) {
    const target = validationTarget(record)
    if (!byTarget.has(target)) byTarget.set(target, [])
    byTarget.get(target).push(record)
  }
  for (const [target, items] of byTarget.entries()) {
    const ordered = [...items].sort((a, b) => String(a.createdAt ?? a.date ?? "").localeCompare(String(b.createdAt ?? b.date ?? "")))
    const results = ordered.map(validationResult)
    const trailing = []
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] === "uncertain") break
      if (trailing.length > 0 && results[i] !== trailing[0]) break
      trailing.push(results[i])
    }
    const successCount = results.filter((item) => item === "success").length
    const failureCount = results.filter((item) => item === "failure").length
    const winRate = results.length > 0 ? successCount / results.length : 0
    const latest = ordered[ordered.length - 1]
    if (trailing[0] === "success" && trailing.length >= 3) {
      actions.push({ rule: "R1-concept-upgrade", target, action: "upgrade-confidence", reason: "连续 3 次验证成功", affectedIds: ordered.slice(-3).map((item) => item.id).filter(Boolean) })
    }
    if (trailing[0] === "failure" && trailing.length >= 2) {
      actions.push({ rule: "R2-concept-downgrade", target, action: "downgrade-confidence", reason: "连续 2 次验证失败", affectedIds: ordered.slice(-2).map((item) => item.id).filter(Boolean) })
    }
    if (/模式|pattern/i.test(String(latest?.targetType ?? latest?.type ?? latest?.kind ?? target)) && results.length >= 5 && winRate > 0.8) {
      actions.push({ rule: "R3-pattern-solidify", target, action: "solidify-pattern", reason: `模式验证 ${results.length} 次且胜率 ${Math.round(winRate * 100)}%`, affectedIds: ordered.map((item) => item.id).filter(Boolean) })
    }
    if (ordered.some((item) => item.conflict || item.eventType === "cognitive-conflict")) {
      actions.push({ rule: "R4-cognitive-conflict", target, action: "create-review-task", reason: "出现认知冲突记录", affectedIds: ordered.map((item) => item.id).filter(Boolean) })
    }
    const stale = ordered.find((item) => ["open", "pending", "active"].includes(String(item.status ?? "").toLowerCase()) && daysSince(item.lastValidatedAt ?? item.updatedAt ?? item.createdAt ?? item.date) >= 15)
    if (stale) {
      actions.push({ rule: "R5-stale-validation-decay", target, action: "decay-to-observe", reason: "超过 15 天无验证更新", affectedIds: [stale.id].filter(Boolean) })
    }
    if (failureCount >= 3) {
      actions.push({ rule: "R7-hypothesis-review", target, action: "review-hypothesis", reason: "多次被市场反向验证", affectedIds: ordered.filter((item) => validationResult(item) === "failure").map((item) => item.id).filter(Boolean) })
    }
  }
  const correctionBuckets = new Map()
  for (const record of correctionRecords) {
    const key = String(record.errorType ?? record.subject ?? record.title ?? record.text ?? "unknown")
    if (!correctionBuckets.has(key)) correctionBuckets.set(key, [])
    correctionBuckets.get(key).push(record)
  }
  for (const [target, items] of correctionBuckets.entries()) {
    if (items.length >= 2) {
      actions.push({ rule: "R6-error-guardrail-escalation", target, action: "escalate-guardrail", reason: "同一错误类型重复出现，升级为 L4 卫语句候选", affectedIds: items.map((item) => item.id).filter(Boolean) })
    }
  }
  return actions.map((action, index) => ({
    id: `self_train_${shortHash(`${action.rule}:${action.target}:${index}`)}`,
    createdAt: nowLocalTimestamp(),
    ...action,
  }))
}

export async function runSelfTraining(options = {}) {
  const projectPath = resolveProjectPath(options)
  const records = await readBrainRecords(projectPath)
  const actions = buildSelfTrainingActionsFromRecords(records)
  const dryRun = !options.write
  if (!dryRun && actions.length > 0) {
    const filePath = path.join(brainDir(projectPath), brainFileForType("event"))
    for (const action of actions) {
      await appendJsonl(filePath, { ...action, type: "event", eventType: "self-training-action", rulesVersion: "mpa-v1" })
    }
  }
  return { projectPath, dryRun, rules: SELF_TRAIN_RULES, actions }
}

export async function marketValidatePrediction(options = {}) {
  const projectPath = resolveProjectPath(options)
  const prediction = String(options.prediction ?? options.text ?? "").trim()
  const stock = String(options.stock ?? "").trim()
  if (!prediction) throw new Error("Missing --prediction")
  if (!stock) throw new Error("Missing --stock")
  const windowDays = parsePositiveInteger(String(options.window ?? "").replace(/\D+/g, ""), parseStockLookbackDays(prediction))
  const query = `${prediction} ${stock} 最近${windowDays}个交易日 涨跌幅 成交量`
  const stockDaily = await searchAskStockDaily(projectPath, query, { ...options, sqlLimit: windowDays })
  const marketValidation = buildStockDailyMarketValidation(stockDaily, query)
  const record = {
    id: makeBrainRecordId("validation", `${prediction}:${stock}:${windowDays}`),
    type: "validation",
    kind: "market-validation",
    prediction,
    stock,
    stockCode: marketValidation?.stockCode ?? stockDaily.intent?.stockCode ?? null,
    stockName: marketValidation?.stockName ?? stockDaily.intent?.stockName ?? null,
    windowDays,
    result: normalizeBrainResult(marketValidation?.verdict),
    verdict: marketValidation?.verdict ?? stockDaily.warning ?? "证据不足",
    reason: marketValidation?.reason ?? stockDaily.warning ?? null,
    marketValidation,
    sqlRefs: marketValidation?.refs ?? [],
    createdAt: nowLocalTimestamp(),
  }
  let writeResult = null
  if (options.write) {
    const filePath = path.join(brainDir(projectPath), brainFileForType("validation"))
    await appendJsonl(filePath, record)
    writeResult = { filePath, relativePath: projectRelative(projectPath, filePath) }
  }
  return { projectPath, query, stockDaily, marketValidation, record, writeResult, dryRun: !options.write }
}

function parseDailyLoopMode(value) {
  const mode = String(value ?? "full").trim().toLowerCase()
  if (!["premarket", "postclose", "full"].includes(mode)) throw new Error("--mode must be premarket, postclose, or full")
  return mode
}

function parseDailyLoopWindows(value) {
  if (Array.isArray(value)) return value.map((item) => parsePositiveInteger(item, null)).filter(Boolean)
  const raw = String(value ?? "").trim()
  if (!raw) return DAILY_LOOP_DEFAULT_VALIDATION_WINDOWS
  const parsed = raw
    .split(",")
    .map((item) => parsePositiveInteger(item.trim(), null))
    .filter(Boolean)
  return parsed.length > 0 ? [...new Set(parsed)] : DAILY_LOOP_DEFAULT_VALIDATION_WINDOWS
}

function isDailyLoopRecentPath(relativePath, lookbackDays) {
  const match = String(relativePath).match(/(20\d{2}-\d{2}-\d{2})/)
  if (!match) return false
  const age = daysSince(`${match[1]} 00:00:00`)
  return age == null || age <= Math.max(lookbackDays, 1)
}

function codeFromFrontmatterLike(fm = {}) {
  const direct = normalizeStockCode(fm.code)
  if (direct) return direct
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : []
  for (const alias of aliases) {
    const code = normalizeStockCode(alias)
    if (code) return code
  }
  return null
}

async function loadDailyLoopStockUniverse(projectPath) {
  const pp = normalizePath(projectPath)
  const stockDir = path.join(pp, "wiki", "股票")
  const files = await listFilesRecursive(stockDir, {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
  }).catch(() => [])
  const stocks = []
  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8")
      const relativePath = projectRelative(pp, filePath)
      const { fm, body } = parseFrontmatter(content)
      const name = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : path.basename(filePath, ".md")
      const code = codeFromFrontmatterLike(fm)
      if (!code) continue
      const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : []
      const related = Array.isArray(fm.related) ? fm.related.map(String) : []
      const sources = Array.isArray(fm.sources) ? fm.sources.map(String) : []
      const searchText = [name, code, fm.summary, tags.join(" "), related.join(" "), sources.join(" "), body.slice(0, 12000)].filter(Boolean).join("\n")
      stocks.push({
        name,
        code,
        path: relativePath,
        tags,
        related,
        sources,
        status: fm.status ?? null,
        confidence: fm.confidence ?? null,
        summary: fm.summary ?? "",
        updated: fm.updated ?? fm.last_reviewed ?? null,
        searchText,
      })
    } catch {}
  }
  const byCode = new Map()
  for (const stock of stocks) {
    const old = byCode.get(stock.code)
    if (!old || stock.searchText.length > old.searchText.length) byCode.set(stock.code, stock)
  }
  return [...byCode.values()]
}

async function loadDailyLoopRecentCorpus(projectPath, lookbackDays) {
  const pp = normalizePath(projectPath)
  const roots = [
    path.join(pp, "wiki", "总结"),
    path.join(pp, "wiki", "模式"),
    path.join(pp, "wiki", "概念"),
    path.join(pp, "raw", "微信聊天"),
    path.join(pp, "raw", "研报新闻"),
    path.join(pp, "raw", "openclaw数据", "产业链复盘"),
    path.join(pp, "data", "facts"),
  ]
  const files = []
  for (const root of roots) {
    const found = await listFilesRecursive(root, {
      extensions: new Set([".md", ".txt", ".jsonl"]),
      excludeDirNames: new Set([".git", "node_modules", ".llm-wiki"]),
      maxBytes: 1024 * 1024 * 3,
    }).catch(() => [])
    files.push(...found)
  }
  const snippets = []
  for (const filePath of files) {
    const relativePath = projectRelative(pp, filePath)
    if (!isDailyLoopRecentPath(relativePath, lookbackDays) && !relativePath.startsWith("data/facts/")) continue
    const raw = await readIfExists(filePath)
    if (!raw.trim()) continue
    snippets.push({ path: relativePath, text: raw.slice(0, 20000) })
  }
  return snippets
}

function scoreDailyLoopThemes(recentCorpus) {
  const wholeText = recentCorpus.map((item) => `${item.path}\n${item.text}`).join("\n")
  return DAILY_LOOP_THEME_PROFILES.map((theme) => {
    let score = 0
    const matched = []
    for (const keyword of theme.keywords) {
      const count = (wholeText.match(new RegExp(escapeRegExp(keyword), "gi")) ?? []).length
      if (count > 0) {
        score += count
        matched.push(keyword)
      }
    }
    return { ...theme, score, matchedKeywords: matched }
  }).sort((a, b) => b.score - a.score || a.branch.localeCompare(b.branch, "zh"))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function scoreStockForTheme(stock, theme) {
  let score = 0
  const matched = []
  for (const keyword of theme.keywords) {
    if (stock.searchText.toLowerCase().includes(keyword.toLowerCase())) {
      score += keyword.length > 3 ? 4 : 2
      matched.push(keyword)
    }
  }
  if (String(stock.status ?? "").includes("活跃")) score += 2
  if (String(stock.status ?? "").includes("观察")) score += 1
  if (String(stock.confidence ?? "").includes("高")) score += 2
  if (String(stock.confidence ?? "").includes("中")) score += 1
  score += Math.min(stock.sources.length, 8) * 0.3
  return { ...stock, branch: theme.branch, themeId: theme.id, themeScore: theme.score, stockThemeScore: roundMetric(score, 2), matchedKeywords: matched }
}

function selectDailyLoopThemeStocks(stockUniverse, themes, maxStocksPerQuestion) {
  const byTheme = new Map()
  for (const theme of themes) {
    const scored = stockUniverse
      .map((stock) => scoreStockForTheme(stock, theme))
      .filter((stock) => stock.stockThemeScore > 0)
      .sort((a, b) => b.stockThemeScore - a.stockThemeScore || a.name.localeCompare(b.name, "zh"))
      .slice(0, Math.max(maxStocksPerQuestion * 2, maxStocksPerQuestion))
    byTheme.set(theme.id, scored)
  }
  return byTheme
}

function buildDailyLoopStockDailyNativeQuery(codes, descriptor, options = {}) {
  const columns = descriptor?.columns ?? resolveStockDailyColumns([])
  if (!columns.ready) throw new Error("stock_daily_sql is unavailable: missing ticker/date columns")
  const config = getStockDailyPgConfig(process.env, options)
  const table = `${quotePgIdentifier(config.schema)}.${quotePgIdentifier(config.table)}`
  const selected = [
    columns.ticker,
    columns.date,
    columns.open,
    columns.high,
    columns.low,
    columns.close,
    columns.preClose,
    columns.change,
    columns.pctChange,
    columns.volume,
    columns.amount,
    columns.turnover,
  ].filter(Boolean)
  const uniqueSelected = [...new Set(selected)]
  const selectSql = uniqueSelected.map((column) => quotePgIdentifier(column)).join(", ")
  const limit = Math.min(parsePositiveInteger(options.sqlLimit, ASK_DEFAULT_SQL_LIMIT), parsePositiveInteger(options.lookbackDays, 20))
  const normalizedCodes = [...new Set(codes.map(normalizeStockCode).filter(Boolean))]
  const tickerCandidates = normalizedCodes
  const validationAnchorDate = String(options.validationAnchorDate ?? "").trim()
  const hasValidationAnchor = /^\d{4}-\d{2}-\d{2}$/.test(validationAnchorDate)
  const dateColumn = quotePgIdentifier(columns.date)
  const validationAnchorPredicate = hasValidationAnchor ? `\n    and ${dateColumn} ${options.validationAnchorExclusive ? ">" : ">="} $3::date` : ""
  const rankOrder = hasValidationAnchor ? "asc" : "desc"
  const sql = `
with ranked as (
  select ${selectSql},
         row_number() over (partition by ${quotePgIdentifier(columns.ticker)} order by ${dateColumn} ${rankOrder}) as rn
  from ${table}
  where ${quotePgIdentifier(columns.ticker)} = any($1::text[])${validationAnchorPredicate}
)
select ${selectSql}
from ranked
where rn <= $2
order by ${quotePgIdentifier(columns.ticker)} asc, ${dateColumn} asc
`.trim()
  return {
    language: "SQL",
    sql,
    params: hasValidationAnchor ? [tickerCandidates, limit, validationAnchorDate] : [tickerCandidates, limit],
    summary: hasValidationAnchor
      ? `SELECT first ${limit} trading day(s) after prediction anchor ${validationAnchorDate} for ${normalizedCodes.length} ticker(s) FROM ${config.schema}.${config.table}`
      : `SELECT daily OHLCV metrics for ${normalizedCodes.length} ticker(s) FROM ${config.schema}.${config.table} LIMIT ${limit} per ticker`,
    table: `${config.database}.${config.schema}.${config.table}`,
    limit,
    tickerCandidates,
    normalizedCodes,
    validationAnchorDate: hasValidationAnchor ? validationAnchorDate : null,
    validationAnchorExclusive: hasValidationAnchor ? Boolean(options.validationAnchorExclusive) : null,
  }
}

function parseDailyLoopMarketValidateMode(value) {
  const raw = String(value ?? DAILY_LOOP_EXTERNAL_MARKET_DEFAULT).trim().toLowerCase()
  if (!raw || raw === "auto") return "auto"
  if (["off", "none", "false", "0"].includes(raw)) return "off"
  if (["tencent", "tencent_kline", "qq"].includes(raw)) return "tencent"
  if (["eastmoney", "eastmoney_kline", "online", "web"].includes(raw)) return "eastmoney"
  return "auto"
}

function eastmoneySecid(code) {
  const normalized = normalizeStockCode(code)
  if (!normalized) return null
  const exchange = normalized.slice(0, 2)
  const digits = normalized.slice(2)
  if (exchange === "SH") return `1.${digits}`
  if (exchange === "SZ") return `0.${digits}`
  if (exchange === "BJ") return `0.${digits}`
  return null
}

function eastmoneyKlineUrl(code, limit) {
  const secid = eastmoneySecid(code)
  if (!secid) return null
  return [
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?",
    `secid=${encodeURIComponent(secid)}`,
    "&klt=101&fqt=1",
    `&lmt=${Math.max(1, limit)}`,
    "&end=20500101",
    "&fields1=f1,f2,f3,f4,f5,f6",
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  ].join("")
}

function tencentSymbol(code) {
  const normalized = normalizeStockCode(code)
  if (!normalized) return null
  const exchange = normalized.slice(0, 2).toLowerCase()
  const digits = normalized.slice(2)
  if (!["sh", "sz", "bj"].includes(exchange)) return null
  return `${exchange}${digits}`
}

function tencentKlineUrl(code, limit) {
  const symbol = tencentSymbol(code)
  if (!symbol) return null
  return `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${Math.max(1, limit)},qfq`
}

async function normalizeExternalMarketPayload(payload) {
  if (payload && typeof payload.json === "function") return payload.json()
  if (typeof payload === "string") return JSON.parse(payload)
  return payload
}

async function httpsGetText(url, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 8000)
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          accept: "application/json,text/plain,*/*",
          referer: "https://quote.eastmoney.com/",
          "user-agent": "Mozilla/5.0 TradingReviewWiki/1.0",
        },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          body += chunk
        })
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve(body)
          else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
        })
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error(`HTTPS timeout after ${timeoutMs}ms`))
    })
    req.on("error", reject)
  })
}

async function curlGetText(url, options = {}) {
  const timeoutSec = String(Math.max(1, Math.ceil(parsePositiveInteger(options.timeoutMs, 8000) / 1000)))
  const { stdout } = await execFileAsync(
    "curl",
    [
      "-L",
      "--silent",
      "--show-error",
      "--connect-timeout",
      timeoutSec,
      "--max-time",
      timeoutSec,
      "-H",
      "Referer: https://quote.eastmoney.com/",
      "-H",
      "User-Agent: Mozilla/5.0 TradingReviewWiki/1.0",
      url,
    ],
    { maxBuffer: 1024 * 1024 },
  )
  return stdout
}

async function fetchJsonWithHttpsFallback(url, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 8000)
  try {
    return JSON.parse(await curlGetText(url, { timeoutMs }))
  } catch {
    // Some market endpoints are picky by client stack. Curl is fastest on this
    // machine; fetch/https remain as fallback for environments without curl.
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json,text/plain,*/*",
        referer: "https://quote.eastmoney.com/",
        "user-agent": "Mozilla/5.0 TradingReviewWiki/1.0",
      },
    })
    return response.json()
  } catch {
    return JSON.parse(await httpsGetText(url, { timeoutMs }))
  }
}

async function fetchEastmoneyKlinesForStock(stock, options = {}) {
  const limit = parsePositiveInteger(options.stockLookbackDays ?? options.lookbackDays, 20)
  const url = eastmoneyKlineUrl(stock.code, limit)
  if (!url) return { code: stock.code, status: "invalid_code", rows: [], warning: "无法映射东方财富 secid", source: "eastmoney_kline" }
  try {
    const payload = options.externalMarketFetcher
      ? await options.externalMarketFetcher({ source: "eastmoney_kline", code: stock.code, url, limit })
      : await fetchJsonWithHttpsFallback(url, { timeoutMs: options.externalMarketTimeoutMs })
    const parsed = await normalizeExternalMarketPayload(payload)
    if (parsed?.rc !== 0 || !parsed?.data) return { code: stock.code, status: "error", rows: [], warning: `东方财富返回异常 rc=${parsed?.rc ?? "NA"}`, source: "eastmoney_kline" }
    const normalized = normalizeStockCode(stock.code)
    const rows = Array.isArray(parsed.data.klines)
      ? parsed.data.klines
          .map((line) => String(line).split(","))
          .filter((parts) => parts.length >= 11)
          .map((parts) => ({
            ticker: normalized,
            date: parts[0],
            open: Number(parts[1]),
            close: Number(parts[2]),
            high: Number(parts[3]),
            low: Number(parts[4]),
            volume: Number(parts[5]),
            amount: Number(parts[6]),
            pctChange: Number(parts[8]),
            change: Number(parts[9]),
            turnover: Number(parts[10]),
          }))
      : []
    return { code: stock.code, status: rows.length > 0 ? "ok" : "no_rows", rows, warning: rows.length > 0 ? null : "东方财富未返回K线", name: parsed.data.name ?? stock.name, source: "eastmoney_kline" }
  } catch (err) {
    return { code: stock.code, status: "error", rows: [], warning: `东方财富K线失败: ${safeErrorMessage(err)}`, source: "eastmoney_kline" }
  }
}

async function fetchTencentKlinesForStock(stock, options = {}) {
  const limit = parsePositiveInteger(options.stockLookbackDays ?? options.lookbackDays, 20)
  const url = tencentKlineUrl(stock.code, limit)
  const symbol = tencentSymbol(stock.code)
  if (!url || !symbol) return { code: stock.code, status: "invalid_code", rows: [], warning: "无法映射腾讯 symbol", source: "tencent_kline" }
  try {
    const payload = options.externalMarketFetcher
      ? await options.externalMarketFetcher({ source: "tencent_kline", code: stock.code, url, limit })
      : JSON.parse(await curlGetText(url, { timeoutMs: options.externalMarketTimeoutMs }))
    const parsed = await normalizeExternalMarketPayload(payload)
    if (parsed?.code !== 0 || !parsed?.data?.[symbol]) return { code: stock.code, status: "error", rows: [], warning: `腾讯K线返回异常 code=${parsed?.code ?? "NA"}`, source: "tencent_kline" }
    const rawRows = parsed.data[symbol].qfqday ?? parsed.data[symbol].day ?? []
    const normalized = normalizeStockCode(stock.code)
    const rows = Array.isArray(rawRows)
      ? rawRows
          .filter((parts) => Array.isArray(parts) && parts.length >= 6)
          .map((parts) => ({
            ticker: normalized,
            date: parts[0],
            open: Number(parts[1]),
            close: Number(parts[2]),
            high: Number(parts[3]),
            low: Number(parts[4]),
            volume: Number(parts[5]),
            amount: null,
            pctChange: null,
            change: null,
            turnover: null,
          }))
      : []
    return { code: stock.code, status: rows.length > 0 ? "ok" : "no_rows", rows, warning: rows.length > 0 ? null : "腾讯未返回K线", name: stock.name, source: "tencent_kline" }
  } catch (err) {
    return { code: stock.code, status: "error", rows: [], warning: `腾讯K线失败: ${safeErrorMessage(err)}`, source: "tencent_kline" }
  }
}

async function fetchDailyLoopExternalMarketMetrics(stocks, options = {}) {
  const mode = parseDailyLoopMarketValidateMode(options.marketValidate ?? options.marketValidation ?? options.externalMarket)
  const uniqueStocks = [...new Map(stocks.filter((stock) => stock?.code).map((stock) => [stock.code, stock])).values()]
  if (mode === "off") return { status: "off", source: null, metrics: new Map(), warning: "external market validation disabled" }
  if (uniqueStocks.length === 0) return { status: "empty", source: "eastmoney_kline", metrics: new Map(), warning: "没有可外部验证的股票代码" }
  const concurrency = parsePositiveInteger(options.externalMarketConcurrency, 4)
  const source = mode === "eastmoney" ? "eastmoney_kline" : "tencent_kline"
  const items = await mapWithConcurrency(uniqueStocks, concurrency, async (stock) => {
    const fetchOptions = { ...options, lookbackDays: options.stockLookbackDays ?? options.lookbackDays ?? 20 }
    if (mode === "eastmoney") return fetchEastmoneyKlinesForStock(stock, fetchOptions)
    const tencent = await fetchTencentKlinesForStock(stock, fetchOptions)
    if (tencent.status === "ok" || mode === "tencent") return tencent
    return fetchEastmoneyKlinesForStock(stock, fetchOptions)
  })
  const metrics = new Map()
  let okCount = 0
  const warnings = []
  for (const item of items) {
    const stock = uniqueStocks.find((candidate) => candidate.code === item.code)
    if (!stock) continue
    const itemSource = item.source ?? source
    if (item.status === "ok") {
      okCount += 1
      const metric = metricFromStockRows({
        code: stock.code,
        name: stock.name,
        branch: stock.branch,
        rows: item.rows,
        columns: EASTMONEY_KLINE_COLUMNS,
        tableName: itemSource,
      })
      metrics.set(stock.code, { ...metric, source: itemSource, externalRef: `external:${itemSource}#${stock.code}/${metric.endDate}` })
    } else {
      metrics.set(stock.code, { code: stock.code, name: stock.name, branch: stock.branch, status: item.status, warning: item.warning, source: itemSource })
      if (item.warning) warnings.push(`${stock.code}: ${item.warning}`)
    }
  }
  return {
    status: okCount > 0 ? "ok" : "unavailable",
    source,
    metrics,
    okCount,
    total: uniqueStocks.length,
    warning: warnings.length ? warnings.slice(0, 5).join("; ") : null,
  }
}

function marketMetricDateValue(metric) {
  const parsed = Date.parse(`${metric?.endDate ?? ""}T00:00:00`)
  return Number.isFinite(parsed) ? parsed : null
}

function compareDailyMarketMetrics(sqlMetric, externalMetric) {
  const sqlOk = sqlMetric?.status === "ok"
  const extOk = externalMetric?.status === "ok"
  if (sqlOk && extOk) {
    const sqlDate = marketMetricDateValue(sqlMetric)
    const extDate = marketMetricDateValue(externalMetric)
    const pctDiff = sqlMetric.pct20 != null && externalMetric.pct20 != null ? Math.abs(sqlMetric.pct20 - externalMetric.pct20) : null
    const closeDiffPct =
      sqlMetric.closeEnd != null && externalMetric.closeEnd != null && externalMetric.closeEnd !== 0
        ? Math.abs((sqlMetric.closeEnd - externalMetric.closeEnd) / externalMetric.closeEnd) * 100
        : null
    if (extDate != null && sqlDate != null && extDate > sqlDate) {
      return {
        status: "sql_stale",
        confidence: 0.72,
        reason: `本地SQL日期${sqlMetric.endDate}落后在线行情${externalMetric.endDate}`,
        pctDiff: roundMetric(pctDiff, 2),
        closeDiffPct: roundMetric(closeDiffPct, 2),
      }
    }
    if ((pctDiff != null && pctDiff > 3) || (closeDiffPct != null && closeDiffPct > 1.5)) {
      return {
        status: "divergent",
        confidence: 0.45,
        reason: `SQL与在线行情差异较大 pctDiff=${roundMetric(pctDiff, 2)} closeDiffPct=${roundMetric(closeDiffPct, 2)}`,
        pctDiff: roundMetric(pctDiff, 2),
        closeDiffPct: roundMetric(closeDiffPct, 2),
      }
    }
    return { status: "confirmed", confidence: 0.95, reason: "SQL与在线行情口径基本一致", pctDiff: roundMetric(pctDiff, 2), closeDiffPct: roundMetric(closeDiffPct, 2) }
  }
  if (extOk && !sqlOk) return { status: "external_only", confidence: 0.65, reason: "只有在线行情可用，本地SQL缺失或失败" }
  if (sqlOk && !extOk) return { status: "sql_only", confidence: 0.55, reason: externalMetric?.warning ?? "在线行情不可用，仅有本地SQL" }
  return { status: "unavailable", confidence: 0.2, reason: "本地SQL与在线行情均不可用" }
}

function mergeDailyLoopMarketMetrics(stocks, sqlMetrics, externalMetrics) {
  const merged = new Map()
  for (const stock of stocks) {
    const sqlMetric = sqlMetrics.get(stock.code) ?? { code: stock.code, name: stock.name, status: "missing" }
    const externalMetric = externalMetrics.get(stock.code) ?? { code: stock.code, name: stock.name, status: "missing", source: "eastmoney_kline" }
    const validation = compareDailyMarketMetrics(sqlMetric, externalMetric)
    const sqlDate = marketMetricDateValue(sqlMetric)
    const extDate = marketMetricDateValue(externalMetric)
    const useExternal = externalMetric.status === "ok" && (sqlMetric.status !== "ok" || validation.status === "sql_stale" || extDate == null || sqlDate == null || extDate >= sqlDate)
    const primary = useExternal ? externalMetric : sqlMetric
    const refs = [
      sqlMetric.status === "ok" ? sqlMetric.sqlRef : null,
      externalMetric.status === "ok" ? externalMetric.externalRef : null,
    ].filter(Boolean)
    merged.set(stock.code, {
      ...primary,
      amountRatio: primary.amountRatio ?? sqlMetric.amountRatio ?? externalMetric.amountRatio ?? null,
      avgTurnoverLast5: primary.avgTurnoverLast5 ?? sqlMetric.avgTurnoverLast5 ?? externalMetric.avgTurnoverLast5 ?? null,
      volumeRatio: primary.volumeRatio ?? externalMetric.volumeRatio ?? sqlMetric.volumeRatio ?? null,
      source: useExternal ? externalMetric.source ?? "external_market" : "stock_daily_sql",
      sqlMetric,
      externalMetric,
      marketValidation: validation,
      refs,
      sqlRef: sqlMetric.status === "ok" ? sqlMetric.sqlRef : null,
      externalRef: externalMetric.status === "ok" ? externalMetric.externalRef : null,
    })
  }
  return merged
}

function metricFromStockRows({ code, name, branch, rows, columns, tableName, requiredRows = null }) {
  const sorted = [...rows].sort((a, b) => {
    const av = sqlDateSortValue(a[columns.date])
    const bv = sqlDateSortValue(b[columns.date])
    if (typeof av === "number" && typeof bv === "number") return av - bv
    return String(av).localeCompare(String(bv))
  })
  if (sorted.length === 0) return { code, name, branch, status: "no_rows" }
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const ref = stockDailyRowRef(last, columns, code, tableName)
  const required = parsePositiveInteger(requiredRows, null)
  if (required && sorted.length < required) {
    return {
      code,
      name,
      branch,
      status: "not_due",
      rows: sorted.length,
      requiredRows: required,
      startDate: formatSqlCell(first[columns.date]),
      endDate: formatSqlCell(last[columns.date]),
      warning: `窗口尚未到期：需要 ${required} 个交易日，当前只有 ${sorted.length} 个`,
      sqlRef: ref,
    }
  }
  const firstClose = numberFromSqlCell(first[columns.close])
  const lastClose = numberFromSqlCell(last[columns.close])
  const fallbackPct = columns.pctChange ? numberFromSqlCell(last[columns.pctChange]) : null
  const pct20 = firstClose != null && firstClose !== 0 && lastClose != null && sorted.length >= 2 ? ((lastClose - firstClose) / firstClose) * 100 : fallbackPct
  const first5 = sorted.slice(0, Math.min(5, sorted.length))
  const last5 = sorted.slice(Math.max(0, sorted.length - 5))
  const avgAmountFirst5 = columns.amount ? averageNumbers(first5.map((row) => row[columns.amount])) : null
  const avgAmountLast5 = columns.amount ? averageNumbers(last5.map((row) => row[columns.amount])) : null
  const avgVolumeFirst5 = columns.volume ? averageNumbers(first5.map((row) => row[columns.volume])) : null
  const avgVolumeLast5 = columns.volume ? averageNumbers(last5.map((row) => row[columns.volume])) : null
  const avgTurnoverLast5 = columns.turnover ? averageNumbers(last5.map((row) => row[columns.turnover])) : null
  return {
    code,
    name,
    branch,
    status: "ok",
    startDate: formatSqlCell(first[columns.date]),
    endDate: formatSqlCell(last[columns.date]),
    rows: sorted.length,
    closeStart: roundMetric(firstClose, 4),
    closeEnd: roundMetric(lastClose, 4),
    pct20: roundMetric(pct20, 2),
    avgAmountFirst5: roundMetric(avgAmountFirst5, 2),
    avgAmountLast5: roundMetric(avgAmountLast5, 2),
    amountRatio: avgAmountFirst5 ? roundMetric(avgAmountLast5 / avgAmountFirst5, 2) : null,
    avgVolumeFirst5: roundMetric(avgVolumeFirst5, 2),
    avgVolumeLast5: roundMetric(avgVolumeLast5, 2),
    volumeRatio: avgVolumeFirst5 ? roundMetric(avgVolumeLast5 / avgVolumeFirst5, 2) : null,
    avgTurnoverLast5: roundMetric(avgTurnoverLast5, 2),
    latestPctCng: columns.pctChange ? roundMetric(numberFromSqlCell(last[columns.pctChange]), 2) : null,
    sqlRef: ref,
  }
}

async function fetchDailyLoopStockMetrics(stocks, options = {}) {
  const uniqueStocks = [...new Map(stocks.filter((stock) => stock?.code).map((stock) => [stock.code, stock])).values()]
  if (uniqueStocks.length === 0) return { status: "empty", metrics: new Map(), warning: "没有可查询的股票代码", nativeQuery: null }
  const descriptor = options.stockDailyDescriptor ?? (await describeStockDailySqlSource(options))
  if (!descriptor.ok && !options.stockDailyExecutor) {
    return { status: "unavailable", metrics: new Map(), warning: `SQL 源不可用: ${descriptor.error}`, nativeQuery: null, descriptor }
  }
  const nativeQuery = buildDailyLoopStockDailyNativeQuery(
    uniqueStocks.map((stock) => stock.code),
    descriptor,
    { ...options, lookbackDays: options.stockLookbackDays ?? options.lookbackDays ?? 20 },
  )
  try {
    const execution = await executeStockDailyQuery(nativeQuery, options)
    const rows = Array.isArray(execution?.rows) ? execution.rows : []
    const columns = descriptor.columns
    const tableName = nativeQuery.table.split(".").slice(-1)[0]
    const codeByTicker = new Map()
    for (const stock of uniqueStocks) {
      for (const alt of stockCodeAlternatives(stock.code)) codeByTicker.set(alt, stock.code)
    }
    const grouped = new Map()
    for (const row of rows) {
      const rowTicker = String(row[columns.ticker] ?? "")
      const code = codeByTicker.get(rowTicker) ?? normalizeStockCode(rowTicker)
      if (!code) continue
      if (!grouped.has(code)) grouped.set(code, [])
      grouped.get(code).push(row)
    }
    const metrics = new Map()
    for (const stock of uniqueStocks) {
      metrics.set(
        stock.code,
        metricFromStockRows({
          code: stock.code,
          name: stock.name,
          branch: stock.branch,
          rows: grouped.get(stock.code) ?? [],
          columns,
          tableName,
          requiredRows: options.requiredRows,
        }),
      )
    }
    return { status: "ok", metrics, warning: rows.length > 0 ? null : "SQL 源执行成功，但没有返回日线记录", nativeQuery, descriptor }
  } catch (err) {
    return { status: "error", metrics: new Map(), warning: `SQL 查询失败: ${safeErrorMessage(err)}`, nativeQuery, descriptor }
  }
}

function attachDailyLoopMetrics(stocks, metricsByCode) {
  return stocks.map((stock) => ({
    ...stock,
    metric: metricsByCode.get(stock.code) ?? { code: stock.code, name: stock.name, status: "missing" },
  }))
}

function underReflectedScore(stock) {
  const metric = stock.metric ?? {}
  const pct = metric.pct20
  const amountRatio = metric.amountRatio ?? 1
  if (pct == null) return stock.stockThemeScore
  return stock.stockThemeScore + Math.max(0, 18 - pct) * 0.8 + Math.max(0, amountRatio - 1) * 4
}

function strongMovedScore(stock) {
  const metric = stock.metric ?? {}
  const pct = metric.pct20 ?? 0
  return stock.stockThemeScore + Math.max(0, pct - 20) * 0.8 + Math.max(0, (metric.amountRatio ?? 1) - 1) * 2
}

function compactDailyStocks(stocks, maxCount) {
  return stocks.slice(0, maxCount).map((stock) => ({
    name: stock.name,
    code: stock.code,
    path: stock.path,
    branch: stock.branch,
    matchedKeywords: stock.matchedKeywords ?? [],
    metric: stock.metric ?? null,
  }))
}

function stockLabel(stock) {
  return `${stock.name}(${stock.code})`
}

function buildDailyLoopQuestion({ type, mode, theme, stocks, index }) {
  const branch = theme.branch
  const questionByType = {
    expected_difference: `最近一个月，AI硬件里的 ${branch} 是否属于知识库反复出现但股价还没充分反映的补涨方向？请结合原始材料、图谱关系、产业卡脖子程度和近20日量价做排序。`,
    bottleneck_supplier: `参考知识库里的热门赛道，${branch} 里哪些细分颗粒度方向更接近“卡脖子、不可替代、供货商议价权强”？请结合产业链位置、客户/订单线索、替代难度和股价反映程度找机会。`,
    weak_to_strong_low_buy: `最近市场热门方向里，${branch} 有没有从强转弱后的低吸机会？请区分情绪退潮、产业逻辑未坏和量价承接仍在的候选，并给出低吸条件与反证。`,
    risk_counter: `${branch} 里哪些细分机会可能已经被股价过度反映，容易演化成强一致接盘或高开回落？请结合近20日量价、知识库错误模式和原始材料反证排序。`,
    postclose_validation: `盘后验证 ${branch}：今日和近20日量价是否支持此前“补涨/卡脖子/供货商不可替代”的假设？哪些方向应升级、降级或继续观察？`,
    correction: `结合最近交易错误和 ${branch} 的机会挖掘，哪些提问或买入逻辑容易诱发追高、强一致接盘或低质量补涨？请输出下一轮防守语句和验证清单。`,
    wiki_feedback: `把今日 ${branch} 的证据、量价、反证和验证结果整理成待审核 wiki 反哺建议：哪些概念页、股票页、错误页需要更新？`,
  }
  return {
    id: `daily_q_${index + 1}`,
    type,
    mode,
    branch,
    themeId: theme.id,
    question: questionByType[type] ?? questionByType.expected_difference,
    stocks: compactDailyStocks(stocks, stocks.length),
    expectedMove: type === "risk_counter" ? "bearish" : "bullish",
    validationWindows: DAILY_LOOP_DEFAULT_VALIDATION_WINDOWS,
  }
}

function buildDailyLoopAskQuery(question) {
  const stockContext = question.stocks
    .map((stock) => {
      const metric = stock.metric ?? {}
      const metricText =
        metric.status === "ok"
          ? `近20日${metric.pct20 ?? "NA"}%，成交额比${metric.amountRatio ?? "NA"}x，换手${metric.avgTurnoverLast5 ?? "NA"}，行情验证${metric.marketValidation?.status ?? "unknown"}，${(metric.refs ?? [metric.sqlRef, metric.externalRef]).filter(Boolean).join(" ")}`
          : "日线不足"
      return `${stock.name}(${stock.code}) ${stock.branch ?? question.branch} ${metricText} 来源:${stock.path ?? ""}`
    })
    .join("\n")
  return `${question.question}

候选股票池和量价验证材料如下。请只把它当作可验证对象，不要把问题改写成单票复盘：
${stockContext}

回答时请优先做分支/细分方向排序，再落到上市公司验证，保留 wiki/raw/graph/facts/sql 引用。`
}

function dailyLoopQuestionTypesForMode(mode) {
  return DAILY_LOOP_QUESTION_TYPES_BY_MODE.get(mode) ?? DAILY_LOOP_QUESTION_TYPES_BY_MODE.get("full")
}

function normalizeDailyLoopQuestionType(value, fallback = "expected_difference") {
  const raw = String(value ?? "").trim()
  if (Object.hasOwn(DAILY_LOOP_QUESTION_TYPE_LABELS, raw)) return raw
  return fallback
}

function scoreRecentCorpusForTheme(item, theme) {
  const text = `${item.path}\n${item.text}`.toLowerCase()
  let score = 0
  for (const keyword of theme.keywords ?? []) {
    const lowered = keyword.toLowerCase()
    if (text.includes(lowered)) score += keyword.length > 3 ? 3 : 1
  }
  if (isDailyLoopRecentPath(item.path, 7)) score += 2
  return score
}

function compactDailyLoopMetric(metric = {}) {
  if (metric.status !== "ok") return { status: metric.status ?? "missing" }
  return {
    status: "ok",
    source: metric.source ?? "stock_daily_sql",
    startDate: metric.startDate,
    endDate: metric.endDate,
    pct20: metric.pct20,
    amountRatio: metric.amountRatio,
    volumeRatio: metric.volumeRatio,
    avgTurnoverLast5: metric.avgTurnoverLast5,
    sqlRef: metric.sqlRef,
    externalRef: metric.externalRef,
    refs: metric.refs,
    marketValidation: metric.marketValidation,
  }
}

function compactDailyLoopStockForPlanner(stock) {
  return {
    name: stock.name,
    code: stock.code,
    branch: stock.branch,
    path: stock.path,
    matchedKeywords: (stock.matchedKeywords ?? []).slice(0, 8),
    stockThemeScore: stock.stockThemeScore,
    summary: excerptForPrompt(stock.summary || stock.searchText || "", 240),
    metric: compactDailyLoopMetric(stock.metric),
  }
}

function compactDailyLoopHistoricalQuestion(record) {
  return {
    runId: record.runId ?? null,
    createdAt: record.createdAt ?? null,
    questionType: record.questionType ?? null,
    branch: record.branch ?? null,
    question: excerptForPrompt(record.question ?? "", 260),
  }
}

async function loadRecentDailyLoopQuestionHistory(projectPath, { mode, limit = 24 } = {}) {
  const records = await readBrainRecords(projectPath)
  return records
    .map((item) => item.value)
    .filter((record) => record?.type === "prediction" && record.kind === "daily-discovery")
    .filter((record) => !mode || record.mode === mode)
    .filter((record) => record.question)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, limit)
    .map(compactDailyLoopHistoricalQuestion)
}

function dailyLoopQuestionTokenSet(question) {
  return new Set(tokenizeQuery(question).filter((token) => token.length > 1))
}

function dailyLoopQuestionSimilarity(left, right) {
  const leftTokens = dailyLoopQuestionTokenSet(left)
  const rightTokens = dailyLoopQuestionTokenSet(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let intersection = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1
  }
  const union = leftTokens.size + rightTokens.size - intersection
  const jaccard = union > 0 ? intersection / union : 0
  const containment = intersection / Math.min(leftTokens.size, rightTokens.size)
  return Math.max(jaccard, containment * 0.75)
}

function findDailyLoopDuplicateQuestion(question, recentQuestions) {
  const text = String(question.question ?? "").trim()
  if (!text) return null
  for (const previous of recentQuestions ?? []) {
    const score = dailyLoopQuestionSimilarity(text, previous.question)
    const sameBranch = question.branch && previous.branch && String(question.branch) === String(previous.branch)
    const sameType = question.type && previous.questionType && String(question.type) === String(previous.questionType)
    if (score >= 0.52 || (sameBranch && score >= 0.48) || (sameBranch && sameType && score >= 0.42)) {
      return { previous, score }
    }
  }
  return null
}

function dedupeDailyLoopQuestions(questions, recentQuestions, questionCount) {
  const accepted = []
  let duplicateFilteredCount = 0
  for (const question of questions) {
    if (accepted.length >= questionCount) break
    const duplicate = findDailyLoopDuplicateQuestion(question, recentQuestions)
    if (duplicate) {
      duplicateFilteredCount += 1
      continue
    }
    accepted.push(question)
  }
  return { questions: accepted, duplicateFilteredCount }
}

function renumberDailyLoopQuestions(questions) {
  return questions.map((question, index) => ({ ...question, id: `daily_q_${index + 1}` }))
}

function buildDailyLoopQuestionPlannerPrompt({ mode, questionCount, themes, stocksByTheme, metricsByCode, recentCorpus, maxStocksPerQuestion, recentQuestions = [] }) {
  const questionTypes = dailyLoopQuestionTypesForMode(mode).slice(0, questionCount)
  while (questionTypes.length < questionCount) questionTypes.push(dailyLoopQuestionTypesForMode(mode)[questionTypes.length % dailyLoopQuestionTypesForMode(mode).length])
  const activeThemes = themes
    .filter((theme) => (stocksByTheme.get(theme.id) ?? []).length > 0)
    .slice(0, 8)
    .map((theme) => {
      const stocks = attachDailyLoopMetrics(stocksByTheme.get(theme.id) ?? [], metricsByCode)
        .sort((a, b) => underReflectedScore(b) - underReflectedScore(a))
        .slice(0, Math.max(maxStocksPerQuestion * 2, maxStocksPerQuestion))
        .map(compactDailyLoopStockForPlanner)
      const evidence = recentCorpus
        .map((item) => ({ path: item.path, score: scoreRecentCorpusForTheme(item, theme), excerpt: excerptForPrompt(item.text, 420) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.path.localeCompare(a.path))
        .slice(0, 4)
      return {
        id: theme.id,
        branch: theme.branch,
        score: theme.score,
        matchedKeywords: (theme.matchedKeywords ?? []).slice(0, 16),
        stocks,
        evidence,
      }
    })
  return [
    "# Daily Trading Research Question Planner",
    "",
    `mode: ${mode}`,
    `question_count: ${questionCount}`,
    "",
    "You are planning deep daily research questions for a Chinese A-share trading knowledge base.",
    "Generate questions by thinking from the evidence, not by filling a template.",
    "",
    "Hard requirements:",
    "- Questions must be deep industry/trading research questions, not shallow single-stock price questions.",
    "- Each question should first ask about branch/sub-sector opportunity, expectation gap, bottleneck supplier, low-buy setup, risk counterevidence, validation, correction, or wiki feedback.",
    "- Put concrete stocks only in stockCodes; the question text may mention branches but should not become a list of tickers.",
    "- Every question must select 1-8 stockCodes from the provided candidate pools so later SQL validation can run.",
    "- Prefer questions similar in depth to: 最近一个月，AI硬件里MLCC、PCB材料、光模块、电源管理这些分支，哪些是知识库里反复出现但股价还没充分反映的补涨方向？请结合原始材料、图谱关系和近20日量价给我排序。",
    "- Do not repeat or lightly paraphrase recent daily-loop questions. A valid new question must introduce a materially new variable, branch angle, verification method, stock pool, or counterevidence path.",
    "- Avoid reusing the same branch + questionType framing from recent history unless the new question is clearly orthogonal.",
    "- If evidence is weak, ask a risk/反证/待验证 question instead of fabricating certainty.",
    "",
    "Recent daily-loop questions to avoid:",
    "```json",
    JSON.stringify(recentQuestions, null, 2),
    "```",
    "",
    "Requested mix:",
    "```json",
    JSON.stringify(questionTypes.map((type, index) => ({ index: index + 1, questionType: type, label: DAILY_LOOP_QUESTION_TYPE_LABELS[type] })), null, 2),
    "```",
    "",
    "Candidate themes, corpus evidence, stock pools and SQL metrics:",
    "```json",
    JSON.stringify(activeThemes, null, 2),
    "```",
    "",
    "Return only JSON:",
    '{"questions":[{"questionType":"expected_difference","themeId":"ai-pcb-materials","branch":"PCB材料/工艺链","question":"...","expectedMove":"bullish","stockCodes":["SH600183"],"reason":"..."}]}',
  ].join("\n")
}

async function requestDailyLoopQuestionsWithLlm({ mode, questionCount, themes, stocksByTheme, metricsByCode, recentCorpus, maxStocksPerQuestion, recentQuestions, projectPath, options }) {
  const prompt = buildDailyLoopQuestionPlannerPrompt({ mode, questionCount, themes, stocksByTheme, metricsByCode, recentCorpus, maxStocksPerQuestion, recentQuestions })
  const instructions = "You are a daily A-share research question planner. Return only the requested JSON object. Do not edit files."
  let text
  if (options.dailyLoopQuestionPlanner) {
    const planned = await options.dailyLoopQuestionPlanner({ stage: "daily-loop-question-planner", prompt, instructions, mode, questionCount, themes, stocksByTheme })
    if (typeof planned === "string") text = planned
    else return Array.isArray(planned?.questions) ? planned.questions : Array.isArray(planned) ? planned : []
  } else if ((options.provider ?? "codex") === "codex") {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-wiki-daily-planner-"))
    const outputPath = path.join(tmpDir, "questions.json")
    try {
      text = await requestCodexExecText({
        stage: "daily-loop-question-planner",
        prompt,
        instructions,
        model: options.model,
        prepared: { projectPath },
        outputPath,
        codexBin: options.codexBin,
        codexProfile: options.codexProfile,
        codexProfileV2: options.codexProfileV2,
        codexTimeoutMs: options.codexTimeoutMs,
      })
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  } else if ((options.provider ?? "") === "openai") {
    const apiKey = resolveOpenAiApiKey(options)
    const model = options.model ?? process.env.OPENAI_MODEL
    if (!apiKey || !model) throw new Error("OpenAI daily-loop planner skipped because api key/model is missing")
    text = await requestOpenAiProviderText({
      apiKey,
      endpoint: options.endpoint,
      apiMode: options.apiMode,
      model,
      prompt,
      instructions,
      reasoningEffort: options.reasoningEffort ?? "high",
    })
  } else {
    throw new Error(`Unsupported daily-loop planner provider: ${options.provider}`)
  }
  const parsed = parseJsonObjectFromModelText(text)
  return Array.isArray(parsed.questions) ? parsed.questions : []
}

function resolveDailyLoopPlannedQuestions({ planned, mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion }) {
  const activeThemes = themes.filter((theme) => (stocksByTheme.get(theme.id) ?? []).length > 0)
  const themeById = new Map(activeThemes.map((theme) => [theme.id, theme]))
  const allStocks = [...stocksByTheme.values()].flat()
  const stockByCode = new Map(attachDailyLoopMetrics(allStocks, metricsByCode).map((stock) => [stock.code, stock]))
  const fallbackTypes = dailyLoopQuestionTypesForMode(mode)
  const resolved = []

  for (const item of planned ?? []) {
    if (resolved.length >= questionCount) break
    const fallbackType = fallbackTypes[resolved.length % fallbackTypes.length]
    const type = normalizeDailyLoopQuestionType(item.questionType ?? item.type, fallbackType)
    const theme =
      themeById.get(String(item.themeId ?? "")) ??
      activeThemes.find((candidate) => String(item.branch ?? "").includes(candidate.branch) || candidate.branch.includes(String(item.branch ?? ""))) ??
      activeThemes[resolved.length % Math.max(activeThemes.length, 1)]
    if (!theme) continue
    const themeStocks = attachDailyLoopMetrics(stocksByTheme.get(theme.id) ?? [], metricsByCode)
    const ranked =
      type === "risk_counter"
        ? [...themeStocks].sort((a, b) => strongMovedScore(b) - strongMovedScore(a))
        : [...themeStocks].sort((a, b) => underReflectedScore(b) - underReflectedScore(a))
    const requestedCodes = Array.isArray(item.stockCodes) ? item.stockCodes.map(normalizeStockCode).filter(Boolean) : []
    const picked = []
    for (const code of requestedCodes) {
      const stock = ranked.find((candidate) => candidate.code === code) ?? stockByCode.get(code)
      if (stock && !picked.some((candidate) => candidate.code === stock.code)) picked.push(stock)
    }
    for (const stock of ranked) {
      if (picked.length >= maxStocksPerQuestion) break
      if (!picked.some((candidate) => candidate.code === stock.code)) picked.push(stock)
    }
    if (picked.length === 0) continue
    const questionText = String(item.question ?? "").replace(/\s+/g, " ").trim()
    const fallback = buildDailyLoopQuestion({ type, mode, theme, stocks: picked.slice(0, maxStocksPerQuestion), index: resolved.length })
    resolved.push({
      ...fallback,
      question: questionText.length >= 20 ? questionText : fallback.question,
      branch: item.branch ? String(item.branch).trim() : fallback.branch,
      expectedMove: ["bullish", "bearish", "observe"].includes(String(item.expectedMove ?? "")) ? String(item.expectedMove) : fallback.expectedMove,
      plannerReason: item.reason ? String(item.reason).trim() : null,
    })
  }

  if (resolved.length < questionCount) {
    const fallback = pickDailyLoopQuestions({ mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion })
    for (const item of fallback) {
      if (resolved.length >= questionCount) break
      if (resolved.some((existing) => existing.question === item.question)) continue
      resolved.push({ ...item, id: `daily_q_${resolved.length + 1}` })
    }
  }

  return resolved.slice(0, questionCount).map((item, index) => ({ ...item, id: `daily_q_${index + 1}` }))
}

async function planDailyLoopQuestions({ mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion, recentCorpus, projectPath, options }) {
  const recentQuestions = await loadRecentDailyLoopQuestionHistory(projectPath, { mode })
  let duplicateFilteredCount = 0
  const fallbackQuestions = (existingQuestions = []) => {
    const rawFallback = pickDailyLoopQuestions({ mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion })
    const deduped = dedupeDailyLoopQuestions([...existingQuestions, ...rawFallback], recentQuestions, questionCount)
    duplicateFilteredCount += deduped.duplicateFilteredCount
    return deduped.questions
  }
  if (options.useLlmQuestionPlanner === false) {
    return { questions: renumberDailyLoopQuestions(fallbackQuestions()), planner: { status: "fallback", mode: "rules", warning: "LLM question planner disabled", historyCount: recentQuestions.length, duplicateFilteredCount } }
  }
  try {
    const planned = await requestDailyLoopQuestionsWithLlm({ mode, questionCount, themes, stocksByTheme, metricsByCode, recentCorpus, maxStocksPerQuestion, recentQuestions, projectPath, options })
    const resolved = resolveDailyLoopPlannedQuestions({ planned, mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion })
    const deduped = dedupeDailyLoopQuestions(resolved, recentQuestions, questionCount)
    duplicateFilteredCount += deduped.duplicateFilteredCount
    const questions = renumberDailyLoopQuestions(deduped.questions.length < questionCount ? fallbackQuestions(deduped.questions) : deduped.questions)
    if (questions.length > 0) {
      return { questions, planner: { status: "llm", mode: options.provider ?? "codex", warning: null, plannedCount: planned.length, historyCount: recentQuestions.length, duplicateFilteredCount } }
    }
    return { questions: renumberDailyLoopQuestions(fallbackQuestions()), planner: { status: "fallback", mode: "rules", warning: "LLM planner returned no usable non-duplicate questions", historyCount: recentQuestions.length, duplicateFilteredCount } }
  } catch (err) {
    return { questions: renumberDailyLoopQuestions(fallbackQuestions()), planner: { status: "fallback", mode: "rules", warning: `LLM question planner failed: ${safeErrorMessage(err)}`, historyCount: recentQuestions.length, duplicateFilteredCount } }
  }
}

function pickDailyLoopQuestions({ mode, themes, stocksByTheme, metricsByCode, questionCount, maxStocksPerQuestion }) {
  const activeThemes = themes.filter((theme) => (stocksByTheme.get(theme.id) ?? []).length > 0)
  const questions = []
  const templates = dailyLoopQuestionTypesForMode(mode)
  for (let i = 0; questions.length < questionCount; i++) {
    const type = templates[i % templates.length]
    const theme = activeThemes[i % Math.max(activeThemes.length, 1)]
    if (!theme) break
    const themeStocks = attachDailyLoopMetrics(stocksByTheme.get(theme.id) ?? [], metricsByCode)
    const sorted =
      type === "risk_counter"
        ? themeStocks.sort((a, b) => strongMovedScore(b) - strongMovedScore(a))
        : type === "weak_to_strong_low_buy"
          ? themeStocks.sort((a, b) => underReflectedScore(b) - underReflectedScore(a))
          : themeStocks.sort((a, b) => underReflectedScore(b) - underReflectedScore(a))
    const picked = sorted.filter((stock) => stock.code).slice(0, maxStocksPerQuestion)
    if (picked.length === 0) continue
    questions.push(buildDailyLoopQuestion({ type, mode, theme, stocks: picked, index: questions.length }))
    if (i > questionCount * 3) break
  }
  return questions
}

function summarizeAskAnswer(answer) {
  const text = String(answer ?? "").replace(/\r/g, "").trim()
  if (!text) return "未生成回答"
  const firstMeaningful = text
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line && !["结论", "证据链", "引用来源"].includes(line))[0]
  return excerptForPrompt(firstMeaningful ?? text, 260)
}

function predictionRecordFromDailyQuestion({ runId, mode, question, answer, createdAt }) {
  return {
    id: makeBrainRecordId("prediction", `${runId}:${question.id}`),
    type: "prediction",
    kind: "daily-discovery",
    runId,
    mode,
    question: question.question,
    questionType: question.type,
    answerSummary: summarizeAskAnswer(answer),
    thesis: summarizeAskAnswer(answer),
    branch: question.branch,
    stocks: question.stocks,
    expectedMove: question.expectedMove,
    validationWindows: question.validationWindows,
    status: "pending",
    evidenceRefs: question.stocks.map((stock) => stock.path).filter(Boolean),
    sqlRefs: question.stocks.flatMap((stock) => stock.metric?.refs ?? [stock.metric?.sqlRef]).filter(Boolean),
    marketRefs: question.stocks.flatMap((stock) => stock.metric?.refs ?? [stock.metric?.sqlRef, stock.metric?.externalRef]).filter(Boolean),
    createdAt,
  }
}

async function answerDailyLoopQuestion(question, options = {}) {
  if (options.dailyLoopAnswerer) return options.dailyLoopAnswerer({ question, options })
  const result = await askWiki({
    ...options,
    query: buildDailyLoopAskQuery(question),
    projectPath: options.projectPath,
    provider: options.provider ?? "codex",
    sources: options.sources ?? "auto",
    sourceK: options.sourceK ?? 5,
    topWiki: options.topWiki ?? 10,
    topRaw: options.topRaw ?? 10,
    topBrain: options.topBrain ?? 6,
    graphNeighbors: options.graphNeighbors ?? 8,
    graphDepth: options.graphDepth,
    sqlLimit: options.sqlLimit ?? 200,
    showContext: false,
  })
  return result.answer
}

async function writeDailyLoopJsonl(filePath, records) {
  if (!records.length) return
  for (const record of records) await appendJsonl(filePath, record)
}

function validationRecordFromDailyMetric({ prediction, stock, metric, windowDays, priorWindowDays = [] }) {
  const direction = prediction.expectedMove === "bearish" ? "bearish" : "bullish"
  const verdict = verdictFromMarketMove({
    direction,
    periodReturnPct: metric?.pct20 ?? null,
    lastVolumeVsAvg: metric?.volumeRatio ?? null,
  })
  return {
    id: makeBrainRecordId("validation", `${prediction.id}:${stock.code}:${windowDays}`),
    type: "validation",
    kind: "market-validation",
    validationMethod: DAILY_LOOP_VALIDATION_METHOD,
    predictionId: prediction.id,
    stockCode: stock.code,
    stockName: stock.name,
    windowDays,
    predictionCreatedAt: prediction.createdAt ?? null,
    result: normalizeBrainResult(verdict.verdict),
    verdict: verdict.verdict,
    reason: verdict.reason,
    target: prediction.branch,
    targetType: "daily-discovery",
    marketValidation: {
      sourceId: "stock_daily_sql",
      status: metric?.status === "ok" ? "ready" : "insufficient",
      verdict: verdict.verdict,
      reason: verdict.reason,
      stockName: stock.name,
      stockCode: stock.code,
      lookbackDays: windowDays,
      rowCount: metric?.rows ?? 0,
      firstDate: metric?.startDate ?? null,
      lastDate: metric?.endDate ?? null,
      periodReturnPct: metric?.pct20 ?? null,
      amountRatio: metric?.amountRatio ?? null,
      volumeRatio: metric?.volumeRatio ?? null,
      avgTurnoverLast5: metric?.avgTurnoverLast5 ?? null,
      refs: metric?.refs ?? [metric?.sqlRef, metric?.externalRef].filter(Boolean),
      quoteValidation: metric?.marketValidation ?? null,
    },
    validationStartDate: metric?.startDate ?? null,
    validationEndDate: metric?.endDate ?? null,
    validationAnchor: prediction.createdAt
      ? {
          source: "prediction.createdAt",
          rule: "first_trading_day_after_prediction",
          predictionCreatedAt: prediction.createdAt,
        }
      : null,
    horizonTrackKey: `${prediction.id}:${stock.code}`,
    priorWindowDays,
    sqlRefs: metric?.refs ?? [metric?.sqlRef, metric?.externalRef].filter(Boolean),
    createdAt: nowLocalTimestamp(),
  }
}

async function validatePendingDailyPredictions(projectPath, options = {}) {
  const records = (await readBrainRecords(projectPath)).map((item) => item.value).filter((item) => item && typeof item === "object" && !Array.isArray(item))
  const predictions = records.filter((record) => record.type === "prediction" && record.status !== "closed")
  const existingKeys = new Set(
    records
      .filter((record) => record.type === "validation")
      .filter(isCurrentDailyValidationRecord)
      .map((record) => `${record.predictionId ?? ""}:${record.stockCode ?? ""}:${record.windowDays ?? ""}`),
  )
  const maxValidations = options.validatePendingOnly && options.maxExistingValidations == null
    ? predictions.length
    : parsePositiveInteger(options.maxExistingValidations, options.mode === "postclose" ? 4 : 2)
  const maxStocksPerPrediction = parsePositiveInteger(options.maxStocksPerQuestion, 8)
  const pending = predictions.slice(-maxValidations)
  const validationTasks = []
  for (const prediction of pending) {
    const stocks = Array.isArray(prediction.stocks) ? prediction.stocks.filter((stock) => stock?.code) : []
    const windows = parseDailyLoopWindows(options.validationWindows ?? prediction.validationWindows)
    const anchor = validationAnchorFromPrediction(prediction)
    for (const windowDays of windows) {
      const candidateStocks = stocks.slice(0, maxStocksPerPrediction)
      const toValidate = []
      for (const stock of candidateStocks) {
        if (existingKeys.has(`${prediction.id}:${stock.code}:${windowDays}`)) {
          if (options.validationStats) options.validationStats.existing += 1
        } else {
          toValidate.push(stock)
        }
      }
      if (toValidate.length === 0) continue
      if (options.validationStats) options.validationStats.attempted += toValidate.length
      const priorWindowDays = windows.filter((item) => item < windowDays)
      for (const stock of toValidate) validationTasks.push({ prediction, stock, windowDays, priorWindowDays, anchor })
    }
  }

  const validations = []
  const groupedTasks = new Map()
  for (const task of validationTasks) {
    const key = `${task.anchor?.date ?? ""}:${task.anchor?.exclusive ? "1" : "0"}:${task.windowDays}`
    if (!groupedTasks.has(key)) groupedTasks.set(key, [])
    groupedTasks.get(key).push(task)
  }

  for (const tasks of groupedTasks.values()) {
    const { anchor, windowDays } = tasks[0]
    const stocksForQuery = [...new Map(tasks.map((task) => [task.stock.code, task.stock])).values()]
    const metricResult = await fetchDailyLoopStockMetrics(stocksForQuery, {
        ...options,
        stockLookbackDays: windowDays,
        lookbackDays: windowDays,
        requiredRows: windowDays,
        validationAnchorDate: anchor?.date,
        validationAnchorExclusive: anchor?.exclusive,
    })
    const externalMarketResult = anchor
      ? { source: "off", status: "skipped", metrics: new Map(), okCount: 0, total: stocksForQuery.length, warning: "anchored validation uses SQL only" }
      : await fetchDailyLoopExternalMarketMetrics(stocksForQuery, { ...options, stockLookbackDays: windowDays, lookbackDays: windowDays })
    const marketMetrics = mergeDailyLoopMarketMetrics(stocksForQuery, metricResult.metrics, externalMarketResult.metrics)
    for (const task of tasks) {
      const metric = marketMetrics.get(task.stock.code) ?? metricResult.metrics.get(task.stock.code) ?? { status: metricResult.status, warning: metricResult.warning }
      if (metric.status === "not_due") {
        if (options.validationStats) options.validationStats.notDue += 1
        continue
      }
      validations.push(validationRecordFromDailyMetric({ prediction: task.prediction, stock: task.stock, metric, windowDays: task.windowDays, priorWindowDays: task.priorWindowDays }))
    }
  }
  return validations
}

function renderMetricLine(stock) {
  const metric = stock.metric ?? {}
  if (metric.status !== "ok") return `- ${stockLabel(stock)}：日线不足或 SQL 未返回；${stock.path ?? ""}`
  const validation = metric.marketValidation
  const validationText = validation ? `行情验证 ${validation.status}（${validation.reason}）` : "行情验证 NA"
  const refs = (metric.refs ?? [metric.sqlRef, metric.externalRef]).filter(Boolean).join(", ")
  return `- ${stockLabel(stock)}：近20日 ${metric.pct20 ?? "NA"}%，成交额比 ${metric.amountRatio ?? "NA"}x，换手 ${metric.avgTurnoverLast5 ?? "NA"}，${validationText}，${refs}`
}

function renderDailyLoopReport({ mode, runId, generatedAt, questions, answers, validations, selfTraining }) {
  const rows = [`# Daily Research ${mode}`, "", `- run_id: ${runId}`, `- generated_at: ${generatedAt}`, `- questions: ${questions.length}`, `- validations: ${validations.length}`, ""]
  rows.push("## Questions")
  for (const question of questions) {
    rows.push("", `### ${question.id} ${question.branch} / ${question.type}`, "", question.question, "", "#### Stocks")
    for (const stock of question.stocks) rows.push(renderMetricLine(stock))
    const answer = answers.get(question.id)
    if (answer) rows.push("", "#### Answer", "", String(answer).trim())
  }
  if (validations.length > 0) {
    rows.push("", "## Market Validations")
    for (const item of validations) {
      rows.push(`- ${item.stockName ?? item.stockCode} ${item.windowDays}d：${item.verdict}；${item.reason || ""}；${(item.sqlRefs ?? []).join(", ")}`)
    }
  }
  if (selfTraining) {
    rows.push("", "## Self-Training Dry Run", "", `- actions: ${selfTraining.actions.length}`)
    for (const action of selfTraining.actions.slice(0, 20)) rows.push(`- ${action.rule} ${action.target}: ${action.reason}`)
  }
  return `${rows.join("\n")}\n`
}

function renderDailyLoopWikiFeedback({ mode, runId, questions, validations, selfTraining }) {
  const rows = [`# Wiki Feedback ${nowLocalTimestamp().slice(0, 10)}`, "", `- run_id: ${runId}`, `- mode: ${mode}`, ""]
  rows.push("## Suggested Updates")
  for (const question of questions) {
    rows.push(`- ${question.branch}: review ${question.stocks.map((stock) => stock.path).filter(Boolean).slice(0, 6).join(", ") || "related stock pages"}`)
  }
  if (validations.length > 0) {
    rows.push("", "## Validation Signals")
    for (const validation of validations.slice(0, 30)) rows.push(`- ${validation.stockName ?? validation.stockCode}: ${validation.verdict} ${validation.reason ?? ""}`)
  }
  if (selfTraining?.actions?.length) {
    rows.push("", "## Self-Training Actions To Review")
    for (const action of selfTraining.actions.slice(0, 20)) rows.push(`- ${action.rule}: ${action.target} -> ${action.action}`)
  }
  rows.push("", "## Guardrail", "- This file is a review queue only. Do not apply wiki writes without a separate ingest/apply step.")
  return `${rows.join("\n")}\n`
}

export async function runDailyLoop(options = {}) {
  const projectPath = resolveProjectPath(options)
  const mode = parseDailyLoopMode(options.mode)
  const lookbackDays = parsePositiveInteger(options.lookbackDays, 30)
  const maxStocksPerQuestion = parsePositiveInteger(options.maxStocksPerQuestion, 8)
  const questionCount = parsePositiveInteger(options.questionCount, DAILY_LOOP_MODE_DEFAULT_COUNTS.get(mode) ?? 14)
  const validationWindows = parseDailyLoopWindows(options.validationWindows)
  const generatedAt = nowLocalTimestamp()
  const runId = `daily_loop_${generatedAt.slice(0, 10)}_${mode}_${shortHash(`${generatedAt}:${mode}`)}`

  if (options.validatePendingOnly) {
    const validationStats = { existing: 0, notDue: 0, attempted: 0 }
    const validations = mode === "postclose" || mode === "full" ? await validatePendingDailyPredictions(projectPath, { ...options, mode, validationWindows, maxStocksPerQuestion, validationStats }) : []
    const dryRun = !options.write
    let selfTraining = null
    let feedbackPath = null
    if (!dryRun) {
      await writeDailyLoopJsonl(path.join(brainDir(projectPath), brainFileForType("validation")), validations)
      selfTraining = mode === "postclose" || mode === "full" ? await runSelfTraining({ projectPath, write: false }) : null
      if (mode === "postclose" || mode === "full") {
        feedbackPath = path.join(projectPath, ".llm-wiki", "wiki-feedback", `${generatedAt.slice(0, 10)}.md`)
        await ensureDirectory(path.dirname(feedbackPath))
        await fs.writeFile(feedbackPath, renderDailyLoopWikiFeedback({ mode, runId, questions: [], validations, selfTraining }), "utf8")
      }
    } else {
      selfTraining = mode === "postclose" || mode === "full" ? await runSelfTraining({ projectPath, write: false }) : null
    }
    return {
      projectPath,
      mode,
      runId,
      generatedAt,
      dryRun,
      counts: {
        stockUniverse: 0,
        recentCorpus: 0,
        themes: 0,
        candidateStocks: 0,
        questions: 0,
        predictions: 0,
        validations: validations.length,
        validationsExisting: validationStats.existing,
        validationsNotDue: validationStats.notDue,
        validationsAttempted: validationStats.attempted,
      },
      themes: [],
      sql: {
        status: validations.length > 0 ? "ok" : "no_due_or_existing",
        warning: validations.length > 0 ? null : `没有写入新的 pending prediction 验证；已存在 ${validationStats.existing}，未到期 ${validationStats.notDue}`,
        nativeQuery: null,
      },
      marketValidation: {
        mode: "off",
        externalSource: "off",
        externalStatus: "skipped",
        externalOkCount: 0,
        externalTotal: 0,
        warning: "anchored pending validation uses stock SQL only",
      },
      questionPlanner: { status: "skipped", mode: "validate-pending-only", warning: null, plannedCount: 0 },
      questions: [],
      answers: {},
      predictions: [],
      validations,
      selfTraining,
      reportPath: null,
      reportRelativePath: null,
      feedbackPath,
      feedbackRelativePath: feedbackPath ? projectRelative(projectPath, feedbackPath) : null,
    }
  }

  const [stockUniverse, recentCorpus] = await Promise.all([loadDailyLoopStockUniverse(projectPath), loadDailyLoopRecentCorpus(projectPath, lookbackDays)])
  const themes = scoreDailyLoopThemes(recentCorpus)
  const stocksByTheme = selectDailyLoopThemeStocks(stockUniverse, themes, maxStocksPerQuestion)
  const allCandidateStocks = [...new Map([...stocksByTheme.values()].flat().map((stock) => [stock.code, stock])).values()]
  const metricResult = await fetchDailyLoopStockMetrics(allCandidateStocks, { ...options, lookbackDays: 20, stockLookbackDays: 20 })
  const externalMarketResult = await fetchDailyLoopExternalMarketMetrics(allCandidateStocks, { ...options, lookbackDays: 20, stockLookbackDays: 20 })
  const marketMetrics = mergeDailyLoopMarketMetrics(allCandidateStocks, metricResult.metrics, externalMarketResult.metrics)
  const planned = await planDailyLoopQuestions({
    mode,
    themes,
    stocksByTheme,
    metricsByCode: marketMetrics,
    questionCount,
    maxStocksPerQuestion,
    recentCorpus,
    projectPath,
    options,
  })
  const questions = planned.questions.map((question) => ({ ...question, validationWindows }))

  const answers = new Map()
  const shouldAnswer = options.answer !== false && !options.showContext
  if (shouldAnswer) {
    for (const question of questions) {
      const answer = await answerDailyLoopQuestion(question, { ...options, projectPath })
      answers.set(question.id, answer)
    }
  }

  const validations = mode === "postclose" || mode === "full" ? await validatePendingDailyPredictions(projectPath, { ...options, mode, validationWindows }) : []
  const selfTraining = mode === "postclose" || mode === "full" ? await runSelfTraining({ projectPath, write: false }) : null
  const predictions = questions.map((question) =>
    predictionRecordFromDailyQuestion({
      runId,
      mode,
      question,
      answer: answers.get(question.id),
      createdAt: generatedAt,
    }),
  )

  const dryRun = !options.write
  let reportPath = null
  let feedbackPath = null
  if (!dryRun) {
    await writeDailyLoopJsonl(path.join(brainDir(projectPath), brainFileForType("prediction")), predictions)
    await writeDailyLoopJsonl(path.join(brainDir(projectPath), brainFileForType("validation")), validations)
    reportPath = path.join(projectPath, ".llm-wiki", "daily-research", `${generatedAt.slice(0, 10)}-${mode}.md`)
    await ensureDirectory(path.dirname(reportPath))
    await fs.writeFile(reportPath, renderDailyLoopReport({ mode, runId, generatedAt, questions, answers, validations, selfTraining }), "utf8")
    if (mode === "postclose" || mode === "full") {
      feedbackPath = path.join(projectPath, ".llm-wiki", "wiki-feedback", `${generatedAt.slice(0, 10)}.md`)
      await ensureDirectory(path.dirname(feedbackPath))
      await fs.writeFile(feedbackPath, renderDailyLoopWikiFeedback({ mode, runId, questions, validations, selfTraining }), "utf8")
    }
  }

  return {
    projectPath,
    mode,
    runId,
    generatedAt,
    dryRun,
    counts: {
      stockUniverse: stockUniverse.length,
      recentCorpus: recentCorpus.length,
      themes: themes.length,
      candidateStocks: allCandidateStocks.length,
      questions: questions.length,
      predictions: predictions.length,
      validations: validations.length,
    },
    themes: themes.map(({ id, branch, score, matchedKeywords }) => ({ id, branch, score, matchedKeywords })),
    sql: {
      status: metricResult.status,
      warning: metricResult.warning,
      nativeQuery: metricResult.nativeQuery
        ? {
            language: metricResult.nativeQuery.language,
            summary: metricResult.nativeQuery.summary,
            table: metricResult.nativeQuery.table,
            limit: metricResult.nativeQuery.limit,
            tickerCount: metricResult.nativeQuery.normalizedCodes?.length ?? 0,
          }
        : null,
    },
    marketValidation: {
      mode: parseDailyLoopMarketValidateMode(options.marketValidate ?? options.marketValidation ?? options.externalMarket),
      externalSource: externalMarketResult.source,
      externalStatus: externalMarketResult.status,
      externalOkCount: externalMarketResult.okCount ?? 0,
      externalTotal: externalMarketResult.total ?? allCandidateStocks.length,
      warning: externalMarketResult.warning,
    },
    questionPlanner: planned.planner,
    questions,
    answers: Object.fromEntries([...answers.entries()].map(([id, answer]) => [id, summarizeAskAnswer(answer)])),
    predictions,
    validations,
    selfTraining,
    reportPath,
    reportRelativePath: reportPath ? projectRelative(projectPath, reportPath) : null,
    feedbackPath,
    feedbackRelativePath: feedbackPath ? projectRelative(projectPath, feedbackPath) : null,
  }
}

function sampleFromBrainRecord(record, kind) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null
  if (kind === "sft") {
    if (record.type === "correction") {
      return {
        kind,
        id: `sft_${record.id ?? shortHash(JSON.stringify(record))}`,
        input: record.badAnswer ? `修正这个回答：${record.badAnswer}` : record.text ?? record.title ?? "",
        output: record.goodAnswer ?? record.correction ?? record.lesson ?? record.text ?? "",
        sourceRecordId: record.id,
      }
    }
    if (record.type === "validation") {
      return {
        kind,
        id: `sft_${record.id ?? shortHash(JSON.stringify(record))}`,
        input: `验证交易假设：${record.prediction ?? record.text ?? record.title ?? ""}`,
        output: `${record.verdict ?? record.result ?? "待继续观察"}：${record.reason ?? ""}`.trim(),
        sourceRecordId: record.id,
      }
    }
  }
  if (kind === "preference") {
    const accepted = record.goodAnswer ?? record.accepted
    const rejected = record.badAnswer ?? record.rejected
    if (!accepted || !rejected) return null
    return {
      kind,
      id: `pref_${record.id ?? shortHash(JSON.stringify(record))}`,
      prompt: record.prompt ?? record.question ?? record.text ?? "交易知识库回答偏好",
      accepted,
      rejected,
      sourceRecordId: record.id,
    }
  }
  if (kind === "eval") {
    if (record.type !== "validation") return null
    return {
      kind,
      id: `eval_${record.id ?? shortHash(JSON.stringify(record))}`,
      question: `这条预测是否被市场验证：${record.prediction ?? record.text ?? record.title ?? ""}`,
      expected: record.verdict ?? record.result ?? "待继续观察",
      evidence: record.sqlRefs ?? record.marketValidation?.refs ?? [],
      sourceRecordId: record.id,
    }
  }
  return null
}

export async function exportTrainingSamples(options = {}) {
  const projectPath = resolveProjectPath(options)
  const kind = String(options.kind ?? "sft").trim().toLowerCase()
  if (!["sft", "preference", "eval"].includes(kind)) throw new Error("--kind must be sft, preference, or eval")
  const records = (await readBrainRecords(projectPath)).map((item) => item.value).filter((item) => item && typeof item === "object" && !Array.isArray(item))
  const samples = records.map((record) => sampleFromBrainRecord(record, kind)).filter(Boolean)
  const stamp = nowLocalTimestamp().slice(0, 10)
  const outputPath = path.join(projectPath, ".llm-wiki", "exports", "training", `${kind}-${stamp}.jsonl`)
  await ensureDirectory(path.dirname(outputPath))
  await fs.writeFile(outputPath, samples.map((sample) => JSON.stringify(sample)).join("\n") + (samples.length ? "\n" : ""), "utf8")
  return { projectPath, kind, outputPath, relativePath: projectRelative(projectPath, outputPath), count: samples.length, samples }
}

function ensureGraphNodeEdgeMaps(node) {
  if (!node.outLinks) node.outLinks = new Set()
  if (!node.inLinks) node.inLinks = new Set()
  if (!node.outEdgeTypes) node.outEdgeTypes = new Map()
  if (!node.inEdgeTypes) node.inEdgeTypes = new Map()
}

function addAskGraphEdge(nodes, sourceId, targetId, type = "link") {
  const source = nodes.get(sourceId)
  const target = nodes.get(targetId)
  if (!source || !target || sourceId === targetId) return
  ensureGraphNodeEdgeMaps(source)
  ensureGraphNodeEdgeMaps(target)
  source.outLinks.add(targetId)
  target.inLinks.add(sourceId)
  if (!source.outEdgeTypes.has(targetId)) source.outEdgeTypes.set(targetId, new Set())
  if (!target.inEdgeTypes.has(sourceId)) target.inEdgeTypes.set(sourceId, new Set())
  source.outEdgeTypes.get(targetId).add(type || "link")
  target.inEdgeTypes.get(sourceId).add(type || "link")
}

async function buildAskGraphFromGraphJson(projectPath) {
  const graphPath = path.join(projectPath, ".llm-wiki", "graph.json")
  const raw = await readIfExists(graphPath)
  if (!raw.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
  const nodes = new Map()
  for (const rawNode of parsed.nodes) {
    const id = String(rawNode.id ?? wikiRelativePathToNodeId(rawNode.path ?? "") ?? "").trim()
    if (!id) continue
    const relativePath = rawNode.path ? toPosixPath(String(rawNode.path)) : `wiki/${id}.md`
    const node = {
      id,
      path: relativePath,
      title: String(rawNode.label ?? rawNode.title ?? pathToTitle(relativePath)),
      type: normalizeTypeAlias(rawNode.type) ?? rawNode.type ?? inferTypeFromPath(relativePath),
      sources: Array.isArray(rawNode.sources) ? rawNode.sources.map((item) => String(item)).filter((item) => !isWeakSourceReference(item)) : [],
      rawLinks: [],
      outLinks: new Set(),
      inLinks: new Set(),
      outEdgeTypes: new Map(),
      inEdgeTypes: new Map(),
    }
    nodes.set(id, node)
  }
  for (const edge of parsed.edges) {
    const source = String(edge.source ?? "").trim()
    const target = String(edge.target ?? "").trim()
    addAskGraphEdge(nodes, source, target, String(edge.type ?? "link"))
  }
  return { nodes, graphSource: ".llm-wiki/graph.json" }
}

async function buildAskGraphFromWiki(projectPath) {
  const pp = normalizePath(projectPath)
  const files = await listFilesRecursive(path.join(pp, "wiki"), {
    extensions: new Set([".md"]),
    excludeDirNames: new Set([".git", ".conflicts", "scripts"]),
  })
  const nodes = new Map()
  const basenameIndex = new Map()

  for (const filePath of files) {
    const relativePath = projectRelative(pp, filePath)
    const id = wikiRelativePathToNodeId(relativePath)
    if (!id) continue
    const content = await readIfExists(filePath)
    if (!content.trim()) continue
    const { fm } = parseFrontmatter(content)
    const sources = Array.isArray(fm.sources) ? fm.sources.map((item) => String(item).trim()).filter((item) => !isWeakSourceReference(item)) : []
    const relatedLinks = Array.isArray(fm.related) ? fm.related.map((item) => normalizeWikilinkTarget(item)).filter(Boolean) : []
    const node = {
      id,
      path: relativePath,
      title: extractTitle(content, filePath),
      type: normalizeTypeAlias(fm.type) ?? inferTypeFromPath(relativePath),
      sources,
      rawLinks: [...new Set([...relatedLinks, ...extractWikilinkTargets(content)])],
      outLinks: new Set(),
      inLinks: new Set(),
      outEdgeTypes: new Map(),
      inEdgeTypes: new Map(),
    }
    nodes.set(id, node)
    const basename = id.includes("/") ? id.split("/").pop() : id
    if (!basenameIndex.has(basename)) basenameIndex.set(basename, [])
    basenameIndex.get(basename).push(id)
  }

  const nodeIds = new Set(nodes.keys())
  for (const node of nodes.values()) {
    for (const rawLink of node.rawLinks) {
      const target = resolveGraphTarget(rawLink, nodeIds, basenameIndex)
      if (!target || target === node.id) continue
      addAskGraphEdge(nodes, node.id, target, "wikilink")
    }
  }

  return { nodes, graphSource: "wiki-wikilinks" }
}

async function buildAskGraph(projectPath) {
  const [graphJson, wikiGraph] = await Promise.all([
    buildAskGraphFromGraphJson(projectPath),
    buildAskGraphFromWiki(projectPath),
  ])
  if (!graphJson) return wikiGraph
  if (!wikiGraph) return graphJson
  return mergeAskGraphs(graphJson, wikiGraph)
}

function mergeEdgeTypeMap(target, source) {
  for (const [id, types] of source ?? []) {
    if (!target.has(id)) target.set(id, new Set())
    for (const type of types) target.get(id).add(type)
  }
}

function mergeAskGraphs(base, overlay) {
  for (const [id, overlayNode] of overlay.nodes) {
    const node = base.nodes.get(id)
    if (!node) {
      base.nodes.set(id, overlayNode)
      continue
    }
    node.path = node.path || overlayNode.path
    node.title = overlayNode.title || node.title
    node.type = normalizeTypeAlias(node.type) ?? normalizeTypeAlias(overlayNode.type) ?? overlayNode.type ?? node.type
    node.sources = [...new Set([...(node.sources ?? []), ...(overlayNode.sources ?? [])])]
    node.rawLinks = [...new Set([...(node.rawLinks ?? []), ...(overlayNode.rawLinks ?? [])])]
    ensureGraphNodeEdgeMaps(node)
    ensureGraphNodeEdgeMaps(overlayNode)
    for (const out of overlayNode.outLinks ?? []) node.outLinks.add(out)
    for (const incoming of overlayNode.inLinks ?? []) node.inLinks.add(incoming)
    mergeEdgeTypeMap(node.outEdgeTypes, overlayNode.outEdgeTypes)
    mergeEdgeTypeMap(node.inEdgeTypes, overlayNode.inEdgeTypes)
  }
  return { nodes: base.nodes, graphSource: `${base.graphSource}+${overlay.graphSource}` }
}

const ASK_MULTI_HOP_QUERY_REGEX =
  /产业链|上下游|传导|受益方向|受益|关联|关系|链路|链条|图谱|扩展|扩散|映射|供应链|供应商|客户|配套|生态|间接/

function resolveAskGraphDepth(query, rawDepth) {
  const text = String(rawDepth ?? "").trim().toLowerCase()
  if (!text || text === "auto") return ASK_MULTI_HOP_QUERY_REGEX.test(query) ? 2 : ASK_DEFAULT_GRAPH_DEPTH
  const parsed = Number.parseInt(text, 10)
  if (!Number.isFinite(parsed)) return ASK_DEFAULT_GRAPH_DEPTH
  return Math.max(0, Math.min(parsed, ASK_MAX_GRAPH_DEPTH))
}

function graphNodeDegree(node) {
  return (node?.outLinks?.size ?? 0) + (node?.inLinks?.size ?? 0)
}

function graphHopDecay(hop) {
  if (hop <= 1) return 1
  return 0.45 ** (hop - 1)
}

function graphNodeRelevanceScore(node, tokens) {
  if (!node) return 0
  const text = [
    node.title,
    node.path,
    node.type,
    ...(node.sources ?? []),
  ].filter(Boolean).join(" ")
  return tokenMatchScore(text, tokens) + topicCoverageBonus(text, tokens)
}

function shouldKeepGraphHop(node, tokens, hop) {
  if (hop <= 1) return true
  if (!node || isReservedWikiPath(node.path) || node.path.startsWith("wiki/sources/")) return false
  return graphNodeRelevanceScore(node, tokens) > 0
}

async function expandAskGraph(projectPath, wikiResults, options = {}) {
  const limit = parsePositiveInteger(options.graphNeighbors, ASK_DEFAULT_GRAPH_NEIGHBORS)
  const graphDepth = resolveAskGraphDepth(options.query ?? "", options.graphDepth)
  if (limit <= 0 || graphDepth <= 0 || wikiResults.length === 0) return []
  const graph = await buildAskGraph(projectPath)
  const selectedPaths = new Set(wikiResults.map((item) => item.path))
  const expansions = new Map()

  function addExpansion({ id, score, reason, from, hop = 1, pathTrace = [], relationType = "link" }) {
    const node = graph.nodes.get(id)
    if (!node || selectedPaths.has(node.path) || isReservedWikiPath(node.path) || node.path.startsWith("wiki/sources/")) return
    const existing = expansions.get(node.path) ?? {
      path: node.path,
      title: node.title,
      type: node.type,
      score: 0,
      graphScore: 0,
      reasons: [],
      from: [],
      hop,
      pathTrace,
      relationType,
      snippet: "",
    }
    existing.graphScore += score
    existing.score = Math.max(existing.score, score)
    if (hop < (existing.hop ?? Number.POSITIVE_INFINITY)) {
      existing.hop = hop
      existing.pathTrace = pathTrace
      existing.relationType = relationType
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
    if (!existing.from.includes(from)) existing.from.push(from)
    expansions.set(node.path, existing)
  }

  for (const result of wikiResults) {
    const sourceId = wikiRelativePathToNodeId(result.path)
    const sourceNode = sourceId ? graph.nodes.get(sourceId) : null
    if (!sourceNode) continue

    const visited = new Set([sourceNode.id])
    let frontier = [{ node: sourceNode, hop: 0, pathTrace: [result.path] }]
    while (frontier.length > 0) {
      const nextFrontier = []
      for (const current of frontier) {
        if (current.hop >= graphDepth) continue
        if (current.hop >= 1 && graphNodeDegree(current.node) > 40) continue
        const nextHop = current.hop + 1
        const edges = [
          ...[...(current.node.outLinks ?? [])].map((id) => ({
            id,
            direction: "out",
            edgeTypes: [...(current.node.outEdgeTypes?.get(id) ?? ["link"])],
            baseScore: 8 + result.score * 0.05,
          })),
          ...[...(current.node.inLinks ?? [])].map((id) => ({
            id,
            direction: "in",
            edgeTypes: [...(current.node.inEdgeTypes?.get(id) ?? ["link"])],
            baseScore: 7 + result.score * 0.04,
          })),
        ]

        for (const edge of edges) {
          const targetNode = graph.nodes.get(edge.id)
          if (!targetNode || visited.has(edge.id) || targetNode.id === sourceNode.id || selectedPaths.has(targetNode.path)) continue
          if (!shouldKeepGraphHop(targetNode, options.tokens ?? [], nextHop)) continue
          visited.add(edge.id)
          const score = edge.baseScore * graphHopDecay(nextHop) + (nextHop > 1 ? Math.min(4, graphNodeRelevanceScore(targetNode, options.tokens ?? []) * 0.35) : 0)
          const pathTrace = [...current.pathTrace, targetNode.path]
          const relation = edge.direction === "out"
            ? `linked from ${current.node.path} (${edge.edgeTypes.join("/")})`
            : `links to ${current.node.path} (${edge.edgeTypes.join("/")})`
          addExpansion({
            id: edge.id,
            score,
            reason: nextHop === 1 ? relation : `hop ${nextHop} via ${current.node.path}: ${relation}`,
            from: result.path,
            hop: nextHop,
            pathTrace,
            relationType: edge.direction === "out" ? "out-link" : "in-link",
          })
          if (nextHop < graphDepth) nextFrontier.push({ node: targetNode, hop: nextHop, pathTrace })
        }
      }
      frontier = nextFrontier
    }

    if (sourceNode.sources.length > 0) {
      const sourceSet = new Set(sourceNode.sources)
      for (const node of graph.nodes.values()) {
        if (node.id === sourceNode.id || isReservedWikiPath(node.path)) continue
        const shared = node.sources.filter((source) => sourceSet.has(source))
        if (shared.length === 0) continue
        addExpansion({
          id: node.id,
          score: 4 + shared.length * 2 + result.score * 0.02,
          reason: `shared source: ${shared.slice(0, 3).join(", ")}`,
          from: result.path,
          hop: 1,
          pathTrace: [result.path, node.path],
          relationType: "shared-source",
        })
      }
    }
  }

  const items = [...expansions.values()]
    .sort((a, b) => b.graphScore - a.graphScore || a.path.localeCompare(b.path))
    .slice(0, limit)

  for (const item of items) {
    const content = await readIfExists(path.join(projectPath, item.path))
    item.snippet = buildSnippet(content, options.tokens ?? [], 220)
  }
  return items
}

async function addAskReferences(projectPath, items, prefix, tokens, maxChars) {
  const out = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const content = await readIfExists(path.join(projectPath, item.path))
    out.push({
      ...item,
      ref: `${prefix}${i + 1}`,
      excerpt: content ? buildEvidenceExcerpt(content, tokens, maxChars) : "",
    })
  }
  return out
}

function addPrebuiltAskReferences(items, prefix) {
  return items.map((item, i) => ({
    ...item,
    ref: `${prefix}${i + 1}`,
    excerpt: item.excerpt || item.snippet || "",
  }))
}

function formatAskSourceRoutingSection(context) {
  const rows = ["## Source Routing"]
  rows.push("", `- mode: ${context.sourceRouting.route.mode}`, `- source_k: ${context.sourceRouting.route.sourceK}`)
  if (context.sourceRouting.route.warnings.length > 0) {
    rows.push(`- warnings: ${context.sourceRouting.route.warnings.join(" | ")}`)
  }
  rows.push("")
  for (const source of context.sourceRouting.selectedSources) {
    rows.push(
      `- ${source.id}: ${source.available ? "available" : "unavailable"}; native=${source.nativeLanguage}; reason=${source.routeReason || "selected"}${
        source.unavailableReason ? `; unavailable_reason=${source.unavailableReason}` : ""
      }`,
    )
  }
  if (context.retrievalWarnings.length > 0) {
    rows.push("", "## Retrieval Warnings", "", ...context.retrievalWarnings.map((warning) => `- ${warning}`))
  }
  return rows.join("\n")
}

function formatAskNativeQueriesSection(nativeQueries) {
  if (nativeQueries.length === 0) return "## Native Queries\n\n- none"
  const rows = ["## Native Queries"]
  for (const query of nativeQueries) {
    rows.push("", `### ${query.sourceId}`, `- language: ${query.language}`, `- query: ${query.summary}`)
    if (query.status) rows.push(`- status: ${query.status}`)
  }
  return rows.join("\n")
}

function formatAskEvidenceSection(title, items) {
  if (items.length === 0) return `## ${title}\n\n- none`
  const rows = [`## ${title}`]
  for (const item of items) {
    rows.push(
      "",
      `### [${item.ref}] ${item.title} (${item.path})`,
      `- score: ${Math.round(item.score * 100) / 100}`,
      item.sourceId ? `- source: ${item.sourceId}` : "",
      item.type ? `- type: ${item.type}` : "",
      item.raw ? "- kind: raw" : "",
      item.nativeQuery ? `- native_query: ${item.nativeQuery}` : "",
      item.hop ? `- graph_hop: ${item.hop}` : "",
      item.pathTrace?.length ? `- path_trace: ${item.pathTrace.join(" -> ")}` : "",
      item.reasons?.length ? `- graph_reason: ${item.reasons.join("; ")}` : "",
      "",
      item.excerpt || item.snippet || "(no excerpt)",
    )
  }
  return rows.filter((line) => line !== "").join("\n")
}

function formatAskMarketValidationSection(marketValidation) {
  if (!marketValidation) return "## Market Validation\n\n- none"
  const rows = ["## Market Validation"]
  rows.push(
    "",
    `- source: ${marketValidation.sourceId}`,
    `- status: ${marketValidation.status}`,
    `- verdict: ${marketValidation.verdict}`,
    `- reason: ${marketValidation.reason ?? "none"}`,
  )
  if (marketValidation.stockName || marketValidation.stockCode) {
    rows.push(`- stock: ${[marketValidation.stockName, marketValidation.stockCode].filter(Boolean).join(" ")}`)
  }
  if (marketValidation.firstDate || marketValidation.lastDate) {
    rows.push(`- window: ${marketValidation.firstDate ?? "?"} -> ${marketValidation.lastDate ?? "?"}; rows=${marketValidation.rowCount}; lookbackDays=${marketValidation.lookbackDays ?? "unknown"}`)
  }
  if (marketValidation.periodReturnPct != null) rows.push(`- period_return_pct: ${marketValidation.periodReturnPct}`)
  if (marketValidation.firstClose != null || marketValidation.lastClose != null) {
    rows.push(`- close: first=${marketValidation.firstClose ?? "?"}; last=${marketValidation.lastClose ?? "?"}`)
  }
  if (marketValidation.lastVolumeVsAvg != null) {
    rows.push(`- volume: last=${marketValidation.lastVolume ?? "?"}; avg=${marketValidation.avgVolume ?? "?"}; last_vs_avg=${marketValidation.lastVolumeVsAvg}`)
  }
  if (marketValidation.lastAmount != null || marketValidation.avgAmount != null) {
    rows.push(`- amount: last=${marketValidation.lastAmount ?? "?"}; avg=${marketValidation.avgAmount ?? "?"}`)
  }
  if (marketValidation.refs?.length) rows.push(`- refs: ${marketValidation.refs.slice(0, 12).join(", ")}`)
  return rows.join("\n")
}

function buildAskPrompt(context) {
  return [
    "# Trading Wiki Ask Context",
    "",
    `question: ${context.query}`,
    `projectPath: ${context.projectPath}`,
    `generatedAt: ${context.generatedAt}`,
    `retrieval: wikiMatches=${context.counts.wikiMatches}, rawMatches=${context.counts.rawMatches}, factsMatches=${context.counts.factsMatches}, invalidatedFactsMatches=${context.counts.invalidatedFactsMatches}, brainMatches=${context.counts.brainMatches}, sqlRows=${context.counts.sqlRows}, wikiFiles=${context.counts.wikiFiles}, rawFiles=${context.counts.rawFiles}`,
    `tokens: ${context.tokens.slice(0, 80).join(", ")}`,
    "",
    "请基于下面提供的知识库上下文回答用户问题。不要假装看过未提供的材料；证据不足时明确写不足。",
    "回答固定使用这些章节：结论、证据链、分歧/反证、后续验证、交易含义、引用来源。",
    "每条关键判断都要标注来源编号，例如 [W1]、[R2]、[G1]、[F1]、[M1]、[S1]；引用来源章节列出编号与 wiki/raw/graph/facts/brain/sql 路径。",
    "Invalidated/Superseded Temporal Facts 只能作为历史版本、反证或矛盾来源，不能当作当前有效事实；如果与 [F] 当前事实冲突，要写入分歧/反证。",
    "Brain Memory 是长期纠错/偏好/验证记忆，只能作为先验和卫语句，不能替代当前证据；如果记忆与当前证据冲突，要写入分歧/反证。",
    "如果 Market Validation 有内容，只能把它当作只读市场验证摘要：有明确方向时可写验证通过/验证失败/待继续观察；没有明确方向时写待继续观察，不要把价格表现硬解释成基本面结论。",
    "",
    formatAskSourceRoutingSection(context),
    "",
    formatAskNativeQueriesSection(context.nativeQueries),
    "",
    formatAskEvidenceSection("Navigation Seeds", context.navigation),
    "",
    formatAskEvidenceSection("Wiki Hits", context.wikiResults),
    "",
    formatAskEvidenceSection("Raw Hits", context.rawResults),
    "",
    formatAskEvidenceSection("Graph Expansion", context.graphExpansions),
    "",
    formatAskEvidenceSection("Facts JSONL Hits", context.factsResults),
    "",
    formatAskEvidenceSection("Invalidated/Superseded Temporal Facts", context.invalidatedFactsResults),
    "",
    formatAskEvidenceSection("Brain Memory Hits", context.brainResults),
    "",
    formatAskMarketValidationSection(context.marketValidation),
    "",
    formatAskEvidenceSection("Stock Daily SQL Hits", context.stockDailyResults),
  ].join("\n")
}

function askInstructions() {
  return [
    "你是一个交易复盘知识库问答助手。",
    "你必须基于提供的 wiki/raw/graph/facts/sql 检索上下文回答，不能把常识或猜测伪装成知识库证据。",
    "输出必须包含且只包含这些 Markdown 章节：结论、证据链、分歧/反证、后续验证、交易含义、引用来源。",
    "每个重要结论都要带来源编号；如果某个问题在上下文中证据不足，要明确指出缺口和需要继续检索的方向。",
    "Graph Expansion 中 graph_hop>=2 的内容只能作为关系扩展线索，必须结合 wiki/raw/facts/sql 证据后才能写成较强结论。",
    "Invalidated/Superseded Temporal Facts 只能用于历史脉络、反证和矛盾解释，不能作为当前结论的主证据。",
    "Brain Memory 只代表长期记忆、用户纠错、偏好或卫语句；它能改变回答优先级，但不能单独证明市场事实。",
    "涉及股票日线验证时，优先使用 Market Validation 和 Stock Daily SQL Hits；不能把只读验证结果默认写入 wiki 或 facts。",
  ].join("\n")
}

export async function buildAskRetrievalContext(options = {}) {
  const query = String(options.query ?? "").trim()
  if (!query) throw new Error("Missing ask query")
  const projectPath = resolveProjectPath(options)
  const sourceRouting = await selectAskSources({ ...options, query, projectPath })
  const selectedSourceIds = new Set(sourceRouting.selectedSources.map((source) => source.id))
  const retrieved = await searchAskCandidates(projectPath, query, options)
  const wikiSeedsForGraph = retrieved.wikiResults
  const wikiCandidates = selectedSourceIds.has("wiki_pages") ? retrieved.wikiResults : []
  const rawCandidates = selectedSourceIds.has("raw_text") ? retrieved.rawResults : []
  const graphExpansions = selectedSourceIds.has("wiki_graph") ? await expandAskGraph(projectPath, wikiSeedsForGraph, {
    graphNeighbors: options.graphNeighbors,
    graphDepth: options.graphDepth,
    query,
    tokens: retrieved.tokens,
  }) : []
  const factsSearch = selectedSourceIds.has("facts_jsonl") ? await searchAskFactsSplit(projectPath, query, retrieved.tokens, options) : { active: [], invalidated: [] }
  const factsCandidates = factsSearch.active
  const invalidatedFactsCandidates = factsSearch.invalidated
  const brainCandidates = selectedSourceIds.has("brain_memory") ? await searchAskBrain(projectPath, query, retrieved.tokens, options) : []
  const stockDaily = selectedSourceIds.has("stock_daily_sql") ? await searchAskStockDaily(projectPath, query, options) : {
    status: "skipped",
    intent: null,
    descriptor: null,
    nativeQuery: null,
    results: [],
    warning: null,
  }

  const [navigation, wikiResults, rawResults, graphResults] = await Promise.all([
    addAskReferences(projectPath, retrieved.navigation, "N", retrieved.tokens, ASK_NAV_EXCERPT_CHARS),
    addAskReferences(projectPath, wikiCandidates, "W", retrieved.tokens, ASK_WIKI_EXCERPT_CHARS),
    addAskReferences(projectPath, rawCandidates, "R", retrieved.tokens, ASK_RAW_EXCERPT_CHARS),
    addAskReferences(projectPath, graphExpansions, "G", retrieved.tokens, ASK_GRAPH_EXCERPT_CHARS),
  ])
  const factsResults = addPrebuiltAskReferences(factsCandidates, "F")
  const invalidatedFactsResults = addPrebuiltAskReferences(invalidatedFactsCandidates, "FH")
  const brainResults = addPrebuiltAskReferences(brainCandidates, "M")
  const stockDailyResults = addPrebuiltAskReferences(stockDaily.results, "S")
  const marketValidation = buildStockDailyMarketValidation(stockDaily, query)
  const retrievalWarnings = [
    ...sourceRouting.route.warnings,
    stockDaily.warning,
  ].filter(Boolean)
  const nativeQueries = [
    selectedSourceIds.has("wiki_pages") ? { sourceId: "wiki_pages", language: "free-text", summary: query, status: "ok" } : null,
    selectedSourceIds.has("raw_text") ? { sourceId: "raw_text", language: "free-text", summary: query, status: "ok" } : null,
    selectedSourceIds.has("wiki_graph") ? { sourceId: "wiki_graph", language: "bounded graph traversal", summary: `seed wiki hits=${wikiSeedsForGraph.length}, graph_neighbors=${parsePositiveInteger(options.graphNeighbors, ASK_DEFAULT_GRAPH_NEIGHBORS)}, graph_depth=${resolveAskGraphDepth(query, options.graphDepth)}`, status: "ok" } : null,
    selectedSourceIds.has("facts_jsonl") ? { sourceId: "facts_jsonl", language: "JSONL token filter", summary: query, status: "ok" } : null,
    selectedSourceIds.has("brain_memory") ? { sourceId: "brain_memory", language: "JSONL memory filter", summary: query, status: "ok" } : null,
    selectedSourceIds.has("stock_daily_sql")
      ? {
          sourceId: "stock_daily_sql",
          language: "SQL",
          summary: stockDaily.nativeQuery?.summary ?? stockDaily.warning ?? "not executed",
          status: stockDaily.status,
        }
      : null,
  ].filter(Boolean)

  const context = {
    query,
    projectPath,
    generatedAt: nowLocalTimestamp(),
    retrievalMode: RETRIEVAL_MODES.ASK,
    tokens: retrieved.tokens,
    counts: {
      ...retrieved.counts,
      wikiMatches: wikiCandidates.length,
      rawMatches: rawCandidates.length,
      graphMatches: graphExpansions.length,
      factsMatches: factsCandidates.length,
      invalidatedFactsMatches: invalidatedFactsCandidates.length,
      brainMatches: brainCandidates.length,
      sqlRows: stockDaily.results.length,
    },
    sourceRouting,
    selectedSources: sourceRouting.selectedSources,
    nativeQueries,
    retrievalWarnings,
    navigation,
    wikiResults,
    rawResults,
    graphExpansions: graphResults,
    factsResults,
    invalidatedFactsResults,
    brainResults,
    stockDailyResults,
    stockDaily,
    marketValidation,
  }
  return { ...context, prompt: buildAskPrompt(context) }
}

export async function askWiki(options = {}) {
  const provider = options.provider ?? "codex"
  const context = await buildAskRetrievalContext({ ...options, provider })
  if (options.showContext) return { ...context, answer: null }

  if (provider === "codex") {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trading-wiki-ask-"))
    const outputPath = path.join(tmpDir, "answer.md")
    try {
      const answer = await requestCodexExecText({
        stage: "ask",
        prompt: context.prompt,
        instructions: askInstructions(),
        model: options.model,
        prepared: { projectPath: context.projectPath },
        outputPath,
        codexBin: options.codexBin,
        codexProfile: options.codexProfile,
        codexProfileV2: options.codexProfileV2,
        codexTimeoutMs: options.codexTimeoutMs,
      })
      return { ...context, answer }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  if (provider === "openai") {
    const apiKey = resolveOpenAiApiKey(options)
    const model = options.model ?? process.env.OPENAI_MODEL
    if (!apiKey) throw new Error("Missing OpenAI-compatible API key. Pass --api-key or set OPENAI_API_KEY / DEEPSEEK_API_KEY, or use --provider codex.")
    if (!model) throw new Error("Missing model. Pass --model or set OPENAI_MODEL.")
    const answer = await requestOpenAiProviderText({
      apiKey,
      endpoint: options.endpoint,
      apiMode: options.apiMode,
      model,
      prompt: context.prompt,
      instructions: askInstructions(),
      reasoningEffort: options.reasoningEffort ?? "medium",
    })
    return { ...context, answer }
  }

  throw new Error(`Unsupported ask provider: ${provider}`)
}

function normalizeEvalList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return String(value ?? "")
    .split(/[,，\n|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeEvalPath(value) {
  return toPosixPath(String(value ?? ""))
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.md$/i, ".md")
}

function askEvalPathMatches(actual, expected) {
  const a = normalizeEvalPath(actual)
  const e = normalizeEvalPath(expected)
  if (!a || !e) return false
  if (a === e) return true
  const noExtA = a.replace(/\.md$/i, "")
  const noExtE = e.replace(/\.md$/i, "")
  return noExtA === noExtE || a.endsWith(`/${e}`) || noExtA.endsWith(`/${noExtE}`)
}

function isNoisyRawPath(relativePath) {
  return /(?:^|\/)raw\/(?:微信聊天|openclaw数据)(?:\/|$)/.test(toPosixPath(relativePath))
}

function clampScore(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function evaluateAskRetrievalCase(context, expectations = {}) {
  const expectedPaths = normalizeEvalList(expectations.expectedPaths ?? expectations.expectPaths ?? expectations.expect)
  const hits = [
    ...context.wikiResults.map((item) => ({ ...item, bucket: "wiki" })),
    ...context.rawResults.map((item) => ({ ...item, bucket: "raw" })),
    ...context.graphExpansions.map((item) => ({ ...item, bucket: "graph" })),
    ...context.factsResults.map((item) => ({ ...item, bucket: "facts" })),
    ...context.brainResults.map((item) => ({ ...item, bucket: "brain" })),
    ...context.stockDailyResults.map((item) => ({ ...item, bucket: "stock_daily" })),
  ]
  const matchedExpectedPaths = expectedPaths.filter((expected) => hits.some((hit) => askEvalPathMatches(hit.path, expected)))
  const recallScore = expectedPaths.length > 0 ? clampScore((matchedExpectedPaths.length / expectedPaths.length) * 100) : null

  const topHits = hits.slice(0, 10)
  const relevanceScore = topHits.length > 0
    ? clampScore((topHits.filter((hit) => hit.score > 0).length / topHits.length) * 100)
    : 0

  const selected = context.selectedSources.filter((source) => source.available)
  const sourceHitCounts = {
    wiki_pages: context.wikiResults.length,
    raw_text: context.rawResults.length,
    wiki_graph: context.graphExpansions.length,
    facts_jsonl: context.factsResults.length,
    brain_memory: context.brainResults.length,
    stock_daily_sql: context.stockDailyResults.length,
  }
  const evidenceCoverageScore = selected.length > 0
    ? clampScore((selected.filter((source) => (sourceHitCounts[source.id] ?? 0) > 0).length / selected.length) * 100)
    : 0

  const rawNoiseRate = context.rawResults.length > 0
    ? context.rawResults.filter((item) => isNoisyRawPath(item.path) && !item.structuredSourceMatch?.length).length / context.rawResults.length
    : 0
  const rawNoiseScore = clampScore((1 - rawNoiseRate) * 100)

  const structuredWikiHits = context.wikiResults.filter((item) => {
    const matches = item.frontmatterMatches ?? []
    return matches.length > 0 || item.frontmatterMatch || item.frontmatterSources?.length || item.frontmatterRelated?.length || item.frontmatterTags?.length
  })
  const structureFieldCoverageScore = context.wikiResults.length > 0
    ? clampScore((structuredWikiHits.length / context.wikiResults.length) * 100)
    : 0

  const recallComponent = recallScore == null ? relevanceScore : recallScore
  const overallScore = clampScore(
    recallComponent * 0.35 +
      relevanceScore * 0.2 +
      evidenceCoverageScore * 0.2 +
      structureFieldCoverageScore * 0.15 +
      rawNoiseScore * 0.1,
  )

  return {
    expectedPaths,
    matchedExpectedPaths,
    missedExpectedPaths: expectedPaths.filter((expected) => !matchedExpectedPaths.includes(expected)),
    topHits: hits.slice(0, 12).map(({ bucket, path, title, score }) => ({ bucket, path, title, score })),
    sourceHitCounts,
    metrics: {
      recall: recallScore,
      relevance: relevanceScore,
      evidenceCoverage: evidenceCoverageScore,
      rawNoise: rawNoiseScore,
      structureFieldCoverage: structureFieldCoverageScore,
      overall: overallScore,
    },
  }
}

function normalizeAskEvalCases(options) {
  if (Array.isArray(options.cases) && options.cases.length > 0) return options.cases
  return [
    {
      id: "default",
      query:
        options.query ??
        "最近一个月物理AI/具身智能/机器人方向，A股投资应该优先看哪些产业链环节和标的？请区分已有知识库反复验证的证据、仍偏叙事的环节，以及交易上要验证的量价/订单/客户节点。",
      expectedPaths: options.expectedPaths ?? options.expectPaths ?? options.expect,
    },
  ]
}

export async function runAskEval(options = {}) {
  const projectPath = resolveProjectPath(options)
  const cases = []
  for (const [index, rawCase] of normalizeAskEvalCases(options).entries()) {
    const query = String(rawCase.query ?? "").trim()
    if (!query) throw new Error("Ask eval case is missing query")
    const context = await buildAskRetrievalContext({
      ...options,
      ...rawCase,
      projectPath,
      query,
      provider: options.provider ?? "codex",
      showContext: true,
    })
    const evaluation = evaluateAskRetrievalCase(context, rawCase)
    cases.push({
      id: rawCase.id ?? `case-${index + 1}`,
      query,
      retrievalMode: context.retrievalMode,
      selectedSources: context.selectedSources.map((source) => source.id),
      counts: context.counts,
      ...evaluation,
    })
  }

  const aggregate = {
    cases: cases.length,
    recall: clampScore(cases.reduce((sum, item) => sum + (item.metrics.recall ?? item.metrics.relevance), 0) / Math.max(1, cases.length)),
    relevance: clampScore(cases.reduce((sum, item) => sum + item.metrics.relevance, 0) / Math.max(1, cases.length)),
    evidenceCoverage: clampScore(cases.reduce((sum, item) => sum + item.metrics.evidenceCoverage, 0) / Math.max(1, cases.length)),
    rawNoise: clampScore(cases.reduce((sum, item) => sum + item.metrics.rawNoise, 0) / Math.max(1, cases.length)),
    structureFieldCoverage: clampScore(cases.reduce((sum, item) => sum + item.metrics.structureFieldCoverage, 0) / Math.max(1, cases.length)),
    overall: clampScore(cases.reduce((sum, item) => sum + item.metrics.overall, 0) / Math.max(1, cases.length)),
  }

  const result = {
    mode: "ask-eval",
    generatedAt: nowLocalTimestamp(),
    projectPath,
    retrievalMode: RETRIEVAL_MODES.ASK,
    aggregate,
    cases,
  }

  if (options.write) {
    const fileStamp = result.generatedAt.replace(/[-: ]/g, "").slice(0, 14)
    const outputPath = path.join(projectPath, ".llm-wiki", "eval", `ask-eval-${fileStamp}.json`)
    await writeJson(outputPath, result)
    return { ...result, outputPath, relativePath: projectRelative(projectPath, outputPath) }
  }

  return result
}

function sanitizeArtifactName(value) {
  return String(value ?? "artifact")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "artifact"
}

function dateCompact(value) {
  const parsed = String(value ?? "").match(/\d{4}-?\d{2}-?\d{2}/)?.[0]
  if (!parsed) return ""
  return parsed.replace(/-/g, "")
}

function yearFromDateLike(value, fallback = new Date().getFullYear()) {
  const compact = dateCompact(value)
  const year = Number(compact.slice(0, 4))
  return Number.isFinite(year) && year > 1900 ? year : fallback
}

function companyFinancialStartDate(options = {}) {
  const explicit = dateCompact(options.financialFrom ?? options["financial-from"])
  if (explicit) return explicit
  const endYear = yearFromDateLike(options.financialTo ?? options.to ?? nowLocalTimestamp())
  return `${Math.max(1990, endYear - 5)}0101`
}

function companyPeriodicAnnouncementStartDate(options = {}) {
  const explicit = String(options.cninfoPeriodicFrom ?? options["cninfo-periodic-from"] ?? "").trim()
  if (explicit) return explicit
  const endYear = yearFromDateLike(options.to ?? nowLocalTimestamp())
  return `${Math.max(1990, endYear - 1)}-01-01`
}

function companyEventAnnouncementStartDate(options = {}) {
  const explicit = String(options.cninfoEventFrom ?? options["cninfo-event-from"] ?? "").trim()
  if (explicit) return explicit
  const endYear = yearFromDateLike(options.to ?? nowLocalTimestamp())
  return `${Math.max(1990, endYear - 3)}-01-01`
}

function parseDateMs(value) {
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return n
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function localDateFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function companyResearchReportId(company, options = {}) {
  if (options.reportId) return sanitizeArtifactName(options.reportId)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const stock = company.stockCode ?? company.tsCode ?? company.stockInput ?? "company"
  return `${stamp}-${sanitizeArtifactName(stock)}`
}

function ensureCompanyResearchRelative(projectPath, targetPath) {
  const relativePath = projectRelative(projectPath, targetPath)
  if (relativePath !== COMPANY_RESEARCH_ROOT && !relativePath.startsWith(`${COMPANY_RESEARCH_ROOT}/`)) {
    throw new Error(`Refusing company-research write outside ${COMPANY_RESEARCH_ROOT}: ${relativePath}`)
  }
  return relativePath
}

function readCompanySecretFromKeychain({ service, account, env = process.env, options = {} }) {
  if (options.disableKeychain || env.TRADING_WIKI_DISABLE_COMPANY_KEYCHAIN === "1") return null
  if (env.VITEST || env.NODE_ENV === "test") return null
  if (!service || !account) return null
  try {
    const output = execFileSync(
      "security",
      ["find-generic-password", "-s", String(service), "-a", String(account), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500 },
    )
    const secret = output.trim()
    return secret || null
  } catch {
    return null
  }
}

function getCompanyResearchCredentials(options = {}, env = process.env) {
  const tushareToken =
    options.tushareToken ??
    env.TUSHARE_TOKEN ??
    readCompanySecretFromKeychain({
      service: options.tushareKeychainService ?? env.TRADING_WIKI_TUSHARE_KEYCHAIN_SERVICE ?? COMPANY_TUSHARE_KEYCHAIN_SERVICE,
      account: options.tushareKeychainAccount ?? env.TRADING_WIKI_TUSHARE_KEYCHAIN_ACCOUNT ?? COMPANY_TUSHARE_KEYCHAIN_ACCOUNT,
      env,
      options,
    })
  const tavilyApiKey =
    options.tavilyApiKey ??
    env.TAVILY_API_KEY ??
    readCompanySecretFromKeychain({
      service: options.tavilyKeychainService ?? env.TRADING_WIKI_TAVILY_KEYCHAIN_SERVICE ?? COMPANY_TAVILY_KEYCHAIN_SERVICE,
      account: options.tavilyKeychainAccount ?? env.TRADING_WIKI_TAVILY_KEYCHAIN_ACCOUNT ?? COMPANY_TAVILY_KEYCHAIN_ACCOUNT,
      env,
      options,
    })
  return {
    tushareToken,
    tavilyApiKey,
    status: {
      tushare: { configured: Boolean(tushareToken), auth: options.tushareToken || env.TUSHARE_TOKEN ? "env_or_option" : tushareToken ? "keychain" : "missing" },
      tavily: { configured: Boolean(tavilyApiKey), auth: options.tavilyApiKey || env.TAVILY_API_KEY ? "env_or_option" : tavilyApiKey ? "keychain" : "missing" },
    },
  }
}

function toTushareCode(value) {
  const normalized = normalizeStockCode(value)
  if (!normalized) return null
  return `${normalized.slice(2)}.${normalized.slice(0, 2)}`
}

function digitsFromStockCode(value) {
  const normalized = normalizeStockCode(value)
  if (normalized) return normalized.slice(2)
  const match = String(value ?? "").match(/\b(\d{6})\b/)
  return match?.[1] ?? null
}

function normalizeTushareResponse(apiName, response) {
  if (!response || typeof response !== "object") {
    return { apiName, status: "failed", error: "empty response", fields: [], rows: [] }
  }
  if (Number(response.code ?? 0) !== 0) {
    return { apiName, status: "failed", error: response.msg ?? `tushare code ${response.code}`, fields: [], rows: [] }
  }
  const fields = Array.isArray(response.data?.fields) ? response.data.fields.map(String) : []
  const items = Array.isArray(response.data?.items) ? response.data.items : []
  const rows = items.map((item) => Object.fromEntries(fields.map((field, index) => [field, Array.isArray(item) ? item[index] : undefined])))
  return { apiName, status: "success", error: null, fields, rows }
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), parsePositiveInteger(options.timeoutMs, 15000))
  try {
    const response = await fetch(url, { ...options.fetchOptions, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchTextWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), parsePositiveInteger(options.timeoutMs, 15000))
  try {
    const response = await fetch(url, { ...options.fetchOptions, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchBufferWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), parsePositiveInteger(options.timeoutMs, 20000))
  try {
    const response = await fetch(url, { ...options.fetchOptions, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString("latin1") === "%PDF-"
}

function extractAcwScV2Cookie(html) {
  const source = String(html ?? "")
  if (!/acw_sc__v2|arg1/.test(source)) return null
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? source
  const cookies = []
  const document = {}
  Object.defineProperty(document, "cookie", {
    get() {
      return cookies.join("; ")
    },
    set(value) {
      cookies.push(String(value))
    },
  })
  const location = {
    host: "static.sse.com.cn",
    hostname: "static.sse.com.cn",
    protocol: "https:",
    reload() {},
    replace() {},
    assign() {},
    set href(_value) {},
    get href() {
      return ""
    },
  }
  const sandbox = {
    window: null,
    self: null,
    document,
    location,
    navigator: { userAgent: "Mozilla/5.0" },
    atob(value) {
      return Buffer.from(String(value), "base64").toString("binary")
    },
    btoa(value) {
      return Buffer.from(String(value), "binary").toString("base64")
    },
    setTimeout(callback) {
      if (typeof callback === "function") callback()
      return 0
    },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    RegExp,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  try {
    vm.runInNewContext(script, sandbox, { timeout: 1000 })
  } catch {
    const cookie = cookies.find((item) => /acw_sc__v2=/.test(item))
    return cookie ? cookie.split(";")[0] : null
  }
  const cookie = cookies.find((item) => /acw_sc__v2=/.test(item))
  return cookie ? cookie.split(";")[0] : null
}

async function fetchPdfBufferWithTimeout(url, options = {}) {
  const first = await fetchBufferWithTimeout(url, options)
  if (isPdfBuffer(first)) return first
  const text = first.toString("utf8")
  const cookie = extractAcwScV2Cookie(text)
  if (cookie) {
    const retryHeaders = {
      ...(options.fetchOptions?.headers ?? {}),
      Cookie: [options.fetchOptions?.headers?.Cookie, cookie].filter(Boolean).join("; "),
    }
    const retry = await fetchBufferWithTimeout(url, {
      ...options,
      fetchOptions: {
        ...(options.fetchOptions ?? {}),
        headers: retryHeaders,
      },
    })
    if (isPdfBuffer(retry)) return retry
  }
  const preview = text.replace(/\s+/g, " ").slice(0, 80)
  throw new Error(`Downloaded file is not a PDF${preview ? `: ${preview}` : ""}`)
}

async function defaultTushareClient({ apiName, token, params = {}, fields = "", timeoutMs }) {
  if (!token) throw new Error("Tushare token is not configured")
  return fetchJsonWithTimeout("http://api.tushare.pro", {
    timeoutMs,
    fetchOptions: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_name: apiName, token, params, fields }),
    },
  })
}

function inferCninfoAnnouncementType(title) {
  const text = String(title ?? "").replace(/<[^>]+>/g, "")
  if (/半年度报告(?!摘要)|半年报全文/.test(text)) return "semiannual_report"
  if (/年度报告(?!摘要)|年报全文|年度报告全文/.test(text)) return "annual_report"
  if (/季度报告|一季报|三季报/.test(text)) return "quarterly_report"
  if (/管理制度|利润分配|现金分红|提前赎回.*转债|转债.*提示性公告/.test(text)) return "announcement"
  if (/投资者关系|调研|业绩说明会|互动易|路演/.test(text)) return "investor_relations"
  if (/重大|收购|预案|发行|并购|重组|定增|股权激励|可转债|回购|异常波动|资产/.test(text)) return "event"
  return "announcement"
}

function normalizeCninfoAnnouncement(raw) {
  const ms = parseDateMs(raw.announcementTime)
  const cleanTitle = String(raw.announcementTitle ?? raw.shortTitle ?? raw.title ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const adjunctUrl = String(raw.adjunctUrl ?? "").trim()
  const downloadUrl = raw.downloadUrl ?? (adjunctUrl ? `https://static.cninfo.com.cn/${adjunctUrl.replace(/^\/+/, "")}` : null)
  return {
    id: String(raw.announcementId ?? raw.id ?? shortHash(JSON.stringify(raw))),
    secCode: String(raw.secCode ?? ""),
    secName: String(raw.secName ?? raw.tileSecName ?? "").replace(/<[^>]+>/g, ""),
    orgId: raw.orgId ? String(raw.orgId) : null,
    title: cleanTitle,
    date: raw.date ?? localDateFromMs(ms),
    announcementTime: ms || null,
    adjunctUrl,
    downloadUrl,
    adjunctType: raw.adjunctType ?? null,
    adjunctSize: raw.adjunctSize ?? null,
    type: raw.type ?? inferCninfoAnnouncementType(cleanTitle),
    source: raw.source ?? "cninfo_public_web",
  }
}

function dedupeAnnouncements(announcements) {
  const seen = new Set()
  const out = []
  for (const item of announcements) {
    const keys = [
      item.downloadUrl,
      item.adjunctUrl,
      item.id,
      `${item.secCode ?? ""}:${item.title ?? ""}:${item.date ?? ""}`,
    ].filter(Boolean)
    if (keys.some((key) => seen.has(key))) continue
    for (const key of keys) seen.add(key)
    out.push(item)
  }
  return out.sort((a, b) => (b.announcementTime ?? 0) - (a.announcementTime ?? 0) || a.title.localeCompare(b.title))
}

function parseJsonpPayload(text) {
  const body = String(text ?? "").trim()
  const match = body.match(/^[^(]*\(([\s\S]*)\)\s*;?$/)
  return JSON.parse(match ? match[1] : body)
}

function isShanghaiListedCompany(company) {
  const code = String(company?.stockCode ?? company?.tsCode ?? company?.stockInput ?? "").toUpperCase()
  return code.startsWith("SH") || code.endsWith(".SH") || /^6\d{5}$/.test(code)
}

function normalizeSseAnnouncement(raw, company) {
  const title = String(raw.TITLE ?? raw.title ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const date = String(raw.SSEDATE ?? raw.ADDDATE ?? raw.date ?? "").slice(0, 10)
  const urlPath = String(raw.URL ?? raw.url ?? "").trim()
  const downloadUrl = urlPath
    ? (urlPath.startsWith("http") ? urlPath : `https://static.sse.com.cn${urlPath.startsWith("/") ? "" : "/"}${urlPath}`)
    : null
  const secCode = String(raw.SECURITY_CODE ?? raw.SECURITY_CODE_A ?? raw.PRODUCTID ?? digitsFromStockCode(company?.stockCode) ?? "")
  const secName = String(raw.SECURITY_ABBR_A ?? raw.SECURITY_NAME_ABBR ?? raw.SECURITY_NAME ?? company?.stockName ?? company?.secName ?? "")
  return {
    id: `sse-${shortHash(`${secCode}:${title}:${date}:${urlPath}`)}`,
    secCode,
    secName,
    orgId: null,
    title,
    date,
    announcementTime: parseDateMs(date),
    adjunctUrl: urlPath,
    downloadUrl,
    adjunctType: "PDF",
    adjunctSize: null,
    type: inferCninfoAnnouncementType(title),
    source: "sse_public_web",
  }
}

async function defaultSseAnnouncementClient({ company, to, timeoutMs, options = {} }) {
  if (!isShanghaiListedCompany(company)) {
    return { status: "skipped", requests: [], announcements: [] }
  }
  const digits = digitsFromStockCode(company.stockCode ?? company.tsCode ?? company.stockInput)
  if (!digits) return { status: "skipped", requests: [], announcements: [] }
  const periodicFrom = companyPeriodicAnnouncementStartDate(options)
  const eventFrom = companyEventAnnouncementStartDate(options)
  const endDate = String(to ?? nowLocalTimestamp().slice(0, 10)).slice(0, 10)
  const eventKeywords = ["重大事项", "收购", "资产收购", "并购重组", "股权激励", "投资者关系"]
  const plans = [
    { key: "", purpose: "sse_periodic_lookback", from: periodicFrom, reportType2: "DQBG" },
    ...eventKeywords.map((key) => ({ key, purpose: "sse_event_lookback", from: eventFrom, reportType2: "ALL" })),
  ]
  const requests = []
  const announcements = []
  for (const plan of plans) {
    const url = new URL("https://query.sse.com.cn/security/stock/queryCompanyBulletin.do")
    url.searchParams.set("jsonCallBack", "jsonpCallback1")
    url.searchParams.set("isPagination", "true")
    url.searchParams.set("productId", digits)
    url.searchParams.set("keyWord", plan.key)
    url.searchParams.set("securityType", "0101,120100,020100,020200,120200")
    url.searchParams.set("reportType2", plan.reportType2)
    url.searchParams.set("reportType", "ALL")
    url.searchParams.set("beginDate", plan.from)
    url.searchParams.set("endDate", endDate)
    url.searchParams.set("pageHelp.pageSize", String(parsePositiveInteger(options.ssePageSize, 30)))
    url.searchParams.set("pageHelp.pageNo", "1")
    url.searchParams.set("pageHelp.beginPage", "1")
    url.searchParams.set("pageHelp.cacheSize", "1")
    url.searchParams.set("pageHelp.endPage", "1")
    requests.push({ key: plan.key || digits, purpose: plan.purpose, url: url.toString() })
    const text = await fetchTextWithTimeout(url, {
      timeoutMs: timeoutMs ?? options.sseTimeoutMs,
      fetchOptions: {
        headers: {
          Referer: "https://www.sse.com.cn/",
          "User-Agent": "Mozilla/5.0 trading-review-wiki-company-research",
        },
      },
    })
    const parsed = parseJsonpPayload(text)
    const rows = Array.isArray(parsed.result) ? parsed.result : []
    announcements.push(...rows.map((row) => normalizeSseAnnouncement(row, company)))
  }
  const filtered = announcements.filter((item) => !item.secCode || item.secCode === digits)
  return { status: "success", requests, announcements: dedupeAnnouncements(filtered) }
}

async function defaultCninfoClient({ company, from, to, timeoutMs, options = {} }) {
  const searchKeys = [
    company.stockName,
    company.secName,
    company.stockCode ? digitsFromStockCode(company.stockCode) : null,
    company.stockInput,
  ].filter(Boolean)
  const uniqueSearchKeys = [...new Set(searchKeys)]
  const periodicBase = company.stockName ?? company.secName ?? company.stockInput
  const periodicFrom = companyPeriodicAnnouncementStartDate(options)
  const eventFrom = companyEventAnnouncementStartDate(options)
  const searchPlans = uniqueSearchKeys.map((key) => ({ key, from, to, purpose: "event_window" }))
  if (periodicBase) {
    for (const suffix of ["年度报告", "半年度报告", "季度报告", "投资者关系"]) {
      searchPlans.push({ key: `${periodicBase} ${suffix}`, from: periodicFrom, to, purpose: "periodic_lookback" })
    }
    for (const suffix of ["重大事项", "收购", "资产收购", "并购重组", "预案", "股权转让"]) {
      searchPlans.push({ key: `${periodicBase} ${suffix}`, from: eventFrom, to, purpose: "event_lookback" })
    }
  }
  const announcements = []
  const requests = []
  for (const plan of searchPlans) {
    const url = new URL("https://www.cninfo.com.cn/new/fulltextSearch/full")
    url.searchParams.set("searchkey", plan.key)
    if (plan.from) url.searchParams.set("sdate", plan.from)
    if (plan.to) url.searchParams.set("edate", plan.to)
    url.searchParams.set("isfulltext", "false")
    url.searchParams.set("sortName", "pubdate")
    url.searchParams.set("sortType", "desc")
    url.searchParams.set("pageNum", "1")
    requests.push({ key: plan.key, purpose: plan.purpose, url: url.toString() })
    const parsed = await fetchJsonWithTimeout(url, {
      timeoutMs,
      fetchOptions: {
        headers: {
          Referer: "https://www.cninfo.com.cn/new/index",
          "User-Agent": "Mozilla/5.0 trading-review-wiki-company-research",
        },
      },
    })
    const rawAnnouncements = Array.isArray(parsed.announcements) ? parsed.announcements : []
    announcements.push(...rawAnnouncements.map(normalizeCninfoAnnouncement))
  }
  const digits = company.stockCode ? digitsFromStockCode(company.stockCode) : null
  const filtered = digits ? announcements.filter((item) => !item.secCode || item.secCode === digits) : announcements
  return { status: "success", requests, announcements: dedupeAnnouncements(filtered) }
}

function selectCninfoDownloads(announcements, limit) {
  const priority = new Map([
    ["annual_report", 100],
    ["semiannual_report", 90],
    ["quarterly_report", 80],
    ["event", 70],
    ["investor_relations", 60],
    ["announcement", 20],
  ])
  function downloadRelevance(item) {
    const title = String(item.title ?? "")
    let score = priority.get(item.type) ?? 0
    if (/发行股份购买资产|重大资产|资产购买|交易标的|收购|并购|重组|股权转让/.test(title)) score += 45
    if (/募集配套资金|预案|摘要/.test(title)) score += 15
    if (/投资者关系活动|调研|业绩说明会|互动易|路演/.test(title)) score += 20
    if (/异常波动/.test(title)) score -= 30
    if (/利润分配|现金分红/.test(title)) score -= 35
    if (/提前赎回|转债.*提示性公告/.test(title)) score -= 35
    if (/管理制度/.test(title)) score -= 25
    return score
  }
  function compareDownload(a, b) {
    return downloadRelevance(b) - downloadRelevance(a) || (b.announcementTime ?? 0) - (a.announcementTime ?? 0) || a.title.localeCompare(b.title)
  }
  const max = Math.max(0, limit)
  const pdfs = announcements
    .filter((item) => item.downloadUrl && String(item.adjunctType ?? "").toUpperCase() === "PDF")
    .sort(compareDownload)
  const selected = []
  const seen = new Set()
  for (const type of ["annual_report", "semiannual_report", "quarterly_report", "event", "investor_relations", "announcement"]) {
    if (selected.length >= max) break
    const match = pdfs.filter((item) => item.type === type).sort(compareDownload)[0]
    if (!match || seen.has(match.id)) continue
    selected.push(match)
    seen.add(match.id)
  }
  for (const item of pdfs) {
    if (selected.length >= max) break
    if (seen.has(item.id)) continue
    selected.push(item)
    seen.add(item.id)
  }
  return selected
}

const COMPANY_PDF_TARGET_KEYWORDS = [
  "主营业务分行业",
  "主营业务分产品",
  "营业收入和营业成本",
  "营业收入构成",
  "占营业收入",
  "产销量",
  "销售量",
  "生产量",
  "主要控股参股公司",
  "主要子公司",
  "子公司情况",
  "重要在建工程",
  "在建工程",
  "固定资产",
  "投资情况",
  "募集资金",
  "收购",
  "评估",
  "交易标的",
  "客户",
  "供应商",
  "前五名",
  "毛利率",
  "分行业",
  "分产品",
]

const COMPANY_PDF_EXTRACTOR_SCRIPT = String.raw`
import json
import re
import sys

pdf_path = sys.argv[1]
keywords = ${JSON.stringify(COMPANY_PDF_TARGET_KEYWORDS)}
result = {
    "status": "manual_needed",
    "tool": "python_fitz_pdfplumber",
    "pageCount": 0,
    "extractedChars": 0,
    "text": "",
    "sections": [],
    "tables": [],
    "targetPages": [],
    "issues": [],
}

def compact(text, limit=900):
    value = re.sub(r"\s+", " ", text or "").strip()
    return value[:limit]

try:
    import fitz

    doc = fitz.open(pdf_path)
    result["pageCount"] = int(doc.page_count)
    chunks = []
    hit_pages = set()
    for index, page in enumerate(doc):
        page_no = index + 1
        text = page.get_text("text") or ""
        if text:
            chunks.append(f"\n\n[Page {page_no}]\n{text}")
        hits = [key for key in keywords if key in text]
        if hits:
            hit_pages.add(page_no)
            result["sections"].append({
                "page": page_no,
                "keywords": hits[:10],
                "excerpt": compact(text),
            })
    text = "".join(chunks).strip()
    result["text"] = text
    result["extractedChars"] = len(text)
    target_pages = set()
    for page_no in hit_pages:
        for adjacent in (page_no - 1, page_no, page_no + 1):
            if 1 <= adjacent <= result["pageCount"]:
                target_pages.add(adjacent)
    result["targetPages"] = sorted(target_pages)
except Exception as exc:
    result["issues"].append(f"fitz_text_failed: {str(exc)[:240]}")

try:
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        page_count = len(pdf.pages)
        if not result["pageCount"]:
            result["pageCount"] = page_count
        target_pages = set(result["targetPages"])
        if not target_pages:
            max_pages = min(page_count, 20 if result["extractedChars"] else 8)
            target_pages = set(range(1, max_pages + 1))
            result["targetPages"] = sorted(target_pages)
        for page_no in sorted(target_pages):
            if page_no < 1 or page_no > page_count:
                continue
            page = pdf.pages[page_no - 1]
            tables = page.extract_tables() or []
            for table_index, table in enumerate(tables):
                rows = []
                for row in table or []:
                    cleaned = ["" if cell is None else str(cell) for cell in row]
                    if any(cell.strip() for cell in cleaned):
                        rows.append(cleaned)
                if rows:
                    result["tables"].append({
                        "page": page_no,
                        "tableIndex": table_index,
                        "rows": rows,
                    })
except Exception as exc:
    result["issues"].append(f"pdfplumber_table_failed: {str(exc)[:240]}")

if result["extractedChars"] or result["tables"]:
    result["status"] = "success" if result["tables"] else "partial"

print(json.dumps(result, ensure_ascii=False))
`

function defaultPdfExtractionResult() {
  return {
    status: "manual_needed",
    extractionTool: "unavailable",
    text: "",
    tables: [],
    sections: [],
    pageCount: 0,
    targetPages: [],
    issues: [],
  }
}

function normalizePdfExtractionResult(raw) {
  const base = defaultPdfExtractionResult()
  if (!raw || typeof raw !== "object") return base
  return {
    ...base,
    status: raw.status ?? base.status,
    extractionTool: raw.tool ?? raw.extractionTool ?? base.extractionTool,
    text: typeof raw.text === "string" ? raw.text : "",
    extractedChars: Number.isFinite(Number(raw.extractedChars)) ? Number(raw.extractedChars) : (typeof raw.text === "string" ? raw.text.length : 0),
    tables: Array.isArray(raw.tables) ? raw.tables : [],
    sections: Array.isArray(raw.sections) ? raw.sections : [],
    pageCount: Number.isFinite(Number(raw.pageCount)) ? Number(raw.pageCount) : 0,
    targetPages: Array.isArray(raw.targetPages) ? raw.targetPages : [],
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  }
}

async function extractPdfDocumentIfAvailable(pdfPath) {
  try {
    const { stdout } = await execFileAsync("python3", ["-c", COMPANY_PDF_EXTRACTOR_SCRIPT, pdfPath], {
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
      timeout: 60000,
    })
    return normalizePdfExtractionResult(JSON.parse(stdout))
  } catch (pythonErr) {
    try {
      const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
        encoding: "utf8",
        maxBuffer: 6 * 1024 * 1024,
        timeout: 30000,
      })
      const text = stdout.trim()
      return {
        ...defaultPdfExtractionResult(),
        status: text ? "partial" : "manual_needed",
        extractionTool: "pdftotext_layout",
        text,
        extractedChars: text.length,
        issues: text ? ["PDF text extracted by pdftotext; table recognition unavailable."] : [`pdf_extract_failed: ${safeErrorMessage(pythonErr)}`],
      }
    } catch (pdftotextErr) {
      return {
        ...defaultPdfExtractionResult(),
        issues: [`python_pdf_extract_failed: ${safeErrorMessage(pythonErr)}`, `pdftotext_failed: ${safeErrorMessage(pdftotextErr)}`],
      }
    }
  }
}

function pdfExtractionSidecar(extraction) {
  return {
    schema: "company-pdf-extract-v1",
    status: extraction.status,
    extractionTool: extraction.extractionTool,
    pageCount: extraction.pageCount,
    extractedChars: extraction.extractedChars ?? extraction.text?.length ?? 0,
    targetPages: extraction.targetPages,
    sections: extraction.sections,
    tables: extraction.tables,
    issues: extraction.issues,
  }
}

async function extractPdfTextIfAvailable(pdfPath) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 6 * 1024 * 1024,
      timeout: 30000,
    })
    return stdout.trim()
  } catch {
    return ""
  }
}

async function downloadCninfoArtifacts({ projectPath, outputDir, announcements, options = {} }) {
  const files = []
  const selected = selectCninfoDownloads(announcements, parsePositiveInteger(options.cninfoDownloadLimit, 12))
  const cninfoDir = path.join(outputDir, "artifacts", "cninfo")
  await ensureDirectory(cninfoDir)
  for (const announcement of selected) {
    const date = announcement.date ? announcement.date.replace(/-/g, "") : "unknown-date"
    const fileName = `${date}-${announcement.id}-${sanitizeArtifactName(announcement.title)}.pdf`
    const pdfPath = path.join(cninfoDir, fileName)
    try {
      const buffer = options.cninfoDownloader
        ? await options.cninfoDownloader({ announcement, outputPath: pdfPath })
        : await fetchPdfBufferWithTimeout(announcement.downloadUrl, {
            timeoutMs: options.cninfoDownloadTimeoutMs,
            fetchOptions: {
              headers: {
                Referer: announcement.source === "sse_public_web" ? "https://www.sse.com.cn/" : "https://www.cninfo.com.cn/new/index",
                "User-Agent": "Mozilla/5.0 trading-review-wiki-company-research",
              },
            },
          })
      const binary = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""))
      await fs.writeFile(pdfPath, binary)
      const hash = createHash("sha256").update(binary).digest("hex")
      const extraction = await extractPdfDocumentIfAvailable(pdfPath)
      const extracted = extraction.text ?? ""
      let textPath = null
      if (extracted) {
        textPath = pdfPath.replace(/\.pdf$/i, ".txt")
        await fs.writeFile(textPath, extracted, "utf8")
      }
      const extractPath = pdfPath.replace(/\.pdf$/i, ".extract.json")
      await writeJson(extractPath, pdfExtractionSidecar(extraction))
      files.push({
        announcementId: announcement.id,
        title: announcement.title,
        type: announcement.type,
        date: announcement.date ?? null,
        status: "success",
        filePath: projectRelative(projectPath, pdfPath),
        textPath: textPath ? projectRelative(projectPath, textPath) : null,
        extractPath: projectRelative(projectPath, extractPath),
        sha256: hash,
        bytes: binary.length,
        extractedChars: extraction.extractedChars ?? extracted.length,
        pageCount: extraction.pageCount ?? 0,
        relevantPages: extraction.targetPages ?? [],
        tableCount: extraction.tables?.length ?? 0,
        extractionTool: extraction.extractionTool,
        extractionIssues: extraction.issues ?? [],
      })
    } catch (err) {
      files.push({
        announcementId: announcement.id,
        title: announcement.title,
        type: announcement.type,
        status: "failed",
        error: safeErrorMessage(err),
      })
    }
  }
  return files
}

async function copyIfExists(sourcePath, targetPath) {
  try {
    await fs.copyFile(sourcePath, targetPath)
    return true
  } catch {
    return false
  }
}

async function readFileBytesIfAvailable(filePath) {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

async function findCachedCninfoArtifacts({ projectPath, outputDir, company, options = {} }) {
  if (options.disableCninfoCacheFallback) return []
  const root = path.join(projectPath, COMPANY_RESEARCH_ROOT)
  const cninfoDir = path.join(outputDir, "artifacts", "cninfo")
  await ensureDirectory(cninfoDir)
  const nameTokens = [
    company.stockName,
    company.secName,
    company.stockInput && !/^\d+$/.test(company.stockInput) ? company.stockInput : null,
  ].filter(Boolean).map((item) => String(item).toLowerCase())
  if (nameTokens.length === 0) return []
  let reportDirs = []
  try {
    reportDirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const dirent of reportDirs) {
    if (!dirent.isDirectory()) continue
    const artifactsDir = path.join(root, dirent.name, "artifacts", "cninfo")
    if (path.resolve(artifactsDir) === path.resolve(cninfoDir)) continue
    let files = []
    try {
      files = await fs.readdir(artifactsDir)
    } catch {
      continue
    }
    for (const fileName of files) {
      if (!fileName.toLowerCase().endsWith(".pdf")) continue
      const lower = fileName.toLowerCase()
      if (!nameTokens.some((token) => lower.includes(token))) continue
      const pdfPath = path.join(artifactsDir, fileName)
      let stat
      try {
        stat = await fs.stat(pdfPath)
      } catch {
        continue
      }
      candidates.push({ fileName, pdfPath, artifactsDir, mtimeMs: stat.mtimeMs })
    }
  }
  const limit = parsePositiveInteger(options.cninfoDownloadLimit, 12)
  const selected = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
  const out = []
  for (const item of selected) {
    const targetPdf = path.join(cninfoDir, item.fileName)
    const copiedPdf = await copyIfExists(item.pdfPath, targetPdf)
    if (!copiedPdf) continue
    const sourceText = item.pdfPath.replace(/\.pdf$/i, ".txt")
    const targetText = targetPdf.replace(/\.pdf$/i, ".txt")
    const copiedText = await copyIfExists(sourceText, targetText)
    const sourceExtract = item.pdfPath.replace(/\.pdf$/i, ".extract.json")
    const targetExtract = targetPdf.replace(/\.pdf$/i, ".extract.json")
    const copiedExtract = await copyIfExists(sourceExtract, targetExtract)
    const binary = await readFileBytesIfAvailable(targetPdf)
    const sidecar = readJsonObjectIfAvailable(targetExtract)
    const title = item.fileName.replace(/^\d{8}-[^-]+-/, "").replace(/\.pdf$/i, "")
    const dateMatch = item.fileName.match(/^(\d{4})(\d{2})(\d{2})-/)
    out.push({
      announcementId: `cached-${shortHash(item.pdfPath)}`,
      title,
      type: inferCninfoAnnouncementType(title),
      date: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null,
      status: "success",
      cached: true,
      filePath: projectRelative(projectPath, targetPdf),
      textPath: copiedText ? projectRelative(projectPath, targetText) : null,
      extractPath: copiedExtract ? projectRelative(projectPath, targetExtract) : null,
      sha256: binary ? createHash("sha256").update(binary).digest("hex") : null,
      bytes: binary?.length ?? null,
      extractedChars: sidecar?.extractedChars ?? 0,
      pageCount: sidecar?.pageCount ?? 0,
      relevantPages: sidecar?.targetPages ?? [],
      tableCount: sidecar?.tables?.length ?? 0,
      extractionTool: sidecar?.extractionTool ?? "cached_cninfo_artifact",
      extractionIssues: sidecar?.issues ?? [],
    })
  }
  return out
}

async function collectTushareEvidence({ company, credentials, options = {} }) {
  const client = options.tushareClient ?? defaultTushareClient
  const tsCode = company.tsCode ?? toTushareCode(company.stockCode ?? company.stockInput)
  const startDate = companyFinancialStartDate(options)
  const endDate = dateCompact(options.financialTo ?? options["financial-to"] ?? options.to) || dateCompact(nowLocalTimestamp())
  const calls = [
    { apiName: "stock_basic", params: tsCode ? { ts_code: tsCode } : { name: company.stockInput }, fields: "ts_code,symbol,name,area,industry,market,list_date" },
    { apiName: "income", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "balancesheet", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "cashflow", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "fina_indicator", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "daily_basic", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "forecast", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
    { apiName: "express", params: tsCode ? { ts_code: tsCode, start_date: startDate, end_date: endDate } : { start_date: startDate, end_date: endDate } },
  ]
  const tables = {}
  const callsSummary = []
  if (!credentials.tushareToken && !options.tushareClient) {
    return { status: "missing_config", calls: callsSummary, tables, error: "Tushare token is not configured" }
  }
  for (const call of calls) {
    try {
      const response = await client({
        ...call,
        token: credentials.tushareToken,
        timeoutMs: options.tushareTimeoutMs,
      })
      const normalized = normalizeTushareResponse(call.apiName, response)
      tables[call.apiName] = normalized
      callsSummary.push({
        apiName: call.apiName,
        status: normalized.status,
        rows: normalized.rows.length,
        error: normalized.error,
      })
    } catch (err) {
      tables[call.apiName] = { apiName: call.apiName, status: "failed", error: safeErrorMessage(err), fields: [], rows: [] }
      callsSummary.push({ apiName: call.apiName, status: "failed", rows: 0, error: safeErrorMessage(err) })
    }
  }
  const ok = callsSummary.some((item) => item.status === "success" && item.rows > 0)
  return { status: ok ? "success" : "partial", calls: callsSummary, tables, error: ok ? null : "No non-empty Tushare table returned" }
}

async function defaultTavilyClient({ query, apiKey, timeoutMs }) {
  if (!apiKey) throw new Error("Tavily API key is not configured")
  return fetchJsonWithTimeout("https://api.tavily.com/search", {
    timeoutMs,
    fetchOptions: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        include_answer: false,
        max_results: 5,
      }),
    },
  })
}

function normalizeTavilyResults(query, response) {
  const results = Array.isArray(response?.results) ? response.results : []
  return results.map((item, index) => ({
    query,
    rank: index + 1,
    title: item.title ?? "",
    url: item.url ?? "",
    content: item.content ?? item.snippet ?? "",
    score: typeof item.score === "number" ? item.score : null,
    publishedDate: item.published_date ?? item.publishedDate ?? null,
  }))
}

async function collectTavilyEvidence({ company, credentials, options = {} }) {
  const client = options.tavilyClient ?? defaultTavilyClient
  const name = company.stockName ?? company.secName ?? company.stockInput
  const industry = company.industry ?? "行业"
  const queries = [
    `${name} 技术能力 同业 对比`,
    `${name} ${industry} 供应链 海外 竞争格局`,
    `${name} 客户 验证 产能 ASP 毛利率`,
  ]
  if (!credentials.tavilyApiKey && !options.tavilyClient) {
    return { status: "missing_config", queries: queries.map((query) => ({ query, status: "skipped", results: 0 })), results: [], error: "Tavily API key is not configured" }
  }
  const summaries = []
  const results = []
  for (const query of queries) {
    try {
      const response = await client({ query, apiKey: credentials.tavilyApiKey, timeoutMs: options.tavilyTimeoutMs })
      const normalized = normalizeTavilyResults(query, response)
      results.push(...normalized)
      summaries.push({ query, status: "success", results: normalized.length })
    } catch (err) {
      summaries.push({ query, status: "failed", results: 0, error: safeErrorMessage(err) })
    }
  }
  return { status: results.length > 0 ? "success" : "partial", queries: summaries, results, error: results.length > 0 ? null : "No Tavily results returned" }
}

function latestByDate(rows, candidates = ["end_date", "ann_date", "trade_date"]) {
  const valid = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (valid.length === 0) return null
  return [...valid].sort((a, b) => {
    const av = candidates.map((key) => String(a[key] ?? "")).find(Boolean) ?? ""
    const bv = candidates.map((key) => String(b[key] ?? "")).find(Boolean) ?? ""
    return bv.localeCompare(av)
  })[0]
}

function pickNumber(row, keys) {
  if (!row) return null
  for (const key of keys) {
    const value = numberFromSqlCell(row[key])
    if (value != null) return value
  }
  return null
}

function scaleNumber(value, factor) {
  return value == null ? null : value * factor
}

function buildFinancialsFromTushare(tushareEvidence) {
  const tables = tushareEvidence.tables ?? {}
  const stockBasic = latestByDate(tables.stock_basic?.rows, ["list_date"])
  const income = latestByDate(tables.income?.rows)
  const balance = latestByDate(tables.balancesheet?.rows)
  const cashflow = latestByDate(tables.cashflow?.rows)
  const indicator = latestByDate(tables.fina_indicator?.rows)
  const dailyBasic = latestByDate(tables.daily_basic?.rows, ["trade_date"])
  return {
    schema: "company-financials-v1",
    source: "tushare_cross_check",
    stockBasic,
    latestPeriod: income?.end_date ?? balance?.end_date ?? indicator?.end_date ?? null,
    latestTradeDate: dailyBasic?.trade_date ?? null,
    metrics: {
      revenue: pickNumber(income, ["revenue", "total_revenue"]),
      operatingProfit: pickNumber(income, ["operate_profit", "op_income"]),
      netProfit: pickNumber(income, ["n_income_attr_p", "net_profit", "n_income"]),
      grossMarginPct: pickNumber(indicator, ["grossprofit_margin", "gross_margin"]),
      netMarginPct: pickNumber(indicator, ["netprofit_margin", "net_margin"]),
      roePct: pickNumber(indicator, ["roe", "roe_dt"]),
      totalAssets: pickNumber(balance, ["total_assets"]),
      totalLiabilities: pickNumber(balance, ["total_liab"]),
      operatingCashflow: pickNumber(cashflow, ["n_cashflow_act", "c_fr_sale_sg"]),
      peTtm: pickNumber(dailyBasic, ["pe_ttm", "pe"]),
      pb: pickNumber(dailyBasic, ["pb"]),
      totalMarketValue: scaleNumber(pickNumber(dailyBasic, ["total_mv"]), 10000),
      floatMarketValue: scaleNumber(pickNumber(dailyBasic, ["circ_mv"]), 10000),
      close: pickNumber(dailyBasic, ["close"]),
    },
    rawLatest: {
      income,
      balance,
      cashflow,
      indicator,
      dailyBasic,
    },
    tables: Object.fromEntries(Object.entries(tables).map(([key, table]) => [key, { status: table.status, rows: table.rows?.length ?? 0, fields: table.fields ?? [], error: table.error ?? null }])),
  }
}

function buildEvidenceLedger({ company, cninfo, downloads, tushare, tavily, wikiContext, generatedAt }) {
  const rows = []
  rows.push({
    dataItem: `${company.stockName ?? company.stockInput} CNINFO announcement search`,
    source: "cninfo",
    tool: "cninfo_public_web_adapter",
    status: cninfo.status,
    completedAt: generatedAt,
    purpose: "官方公告检索与下载候选",
    evidenceLevel: "A",
    details: { announcements: cninfo.announcements?.length ?? 0, requests: cninfo.requests?.length ?? 0, error: cninfo.error ?? null },
  })
  for (const file of downloads) {
    rows.push({
      dataItem: file.title,
      source: "cninfo",
      tool: "cninfo_pdf_download",
      status: file.status,
      completedAt: generatedAt,
      purpose: "年报/季报/重大事项/IR 原文缓存",
      evidenceLevel: "A",
      refs: [file.filePath, file.textPath].filter(Boolean),
      details: { announcementId: file.announcementId, type: file.type, bytes: file.bytes, extractedChars: file.extractedChars, error: file.error ?? null },
    })
  }
  for (const call of tushare.calls ?? []) {
    rows.push({
      dataItem: `Tushare ${call.apiName}`,
      source: "tushare",
      tool: "tushare_pro_http",
      status: call.status,
      completedAt: generatedAt,
      purpose: "财务快照/三表/估值交叉验证",
      evidenceLevel: "B",
      details: { rows: call.rows, error: call.error ?? null },
    })
  }
  for (const query of tavily.queries ?? []) {
    rows.push({
      dataItem: query.query,
      source: "tavily",
      tool: "tavily_search",
      status: query.status,
      completedAt: generatedAt,
      purpose: "同业技术能力、海外供应链、客户验证辅助证据",
      evidenceLevel: "C",
      details: { results: query.results, error: query.error ?? null },
    })
  }
  rows.push({
    dataItem: "Trading Review Wiki retrieval",
    source: "wiki",
    tool: "ask_retrieval_context",
    status: wikiContext?.retrievalWarnings?.length ? "partial" : "success",
    completedAt: generatedAt,
    purpose: "既有产业链、主题页、历史观点和图谱关联",
    evidenceLevel: "B",
    details: {
      counts: wikiContext?.counts ?? {},
      warnings: wikiContext?.retrievalWarnings ?? [],
    },
  })
  return {
    schema: "evidence-ledger-v1",
    generatedAt,
    company: {
      stockInput: company.stockInput,
      stockCode: company.stockCode,
      tsCode: company.tsCode,
      stockName: company.stockName,
      industry: company.industry,
    },
    rows,
  }
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((header) => String(row[header] ?? "")).join(" | ")} |`),
  ].join("\n")
}

function formatNumberForReport(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a"
  const n = Number(value)
  if (Math.abs(n) >= 100000000) return `${roundMetric(n / 100000000, 2)}亿`
  if (Math.abs(n) >= 10000) return `${roundMetric(n / 10000, 2)}万`
  return String(roundMetric(n, 2))
}

function buildCompanyReportMarkdown({ company, financials, ledger, cninfo, tavily, wikiContext, generatedAt }) {
  const metrics = financials.metrics ?? {}
  const ledgerRows = ledger.rows.map((row) => ({
    数据项: row.dataItem,
    来源: row.source,
    工具: row.tool,
    状态: row.status,
    完成时间: row.completedAt,
    用途: row.purpose,
    可信等级: row.evidenceLevel,
  }))
  const topAnnouncements = (cninfo.announcements ?? []).slice(0, 12)
  const topWeb = (tavily.results ?? []).slice(0, 8)
  const wikiHits = [
    ...(wikiContext?.wikiResults ?? []).slice(0, 6).map((item) => ({ bucket: "wiki", ...item })),
    ...(wikiContext?.graphExpansions ?? []).slice(0, 6).map((item) => ({ bucket: "graph", ...item })),
  ].slice(0, 10)
  return [
    `# ${company.stockName ?? company.stockInput} 公司深度研究`,
    "",
    `- 生成时间：${generatedAt}`,
    `- 股票代码：${company.tsCode ?? company.stockCode ?? "n/a"}`,
    `- 行业：${company.industry ?? "n/a"}`,
    "",
    "## 数据可信度声明",
    "",
    "- 基础财务模型只使用 A/B 级证据：公告、年报、季报、官方披露、Tushare/交易所结构化数据和本地行情库。",
    "- Tavily/WebSearch、研报、会议纪要和群聊线索只用于技术定位、行业对比、弹性假设与风险提示，不直接进入基础估值。",
    "- 缺少原始出处的关键数字标记为 `manual_needed`，不得作为基准结论。",
    "",
    "## 数据拉取确认表",
    "",
    markdownTable(["数据项", "来源", "工具", "状态", "完成时间", "用途", "可信等级"], ledgerRows),
    "",
    "## 核心财务快照",
    "",
    markdownTable(
      ["指标", "数值", "来源等级"],
      [
        { 指标: "最新报告期", 数值: financials.latestPeriod ?? "n/a", 来源等级: "B" },
        { 指标: "营业收入", 数值: formatNumberForReport(metrics.revenue), 来源等级: "B" },
        { 指标: "归母净利润", 数值: formatNumberForReport(metrics.netProfit), 来源等级: "B" },
        { 指标: "毛利率", 数值: metrics.grossMarginPct == null ? "n/a" : `${roundMetric(metrics.grossMarginPct, 2)}%`, 来源等级: "B" },
        { 指标: "ROE", 数值: metrics.roePct == null ? "n/a" : `${roundMetric(metrics.roePct, 2)}%`, 来源等级: "B" },
        { 指标: "总市值", 数值: formatNumberForReport(metrics.totalMarketValue), 来源等级: "B" },
        { 指标: "PE TTM", 数值: metrics.peTtm == null ? "n/a" : roundMetric(metrics.peTtm, 2), 来源等级: "B" },
      ],
    ),
    "",
    "## 官方公告证据",
    "",
    topAnnouncements.length
      ? topAnnouncements.map((item) => `- [${item.date || "unknown"}] ${item.title}（${item.type}，${item.downloadUrl ?? "no pdf"}）`).join("\n")
      : "- 未检索到公告，需人工补官方文件。",
    "",
    "## 行业与技术辅助证据",
    "",
    topWeb.length
      ? topWeb.map((item) => `- ${item.title || item.query}：${item.url}`).join("\n")
      : "- Tavily/WebSearch 未返回可用结果，技术和同业定位需人工补证据。",
    "",
    "## Wiki/图谱上下文",
    "",
    wikiHits.length
      ? wikiHits.map((item) => `- ${item.bucket}: ${item.path}（score=${roundMetric(item.score, 2)}）`).join("\n")
      : "- 暂未命中既有 wiki/图谱页面。",
    "",
    "## 初步研究结论",
    "",
    "- 当前报告为自动底稿版：已完成证据台账、财务快照、公告缓存、行业资料检索和 Excel 模型生成。",
    "- 基准估值必须以 `company-model.xlsx` 的 A/B 级证据假设为准；C 级网页资料只作为情景弹性。",
    "- 需要人工复核的重点：PDF 表格抽取完整性、子公司盈亏附注、分部收入/毛利率、产能和客户验证口径。",
    "",
  ].join("\n")
}

function buildWikiChangeCandidates({ company, wikiContext, ledger }) {
  const wikiHits = [
    ...(wikiContext?.wikiResults ?? []),
    ...(wikiContext?.graphExpansions ?? []),
  ]
  const unique = []
  const seen = new Set()
  for (const hit of wikiHits) {
    if (!hit.path || seen.has(hit.path)) continue
    seen.add(hit.path)
    unique.push(hit)
  }
  return [
    `# ${company.stockName ?? company.stockInput} wiki 写入候选`,
    "",
    "默认不自动写入正式 wiki。以下只是候选清单，后续需要单独确认。",
    "",
    "## 建议候选页",
    "",
    unique.length
      ? unique.slice(0, 12).map((hit) => `- ${hit.path}：补充 ${company.stockName ?? company.stockInput} 的官方公告证据、财务模型结论或技术定位；当前命中分 ${roundMetric(hit.score, 2)}。`).join("\n")
      : "- 暂无明确候选页，可考虑新建股票页或主题页，但需要人工确认。",
    "",
    "## 可写入信息类型",
    "",
    "- A/B 级：年报、公告、季报、Tushare/行情库交叉验证后的财务事实。",
    "- C 级：行业对比、海外供应链、技术定位，只能写入“待验证/辅助证据”。",
    "- D 级：群聊/KOL/传闻，不从本功能直接写入。",
    "",
    "## 证据状态",
    "",
    `- evidence ledger rows: ${ledger.rows.length}`,
    "",
  ].join("\n")
}

function buildCompanyWorkbookRows({ company, financials, ledger }) {
  const metrics = financials.metrics ?? {}
  const revenue = metrics.revenue ?? 0
  const netProfit = metrics.netProfit ?? 0
  const grossMargin = metrics.grossMarginPct ?? 0
  const pe = metrics.peTtm ?? 25
  const marketValue = metrics.totalMarketValue ?? 0
  return {
    Summary: [
      ["Company Research Model", "", "", COMPANY_RESEARCH_TEMPLATE_VERSION],
      ["Company", company.stockName ?? company.stockInput],
      ["Stock", company.tsCode ?? company.stockCode ?? ""],
      ["Industry", company.industry ?? ""],
      ["Latest Period", financials.latestPeriod ?? ""],
      [],
      ["Metric", "Value", "Evidence Level"],
      ["Revenue", revenue, "B"],
      ["Net Profit", netProfit, "B"],
      ["Gross Margin %", grossMargin, "B"],
      ["Market Value", marketValue, "B"],
      ["Base Target PE", { f: "Valuation!B5", t: "n" }, "model"],
      ["Base Equity Value", { f: "Valuation!B8", t: "n" }, "model"],
    ],
    Assumptions: [
      ["Assumption", "Downside", "Base", "Upside", "Evidence Level", "Note"],
      ["Revenue Growth Y1", -0.05, 0.08, 0.18, "B", "Default until segment model is manually refined"],
      ["Revenue Growth Y2", 0, 0.1, 0.2, "B", "Default until segment model is manually refined"],
      ["Revenue Growth Y3", 0.02, 0.1, 0.22, "B", "Default until segment model is manually refined"],
      ["Net Margin", grossMargin ? grossMargin / 100 * 0.45 : 0.08, grossMargin ? grossMargin / 100 * 0.55 : 0.1, grossMargin ? grossMargin / 100 * 0.65 : 0.12, "B", "Anchored to latest gross margin"],
      ["Target PE", Math.max(10, pe * 0.65), Math.max(12, pe * 0.85), Math.max(15, pe * 1.05), "B", "Anchored to latest daily_basic pe_ttm when available"],
    ],
    Historical: [
      ["Metric", "Latest", "Period", "Source"],
      ["Revenue", revenue, financials.latestPeriod ?? "", "tushare.income"],
      ["Net Profit", netProfit, financials.latestPeriod ?? "", "tushare.income"],
      ["Gross Margin %", grossMargin, financials.latestPeriod ?? "", "tushare.fina_indicator"],
      ["ROE %", metrics.roePct ?? "", financials.latestPeriod ?? "", "tushare.fina_indicator"],
      ["Total Assets", metrics.totalAssets ?? "", financials.latestPeriod ?? "", "tushare.balancesheet"],
      ["Operating Cashflow", metrics.operatingCashflow ?? "", financials.latestPeriod ?? "", "tushare.cashflow"],
    ],
    Forecast: [
      ["Metric", "Y0", "Y1 Base", "Y2 Base", "Y3 Base"],
      ["Revenue", revenue, { f: "B2*(1+Assumptions!C2)", t: "n" }, { f: "C2*(1+Assumptions!C3)", t: "n" }, { f: "D2*(1+Assumptions!C4)", t: "n" }],
      ["Net Margin", metrics.netMarginPct ? metrics.netMarginPct / 100 : 0.1, { f: "Assumptions!C5", t: "n" }, { f: "Assumptions!C5", t: "n" }, { f: "Assumptions!C5", t: "n" }],
      ["Net Profit", netProfit, { f: "C2*C3", t: "n" }, { f: "D2*D3", t: "n" }, { f: "E2*E3", t: "n" }],
    ],
    "Segment Model": [
      ["Segment", "Revenue", "Gross Margin %", "Evidence Level", "Status"],
      ["Core business", revenue, grossMargin, "B", "placeholder_from_financials"],
      ["New business / option", "", "", "manual_needed", "requires announcement table extraction"],
      ["Capacity / ASP / volume", "", "", "manual_needed", "requires annual report note parsing"],
    ],
    Valuation: [
      ["Scenario", "Net Profit Y1", "Target PE", "Equity Value", "Note"],
      ["Downside", { f: "Forecast!C4*0.85", t: "n" }, { f: "Assumptions!B6", t: "n" }, { f: "B2*C2", t: "n" }, "A/B evidence only"],
      ["Base", { f: "Forecast!C4", t: "n" }, { f: "Assumptions!C6", t: "n" }, { f: "B3*C3", t: "n" }, "A/B evidence only"],
      ["Upside", { f: "Forecast!C4*1.2", t: "n" }, { f: "Assumptions!D6", t: "n" }, { f: "B4*C4", t: "n" }, "C evidence only affects scenario note"],
      [],
      ["Base Target PE", { f: "C3", t: "n" }],
      ["Base Net Profit", { f: "B3", t: "n" }],
      ["Base Equity Value", { f: "D3", t: "n" }],
    ],
    Sensitivity: [
      ["PE / Net Profit", "Downside NP", "Base NP", "Upside NP"],
      [{ f: "Assumptions!B6", t: "n" }, { f: "A2*Valuation!B2", t: "n" }, { f: "A2*Valuation!B3", t: "n" }, { f: "A2*Valuation!B4", t: "n" }],
      [{ f: "Assumptions!C6", t: "n" }, { f: "A3*Valuation!B2", t: "n" }, { f: "A3*Valuation!B3", t: "n" }, { f: "A3*Valuation!B4", t: "n" }],
      [{ f: "Assumptions!D6", t: "n" }, { f: "A4*Valuation!B2", t: "n" }, { f: "A4*Valuation!B3", t: "n" }, { f: "A4*Valuation!B4", t: "n" }],
    ],
    Evidence: [
      ["Data Item", "Source", "Tool", "Status", "Completed At", "Evidence Level"],
      ...ledger.rows.map((row) => [row.dataItem, row.source, row.tool, row.status, row.completedAt, row.evidenceLevel]),
    ],
  }
}

function formatPeriod(value) {
  const raw = String(value ?? "")
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`
  return raw || "n/a"
}

function reportTypeLabel(row) {
  const endDate = String(row?.end_date ?? "")
  if (endDate.endsWith("1231")) return "annual"
  if (endDate.endsWith("0630")) return "semiannual"
  if (endDate.endsWith("0331") || endDate.endsWith("0930")) return "quarterly"
  return "periodic"
}

function latestRowsByPeriod(rows, limit = 6) {
  const byPeriod = new Map()
  for (const row of rows ?? []) {
    const period = String(row?.end_date ?? row?.trade_date ?? row?.ann_date ?? "")
    if (!period) continue
    if (!byPeriod.has(period)) byPeriod.set(period, row)
  }
  return [...byPeriod.values()]
    .sort((a, b) => String(b.end_date ?? b.trade_date ?? b.ann_date ?? "").localeCompare(String(a.end_date ?? a.trade_date ?? a.ann_date ?? "")))
    .slice(0, limit)
}

function resolveProjectArtifactPath(projectPath, maybeRelativePath) {
  if (!maybeRelativePath) return null
  return path.isAbsolute(maybeRelativePath) ? maybeRelativePath : path.join(projectPath, maybeRelativePath)
}

function readJsonObjectIfAvailable(filePath) {
  if (!filePath) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function cleanPdfCell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u3000/g, " ")
    .trim()
}

function cleanPdfRows(rows) {
  return (rows ?? [])
    .map((row) => (row ?? []).map(cleanPdfCell))
    .filter((row) => row.some(Boolean))
}

function pdfTableText(table) {
  return cleanPdfRows(table.rows).map((row) => row.join(" ")).join(" ")
}

function parsePdfNumber(value) {
  const raw = cleanPdfCell(value)
    .replace(/,/g, "")
    .replace(/，/g, "")
    .replace(/%/g, "")
    .replace(/\s+/g, "")
  if (!raw || raw === "-" || raw === "—") return null
  const match = raw.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function parsePdfPercent(value) {
  const raw = cleanPdfCell(value)
  if (!raw.includes("%")) return null
  return parsePdfNumber(raw)
}

function pdfRowNumbers(row) {
  return row.map(parsePdfNumber).filter((value) => value != null)
}

function firstMeaningfulPdfCell(row) {
  return row.find((cell) => {
    if (!cell) return false
    if (/^\d+(?:\.\d+)?%?$/.test(cell.replace(/,/g, ""))) return false
    return /[\p{Script=Han}A-Za-z]/u.test(cell)
  }) ?? ""
}

function isPdfHeaderLike(value) {
  return /^(项目|分行业|分产品|分地区|销售模式|公司名称|合计|小计|单位|本期|上期|报告期|行业分类)$/.test(cleanPdfCell(value))
}

function inferCompanyPdfTableType(rawTable, sectionKeywords = []) {
  const tableOnly = pdfTableText(rawTable)
  const compactTable = tableOnly.replace(/\s+/g, "")
  const text = `${sectionKeywords.join(" ")} ${tableOnly}`
  const compactText = `${sectionKeywords.join("")}${compactTable}`
  if (/(主营业务分行业|主营业务分产品|分产品|分行业|营业收入构成|产品构成)/.test(compactTable) && /(营业收入|主营业务收入|收入)/.test(compactText) && /(营业成本|毛利率|收入占比|分产品|存储芯片|微控制器|传感器|电子封装材料|电子级薄膜材料)/.test(compactText)) return "product_revenue"
  if (/(销售量|生产量|库存量)/.test(compactText) && /(万卷|万平方米|万只|吨|平方米|万颗|亿颗|颗|片|只|块)/.test(compactText)) return "capacity"
  if (/公司名称/.test(compactTable) && /(注册资本|公司类型|主要业务)/.test(compactTable) && /(净利润|营业利润|总资产|净资产)/.test(compactTable)) return "subsidiary_profit"
  if (/(工程进度|预算数|本期增加|转入固定资产|工程累计投入|利息资本化)/.test(compactTable) && /(在建工程|工程|项目|厂房|设备|基地|基膜|年产|产线|研发|芯片|晶圆|封测)/.test(compactTable)) return "capex"
  if (/(前五名客户|前五名供应商|客户|供应商)/.test(compactTable) && /(销售额|采购额|占年度)/.test(compactTable)) return "customer_supplier"
  return "other"
}

function normalizeProductRevenueTable(rawTable, sourceMeta) {
  const rows = cleanPdfRows(rawTable.rows)
  const text = `${sourceMeta.sectionKeywords?.join(" ") ?? ""} ${rows.map((row) => row.join(" ")).join(" ")}`
  const hasCost = /营业成本/.test(text) && /毛利率/.test(text)
  const normalized = []
  for (const row of rows) {
    const name = cleanPdfCell(row[0])
    if (!name || isPdfHeaderLike(name) || /营业收入|营业成本|毛利率|项目|合同分类|业务类型|其中|202\d年/.test(name)) continue
    const numbers = pdfRowNumbers(row)
    if (numbers.length === 0) continue
    const rowLooksCost = hasCost || (row.length >= 7 && parsePdfPercent(row[3]) != null)
    const record = {
      name,
      revenue: numbers[0] ?? null,
      status: "extracted",
      sourcePage: rawTable.page,
      evidenceLevel: "A",
    }
    if (rowLooksCost) {
      record.cost = numbers[1] ?? null
      record.grossMarginPct = numbers[2] ?? null
      record.yoyRevenuePct = numbers[3] ?? null
      record.yoyCostPct = numbers[4] ?? null
      record.yoyGrossMarginPctChange = numbers[5] ?? null
    } else {
      record.revenueSharePct = row.map(parsePdfPercent).find((value) => value != null) ?? null
      record.yoyRevenuePct = numbers.length >= 5 ? numbers[4] : null
    }
    normalized.push(record)
  }
  return normalized
}

function normalizeCapacityTable(rawTable) {
  const rows = cleanPdfRows(rawTable.rows)
  const normalized = []
  for (const row of rows) {
    const text = row.join(" ")
    if (!/(销售量|生产量|库存量)/.test(text)) continue
    const category = row.find((cell) => /产业|材料|业务|产品/.test(cell)) ?? ""
    const item = row.find((cell) => /(销售量|生产量|库存量)/.test(cell)) ?? ""
    const unit = row.find((cell) => /^万|平方米|吨|卷|只/.test(cell)) ?? ""
    const numbers = pdfRowNumbers(row)
    if (!item || numbers.length === 0) continue
    normalized.push({
      name: [category, item, unit].filter(Boolean).join("-"),
      category,
      item,
      unit,
      currentYear: numbers[0] ?? null,
      previousYear: numbers[1] ?? null,
      yoyPct: numbers[2] ?? null,
      status: "extracted",
      sourcePage: rawTable.page,
      evidenceLevel: "A",
    })
  }
  return normalized
}

function normalizeSubsidiaryProfitTable(rawTable) {
  const rows = cleanPdfRows(rawTable.rows)
  const normalized = []
  for (const row of rows) {
    const name = firstMeaningfulPdfCell(row)
    if (!name || isPdfHeaderLike(name) || /公司名称|主要业务|注册资本/.test(name)) continue
    const numbers = pdfRowNumbers(row)
    if (numbers.length < 4) continue
    normalized.push({
      name,
      registeredCapital: numbers[0] ?? null,
      totalAssets: numbers[1] ?? null,
      netAssets: numbers[2] ?? null,
      revenue: numbers[3] ?? null,
      operatingProfit: numbers[4] ?? null,
      netProfit: numbers[5] ?? null,
      status: "extracted",
      sourcePage: rawTable.page,
      evidenceLevel: "A",
    })
  }
  return normalized
}

function normalizeCapexTable(rawTable) {
  const rows = cleanPdfRows(rawTable.rows)
  const normalized = []
  for (const row of rows) {
    const project = firstMeaningfulPdfCell(row)
    if (!project || isPdfHeaderLike(project) || /工程名称|项目名称|预算数|工程进度/.test(project)) continue
    const compactProject = project.replace(/\s+/g, "")
    if (!/(项目|工程|厂房|设备|基地|基膜|年产|产研|离型膜|载带|产线|研发|芯片|晶圆|封测|存储|微控制器|传感器)/.test(compactProject)) continue
    const numbers = pdfRowNumbers(row)
    if (numbers.length === 0) continue
    const budget = parsePdfNumber(row[1])
    const openingBalance = parsePdfNumber(row[2])
    const additions = parsePdfNumber(row[3])
    const transferredToFixedAssets = parsePdfNumber(row[4])
    const otherDecrease = parsePdfNumber(row[5])
    const closingBalance = parsePdfNumber(row[6])
    const cumulativeInputPct = parsePdfPercent(row[7])
    const progressPct = parsePdfPercent(row[8])
    normalized.push({
      name: project,
      project,
      budget: budget ?? numbers[0] ?? null,
      openingBalance: openingBalance ?? numbers[1] ?? null,
      additions: additions ?? numbers[2] ?? null,
      transferredToFixedAssets: transferredToFixedAssets ?? numbers[3] ?? null,
      otherDecrease,
      closingBalance: closingBalance ?? numbers[5] ?? numbers[4] ?? numbers[0] ?? null,
      amount: closingBalance ?? numbers[5] ?? numbers[4] ?? numbers[0] ?? null,
      cumulativeInputPct,
      progressPct,
      fundingSource: row[12] ?? "",
      status: "extracted",
      sourcePage: rawTable.page,
      evidenceLevel: "A",
    })
  }
  return normalized
}

function normalizeCustomerSupplierTable(rawTable) {
  const rows = cleanPdfRows(rawTable.rows)
  const normalized = []
  for (const row of rows) {
    const name = firstMeaningfulPdfCell(row)
    const numbers = pdfRowNumbers(row)
    if (!name || isPdfHeaderLike(name) || numbers.length === 0) continue
    normalized.push({
      name,
      amount: numbers[0],
      sharePct: row.map(parsePdfPercent).find((value) => value != null) ?? null,
      status: "extracted",
      sourcePage: rawTable.page,
      evidenceLevel: "A",
    })
  }
  return normalized
}

function normalizeCompanyPdfTables(extraction) {
  const sectionKeywordsByPage = new Map()
  for (const section of extraction?.sections ?? []) {
    sectionKeywordsByPage.set(section.page, section.keywords ?? [])
  }
  const tables = []
  for (const rawTable of extraction?.tables ?? []) {
    const sectionKeywords = sectionKeywordsByPage.get(rawTable.page) ?? []
    const type = inferCompanyPdfTableType(rawTable, sectionKeywords)
    let rows = []
    if (type === "product_revenue") rows = normalizeProductRevenueTable(rawTable, { sectionKeywords })
    if (type === "capacity") rows = normalizeCapacityTable(rawTable)
    if (type === "subsidiary_profit") rows = normalizeSubsidiaryProfitTable(rawTable)
    if (type === "capex") rows = normalizeCapexTable(rawTable)
    if (type === "customer_supplier") rows = normalizeCustomerSupplierTable(rawTable)
    if (type === "other") {
      rows = cleanPdfRows(rawTable.rows).slice(0, 8).map((row) => ({ cells: row, status: "raw_table", sourcePage: rawTable.page, evidenceLevel: "A" }))
    }
    tables.push({
      type,
      page: rawTable.page,
      tableIndex: rawTable.tableIndex,
      rows,
      rawRows: cleanPdfRows(rawTable.rows),
    })
  }
  return tables
}

function buildDeepDocumentExtract({ projectPath, downloads, options = {} }) {
  const documents = []
  for (const file of downloads ?? []) {
    const custom = options.deepDocumentExtractor?.({ file, projectPath })
    if (custom && typeof custom === "object") {
      documents.push({
        documentId: file.announcementId,
        title: file.title,
        type: file.type,
        date: custom.date ?? file.date ?? null,
        status: custom.status ?? "success",
        filePath: file.filePath,
        textPath: custom.textPath ?? file.textPath ?? null,
        extractedChars: custom.extractedChars ?? file.extractedChars ?? 0,
        tables: Array.isArray(custom.tables) ? custom.tables : [],
        sections: Array.isArray(custom.sections) ? custom.sections : [],
        extractionTool: custom.extractionTool ?? "custom_deep_document_extractor",
        issues: custom.issues ?? [],
      })
      continue
    }
    const sidecarPath = resolveProjectArtifactPath(projectPath, file.extractPath)
    const sidecar = readJsonObjectIfAvailable(sidecarPath)
    const sidecarTables = normalizeCompanyPdfTables(sidecar)
    if (sidecar) {
      const hasUsefulTables = sidecarTables.some((table) => table.type !== "other" && (table.rows?.length ?? 0) > 0)
      const hasText = Boolean(file.textPath && (file.extractedChars ?? 0) > 0)
      documents.push({
        documentId: file.announcementId,
        title: file.title,
        type: file.type,
        date: file.date ?? null,
        status: hasUsefulTables ? "success" : (hasText ? "partial" : "manual_needed"),
        filePath: file.filePath,
        textPath: file.textPath ?? null,
        extractPath: file.extractPath ?? null,
        extractedChars: sidecar.extractedChars ?? file.extractedChars ?? 0,
        pageCount: sidecar.pageCount ?? file.pageCount ?? 0,
        relevantPages: sidecar.targetPages ?? file.relevantPages ?? [],
        tables: sidecarTables,
        sections: Array.isArray(sidecar.sections) ? sidecar.sections : [],
        extractionTool: sidecar.extractionTool ?? file.extractionTool ?? "local_pdf_extractor",
        issues: [
          ...(Array.isArray(sidecar.issues) ? sidecar.issues : []),
          ...(hasUsefulTables ? [] : ["PDF was cached, but no key annual-report table was machine-normalized."]),
        ],
      })
      continue
    }
    const hasText = Boolean(file.textPath && (file.extractedChars ?? 0) > 0)
    documents.push({
      documentId: file.announcementId,
      title: file.title,
      type: file.type,
      date: file.date ?? null,
      status: hasText ? "partial" : "manual_needed",
      filePath: file.filePath,
      textPath: file.textPath ?? null,
      extractPath: file.extractPath ?? null,
      extractedChars: file.extractedChars ?? 0,
      pageCount: file.pageCount ?? 0,
      relevantPages: file.relevantPages ?? [],
      tables: [],
      sections: [],
      extractionTool: hasText ? "pdftotext_layout" : "fallback_metadata_only",
      issues: hasText
        ? ["PDF text was extracted, but table recognition is not yet verified."]
        : ["PDF table/text extraction unavailable; keep official PDF cached and require manual table review."],
    })
  }
  return {
    schema: "company-document-extract-v1",
    generatedAt: nowLocalTimestamp(),
    providerPolicy: {
      dataAnalytics: "Use Data Analytics/table normalization when available; local fallback preserves manual_needed instead of guessing.",
      publicEquityInvesting: "Use buy-side report framing while keeping evidence levels explicit.",
    },
    documents,
    summary: {
      documents: documents.length,
      success: documents.filter((doc) => doc.status === "success").length,
      partial: documents.filter((doc) => doc.status === "partial").length,
      manualNeeded: documents.filter((doc) => doc.status === "manual_needed").length,
      tables: documents.reduce((sum, doc) => sum + (doc.tables?.length ?? 0), 0),
      keyTables: documents.reduce((sum, doc) => sum + (doc.tables ?? []).filter((table) => table.type !== "other").length, 0),
      keyRows: documents.reduce((sum, doc) => sum + (doc.tables ?? []).filter((table) => table.type !== "other").reduce((rowSum, table) => rowSum + (table.rows?.length ?? 0), 0), 0),
    },
  }
}

function extractRowsFromDocumentTables(documentExtract, tableType) {
  const rows = []
  for (const doc of documentExtract.documents ?? []) {
    for (const table of doc.tables ?? []) {
      if (table.type !== tableType) continue
      for (const row of table.rows ?? []) {
        rows.push({
          ...row,
          sourceDocumentId: doc.documentId,
          sourceTitle: doc.title,
          sourceType: doc.type,
          sourceDate: doc.date ?? null,
          sourcePage: table.page ?? row.page ?? null,
          evidenceLevel: "A",
          status: row.status ?? "extracted",
        })
      }
    }
  }
  return rows
}

function preferAnnualRows(rows) {
  const annual = (rows ?? []).filter((row) => row.sourceType === "annual_report")
  if (annual.length === 0) return rows ?? []
  const dates = annual.map((row) => String(row.sourceDate ?? "")).filter(Boolean).sort()
  const latest = dates[dates.length - 1]
  return latest ? annual.filter((row) => String(row.sourceDate ?? "") === latest) : annual
}

function mergeRowsByName(rows) {
  const byName = new Map()
  for (const row of rows ?? []) {
    const displayName = cleanPdfCell(row.name ?? row.product ?? row.segment ?? "")
    const key = canonicalCompanyRowName(displayName)
    if (!key) continue
    const existing = byName.get(key) ?? { name: displayName }
    const merged = { ...existing }
    for (const [field, value] of Object.entries(row)) {
      if (value == null || value === "") continue
      if (field === "sourcePage") {
        const pages = new Set([...(Array.isArray(existing.sourcePages) ? existing.sourcePages : []), existing.sourcePage, value].filter(Boolean))
        merged.sourcePages = [...pages].sort((a, b) => Number(a) - Number(b))
        merged.sourcePage = merged.sourcePages[0] ?? value
        continue
      }
      if (["cost", "grossMarginPct", "yoyCostPct", "yoyGrossMarginPctChange"].includes(field) && value != null) {
        const incomingPage = Number(row.sourcePage ?? 0)
        const existingPage = Number(existing.sourcePage ?? 0)
        if (merged[field] == null || incomingPage >= existingPage) merged[field] = value
        continue
      }
      if (merged[field] == null || merged[field] === "") merged[field] = value
    }
    byName.set(key, merged)
  }
  return [...byName.values()]
}

function canonicalCompanyRowName(value) {
  return cleanPdfCell(value)
    .replace(/\s+/g, "")
    .replace(/行业$/, "产业")
}

function selectPrimaryCapexRows(rows) {
  return (rows ?? []).filter((row) => {
    const name = canonicalCompanyRowName(row.name ?? row.project ?? "")
    if (!name) return false
    if (/(机器设备|转入在建工程|设备改造|固定资产改造)/.test(name)) return false
    if (row.progressPct == null && row.cumulativeInputPct == null) return false
    if (row.budget != null && Math.abs(Number(row.budget)) < 1000000) return false
    return /(项目|工程|厂房|设备安装|基地|基膜|年产|离型膜|载带|产线|研发|芯片|晶圆|封测|存储|微控制器|传感器)/.test(name)
  })
}

function unitScaleFromChineseUnit(unit) {
  const text = cleanPdfCell(unit)
  if (text.includes("万")) return 10000
  return 1
}

function attachAspInferences(productLines, capacityRows) {
  const salesRows = (capacityRows ?? []).filter((row) => /销售量/.test(row.item ?? row.name ?? "") && row.currentYear != null)
  return (productLines ?? []).map((row) => {
    if (row.revenue == null) return row
    let matched = null
    const name = row.name ?? ""
    if (/薄膜|离型膜/.test(name)) matched = salesRows.find((item) => /平方米/.test(item.unit ?? item.name ?? ""))
    if (!matched && /封装|载带|胶带/.test(name)) matched = salesRows.find((item) => /卷/.test(item.unit ?? item.name ?? ""))
    if (!matched && /存储|芯片|MCU|微控制器|传感器|Flash|DRAM|NOR|NAND/i.test(name)) matched = salesRows.find((item) => /颗|片|只|块/.test(item.unit ?? item.name ?? ""))
    if (!matched) return row
    const denominator = Number(matched.currentYear) * unitScaleFromChineseUnit(matched.unit)
    if (!Number.isFinite(denominator) || denominator <= 0) return row
    return {
      ...row,
      volume: `${matched.currentYear}${matched.unit ?? ""}`,
      asp: roundMetric(Number(row.revenue) / denominator, 4),
      aspUnit: /平方米/.test(matched.unit ?? "") ? "元/平方米" : (/卷/.test(matched.unit ?? "") ? "元/卷" : "元/单位"),
      aspStatus: "requires_review",
      aspSourcePage: matched.sourcePage,
      aspNote: "ASP uses product revenue divided by annual-report sales volume. Because PDF tables may not explicitly map every product row to each volume unit, keep this as review-required.",
    }
  })
}

function manualNeededRow(name, reason, sourceTitle = null) {
  return {
    name,
    status: "manual_needed",
    evidenceLevel: "A",
    sourceTitle,
    reason,
  }
}

const CORPORATE_ACTION_PATTERN = /收购|并购|重组|重大|预案|交易标的|股权转让|增资|投资协议|资产购买|发行股份|定增|可转债|回购|异常波动|埃福思/

function isCorporateActionDocument(doc) {
  const text = `${doc?.title ?? ""} ${doc?.type ?? ""}`
  if (/利润分配|现金分红|提前赎回|转债.*提示性公告|异常波动|管理制度/.test(text)) return false
  return doc?.type === "event" || CORPORATE_ACTION_PATTERN.test(text)
}

function corporateActionExcerpt(doc) {
  const sections = (doc?.sections ?? [])
    .filter((section) => CORPORATE_ACTION_PATTERN.test(`${section.keywords?.join(" ") ?? ""} ${section.excerpt ?? ""}`))
    .slice(0, 2)
  const picked = sections.length ? sections : (doc?.sections ?? []).slice(0, 1)
  return picked.map((section) => excerptForPrompt(section.excerpt ?? "", 180)).filter(Boolean).join(" / ")
}

function compactCorporateTerm(value, limit = 220) {
  const text = String(value ?? "")
    .replace(/\[Page\s*\d+\]/gi, "")
    .replace(/浙江洁美电子科技股份有限公司发行股份购买资产并募集配套资金预案\d*/g, "")
    .replace(/\s+/g, "")
    .replace(/[□√]+/g, "")
    .trim()
  return text ? excerptForPrompt(text, limit) : ""
}

function firstCompactMatch(text, regex, limit = 220) {
  const match = String(text ?? "").replace(/\s+/g, "").match(regex)
  return match ? compactCorporateTerm(match[1], limit) : ""
}

function extractCorporateActionTerms(text) {
  const compact = String(text ?? "").replace(/\s+/g, "")
  if (!compact || !CORPORATE_ACTION_PATTERN.test(compact)) return {}
  const acquiredTarget =
    firstCompactMatch(compact, /收购([^，。；;]{2,100}?(?:股份有限公司|有限公司))(?:全体股东|控股权|70%)/, 140) ||
    firstCompactMatch(compact, /标的公司[”"]?）?([^，。；;]{2,80}?(?:股份有限公司|有限公司))/, 120)
  const acquiredEquity =
    firstCompactMatch(compact, /(?:标的股权为|合计持有(?:的)?)([^，。；;]{1,80}?70%[的]?(?:股份|股权))/, 120) ||
    firstCompactMatch(compact, /(70%[的]?(?:股份|股权))/, 80)
  const targetName =
    firstCompactMatch(compact, /交易标的名称([^，。；;]{2,80}?(?:100%股权|股权|资产|公司))/, 120) ||
    firstCompactMatch(compact, /(?:标的资产、标的股份|名称)([^，。；;]{2,80}?(?:100%股权|股权|资产|公司))/, 120) ||
    [acquiredTarget, acquiredEquity].filter(Boolean).join(" ")
  const performanceCommitment =
    firstCompactMatch(compact, /本次交易有无业绩承诺□有□无（(.{20,260}?具体安排)）/, 260) ||
    firstCompactMatch(compact, /本次交易有无业绩承诺(.{20,260}?)(?:浙江洁美|本次交易对上市公司|管理办法|交易性质)/, 260) ||
    firstCompactMatch(compact, /(业绩承诺方.{20,260}?盈利补偿协议)/, 260)
  const terms = {
    transactionForm: firstCompactMatch(compact, /交易形式([^，。；;]{4,80}?)(?:交易方案简介|上市公司拟)/) ||
      firstCompactMatch(compact, /(以现金方式收购[^，。；;]{4,120}?)(?:。|；|本次交易|根据)/, 160),
    transactionOverview: firstCompactMatch(compact, /交易方案简介(.{20,260}?)(?:交易价格|交[易]?标[的]?名称)/, 260),
    targetName,
    targetBusiness: firstCompactMatch(compact, /主营业务(.{4,120}?)(?:所属行业|其他|符合板块定位)/, 160),
    targetIndustry: firstCompactMatch(compact, /所属行业(.{4,120}?)(?:其他|符合板块定位|属于上市公司)/, 160),
    counterparties: firstCompactMatch(compact, /向(.{2,100}?交易对方)购买/, 160) ||
      firstCompactMatch(compact, /本次交易的交易对方(?:\/转让方)?为(.{4,180}?)(?:本次交易标的|其他交易对方|。)/, 180),
    priceStatus: firstCompactMatch(compact, /交易价格(?:（不含募集配套资金金额）)?(.{20,260}?)(?:交易标的|交[易]?标[的]?名称|名称)/, 260) ||
      firstCompactMatch(compact, /交易价格确定为([^。；;]{4,100}?万元)/, 140) ||
      firstCompactMatch(compact, /本次(?:苏州赛芯)?70%股权的交易价格确定为([^。；;]{4,100}?万元)/, 140),
    performanceCommitment,
    auditValuationStatus: firstCompactMatch(compact, /(审计、评估工作尚未完成.{20,220}?披露)/, 260) ||
      firstCompactMatch(compact, /((?:评估值|评估值为|股东全部权益的评估值为)[^。；;]{4,120}?万元)/, 160),
  }
  return Object.fromEntries(Object.entries(terms).filter(([, value]) => Boolean(value)))
}

function readDocumentTextForTerms(projectPath, doc) {
  const textPath = resolveProjectArtifactPath(projectPath, doc?.textPath)
  if (!textPath) return ""
  try {
    return readFileSync(textPath, "utf8")
  } catch {
    return ""
  }
}

function buildCorporateActionFindings({ projectPath, documentExtract, evidencePack }) {
  const downloadedDocIds = new Set((documentExtract.documents ?? []).map((doc) => String(doc.documentId ?? "")))
  const downloadedTitles = new Set((documentExtract.documents ?? []).map((doc) => String(doc.title ?? "")))
  const rows = []
  for (const doc of documentExtract.documents ?? []) {
    if (!isCorporateActionDocument(doc)) continue
    const terms = extractCorporateActionTerms(readDocumentTextForTerms(projectPath, doc))
    rows.push({
      title: doc.title,
      date: doc.date ?? null,
      type: doc.type ?? "event",
      status: doc.status ?? "partial",
      evidenceLevel: "A",
      source: "cninfo_pdf",
      filePath: doc.filePath ?? null,
      pages: doc.relevantPages?.slice(0, 8).join(",") ?? "",
      terms,
      summary: corporateActionExcerpt(doc) || "官方重大事项 PDF 已缓存；需要打开原文复核交易条款和会计影响。",
    })
  }
  for (const item of evidencePack?.cninfo?.announcements ?? []) {
    if (!isCorporateActionDocument(item)) continue
    if (downloadedDocIds.has(String(item.id ?? "")) || downloadedTitles.has(String(item.title ?? ""))) continue
    rows.push({
      title: item.title,
      date: item.date ?? null,
      type: item.type ?? "event",
      status: "announcement_only",
      evidenceLevel: "A",
      source: "cninfo_announcement_search",
      filePath: item.downloadUrl ?? null,
      pages: "",
      terms: {},
      summary: "CNINFO 检索到官方重大事项公告，但本次下载上限未覆盖 PDF；可提高 --cninfo-download-limit 后复核原文表格。",
    })
  }
  const officialRows = rows.slice(0, 8)
  if (officialRows.length) return officialRows
  const webRows = (evidencePack?.tavily?.results ?? [])
    .filter((item) => CORPORATE_ACTION_PATTERN.test(`${item.title ?? ""} ${item.content ?? ""} ${item.url ?? ""}`))
    .slice(0, 5)
    .map((item) => ({
      title: item.title ?? item.query ?? "外部重大事项线索",
      date: item.publishedDate ?? null,
      type: "external_event_clue",
      status: "external_only",
      evidenceLevel: "C",
      source: "tavily_web",
      filePath: item.url ?? null,
      pages: "",
      terms: {},
      summary: excerptForPrompt(item.content ?? "", 220) || "外部资料线索，不能作为基础事实。",
    }))
  if (webRows.length) return webRows
  return [{
    title: "重大事项/收购期权",
    date: null,
    type: "event",
    status: "manual_needed",
    evidenceLevel: "A",
    source: "cninfo_pdf",
    filePath: null,
    pages: "",
    terms: {},
    summary: "未抽到官方重大事项 PDF；若研究假设包含收购、重组或期权价值，需要补官方公告原文后再进入模型。",
  }]
}

function buildDeepBusinessBreakdown({ projectPath, company, financials, evidencePack, documentExtract }) {
  const tables = evidencePack?.tushare?.tables ?? {}
  const incomeRows = latestRowsByPeriod(tables.income?.rows, 8).map((row) => ({
    period: row.end_date,
    periodLabel: formatPeriod(row.end_date),
    reportType: reportTypeLabel(row),
    revenue: pickNumber(row, ["revenue", "total_revenue"]),
    netProfit: pickNumber(row, ["n_income_attr_p", "net_profit", "n_income"]),
    operatingProfit: pickNumber(row, ["operate_profit", "op_income"]),
    rdExpense: pickNumber(row, ["rd_exp"]),
    evidenceLevel: "B",
    source: "tushare.income",
  }))
  const balanceRows = latestRowsByPeriod(tables.balancesheet?.rows, 8).map((row) => ({
    period: row.end_date,
    periodLabel: formatPeriod(row.end_date),
    totalAssets: pickNumber(row, ["total_assets"]),
    totalLiabilities: pickNumber(row, ["total_liab"]),
    fixedAssets: pickNumber(row, ["fix_assets"]),
    constructionInProgress: pickNumber(row, ["cip"]),
    inventories: pickNumber(row, ["inventories"]),
    accountsReceivable: pickNumber(row, ["accounts_receiv"]),
    totalShare: pickNumber(row, ["total_share"]),
    evidenceLevel: "B",
    source: "tushare.balancesheet",
  }))
  const cashflowRows = latestRowsByPeriod(tables.cashflow?.rows, 8).map((row) => ({
    period: row.end_date,
    periodLabel: formatPeriod(row.end_date),
    operatingCashflow: pickNumber(row, ["n_cashflow_act", "net_cash_flows_oper_act", "n_cashflow_act"]),
    capexCashOutflow: pickNumber(row, ["c_pay_acq_const_fiolta", "c_paid_for_assets", "c_cash_paid_for_assets"]),
    freeCashflow: pickNumber(row, ["free_cashflow", "fcff"]),
    evidenceLevel: "B",
    source: "tushare.cashflow",
  }))
  const indicatorRows = latestRowsByPeriod(tables.fina_indicator?.rows, 8).map((row) => ({
    period: row.end_date,
    periodLabel: formatPeriod(row.end_date),
    grossMarginPct: pickNumber(row, ["grossprofit_margin", "gross_margin"]),
    netMarginPct: pickNumber(row, ["netprofit_margin", "net_margin"]),
    roePct: pickNumber(row, ["roe", "roe_dt"]),
    debtToAssetsPct: pickNumber(row, ["debt_to_assets"]),
    evidenceLevel: "B",
    source: "tushare.fina_indicator",
  }))
  const capacity = preferAnnualRows(extractRowsFromDocumentTables(documentExtract, "capacity"))
  const productLines = attachAspInferences(mergeRowsByName(preferAnnualRows(extractRowsFromDocumentTables(documentExtract, "product_revenue"))), capacity)
  const subsidiaryProfit = extractRowsFromDocumentTables(documentExtract, "subsidiary_profit")
  const capex = selectPrimaryCapexRows(preferAnnualRows(extractRowsFromDocumentTables(documentExtract, "capex")))
  const corporateActions = buildCorporateActionFindings({ projectPath, documentExtract, evidencePack })
  const latestIncome = incomeRows[0] ?? {}
  const latestBalance = balanceRows[0] ?? {}
  const latestIndicator = indicatorRows[0] ?? {}
  const webEvidence = (evidencePack?.tavily?.results ?? []).slice(0, 10).map((item) => ({
    title: item.title,
    url: item.url,
    query: item.query,
    content: excerptForPrompt(item.content ?? "", 220),
    evidenceLevel: "C",
    status: item.url ? "available" : "partial",
  }))
  return {
    schema: "company-business-breakdown-v1",
    generatedAt: nowLocalTimestamp(),
    company,
    productLines: productLines.length > 0
      ? productLines
      : [
          manualNeededRow("产品收入/毛利率拆分", "Annual report product revenue table was not machine-extracted.", documentExtract.documents?.find((doc) => doc.type === "annual_report")?.title),
          manualNeededRow("销量/ASP 拆分", "Volume and ASP table requires annual-report note/table extraction.", documentExtract.documents?.find((doc) => doc.type === "annual_report")?.title),
        ],
    subsidiaryProfit: subsidiaryProfit.length > 0
      ? subsidiaryProfit
      : [manualNeededRow("子公司盈亏核实", "Subsidiary P&L table requires annual-report note extraction.", documentExtract.documents?.find((doc) => doc.type === "annual_report")?.title)],
    capacity: capacity.length > 0
      ? capacity
      : [manualNeededRow("产能/客户验证/ASP", "Capacity, utilization, validation and ASP fields require announcement table/text extraction.", documentExtract.documents?.find((doc) => doc.type === "annual_report")?.title)],
    capex: capex.length > 0
      ? capex
      : [
          {
            name: "在建工程",
            period: latestBalance.period ?? null,
            amount: latestBalance.constructionInProgress ?? null,
            evidenceLevel: "B",
            source: "tushare.balancesheet",
            status: latestBalance.constructionInProgress == null ? "manual_needed" : "cross_check",
            reason: latestBalance.constructionInProgress == null ? "CIP field unavailable from structured financials." : "Structured financial cross-check; annual-report project detail still needs PDF table extraction.",
          },
        ],
    historicalFinancials: {
      income: incomeRows,
      balance: balanceRows,
      cashflow: cashflowRows,
      indicators: indicatorRows,
    },
    keyMetrics: {
      latestPeriod: financials.latestPeriod,
      revenue: latestIncome.revenue ?? financials.metrics?.revenue ?? null,
      netProfit: latestIncome.netProfit ?? financials.metrics?.netProfit ?? null,
      grossMarginPct: latestIndicator.grossMarginPct ?? financials.metrics?.grossMarginPct ?? null,
      netMarginPct: latestIndicator.netMarginPct ?? financials.metrics?.netMarginPct ?? null,
      constructionInProgress: latestBalance.constructionInProgress ?? null,
      fixedAssets: latestBalance.fixedAssets ?? null,
      totalMarketValue: financials.metrics?.totalMarketValue ?? null,
      peTtm: financials.metrics?.peTtm ?? null,
      pb: financials.metrics?.pb ?? null,
      close: financials.metrics?.close ?? null,
    },
    technicalAndIndustryEvidence: webEvidence,
    corporateActions,
    validationStatus: {
      productLineCompleteness: productLines.length > 0 ? "official_table_extracted" : "manual_needed",
      subsidiaryCompleteness: subsidiaryProfit.length > 0 ? "official_table_extracted" : "manual_needed",
      capexCompleteness: capex.length > 0 ? "official_table_extracted" : (latestBalance.constructionInProgress == null ? "manual_needed" : "cross_check"),
      corporateActionCompleteness: corporateActions.some((row) => row.evidenceLevel === "A" && row.status !== "manual_needed") ? "official_evidence_available" : "manual_needed",
      noInventedFigures: true,
    },
  }
}

function tableRowsFromObjects(headers, rows) {
  return rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] ?? ""])))
}

function formatPercentForReport(value, digits = 2) {
  return value == null ? "n/a" : `${roundMetric(Number(value), digits)}%`
}

function numberToYi(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n / 100000000 : null
}

function formatYi(value, digits = 2) {
  const yi = numberToYi(value)
  return yi == null ? "n/a" : `${roundMetric(yi, digits)}亿`
}

function findBusinessRow(rows, patterns) {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return (rows ?? []).find((row) => list.some((pattern) => pattern.test(String(row.name ?? row.product ?? row.segment ?? "")))) ?? null
}

function companyResearchProfile(company = {}) {
  const text = [
    company.stockName,
    company.secName,
    company.stockInput,
    company.stockCode,
    company.tsCode,
    company.industry,
  ].filter(Boolean).join(" ")
  if (/洁美|002859/.test(text)) {
    return {
      kind: "jiemei",
      productPatterns: [/电子封装/, /电子级薄膜/, /^其他$/],
      coreProductPatterns: [/电子级薄膜/, /离型膜/, /薄膜/],
      baseProductPatterns: [/电子封装/, /载带/],
      focusSubsidiaryPatterns: [/广东洁美/, /天津洁美/],
      coreProductName: "电子级薄膜材料",
      coreShortName: "薄膜材料",
      baseProductName: "载带业务",
      baseSectionTitle: "## 五、载带业务（稳定现金牛）",
      baseSectionMissing: "- 未从公告表格中稳定抽出载带/电子封装材料数据，需人工复核。",
      aspSectionTitle: "### 1.2 ASP 独立推算",
      scenarioVolumeHeader: "2026E薄膜量",
      scenarioAspHeader: "2026E薄膜ASP",
      scenarioVolumeUnit: "亿平",
      scenarioAspUnit: "元/平",
      scenarioWorkbookVolume2026: "Film Volume 2026E",
      scenarioWorkbookAsp2026: "Film ASP 2026E",
      scenarioWorkbookVolume2027: "Film Volume 2027E",
      scenarioWorkbookAsp2027: "Film ASP 2027E",
      coreVariableText: "核心变量是薄膜材料销量、混合 ASP、毛利率改善速度和载带业务稳定性。",
      currentPositionText: "当前价格大致贴近基准情景，关键在于离型膜量价兑现。",
      coreMissingText: "高弹性业务线未能从公告表格中稳定拆出，需要人工复核。",
      aspNote: "该 ASP 是产品线收入除以销量的混合结果，可能同时包含 MLCC 离型膜、偏光片离型膜、流延膜等，不能直接等同于单一高端 MLCC 产品价格。",
      techNotes: [
        "- 自动报告只把技术能力作为 C 级或待验证判断，除非来自公告、投资者关系记录或公司官网的明确表述。",
        "- 若外部资料提到高端 MLCC、日韩客户、极薄离型膜或高 ASP 产品，默认进入乐观情景和验证清单，不进入基准估值。",
        "- 后续增强可以把官方 IR Q&A PDF/网页作为 A/B 证据抽取，单独更新技术路线表。",
      ],
      scenarioThesis: {
        pessimistic: "离型膜量价改善慢，载带稳定增长但估值难继续扩张。",
        base: "离型膜完成爬坡并改善结构，载带继续提供现金流基础。",
        optimistic: "高端客户和高 ASP 产品放量，离型膜从利润拖累变成主要弹性。",
      },
      valuationSensitivityText: "估值对薄膜兑现速度高度敏感。",
      scenarioInterpretationText: "悲观情景代表量价兑现慢；基准情景代表产能爬坡和结构升级按公告可验证路径推进；乐观情景需要高端客户或高 ASP 产品得到独立验证。",
      sensitivityNote: "基准情景若目标价低于现价，说明市场已提前定价一部分薄膜弹性；乐观情景需要官方客户、ASP 或收购并表证据兑现。",
      subsidiaryLossText: (value) => value
        ? `广东/天津等薄膜相关子公司营业利润合计 ${formatNumberForReport(value)}，提示薄膜业务仍处于爬坡修复阶段。`
        : "薄膜相关子公司亏损未能完整量化，需要继续复核子公司表。",
      baseSectionText: (baseProduct) => baseProduct
        ? [
            `- 年报确认：${baseProduct.name}收入 ${formatNumberForReport(baseProduct.revenue)}，毛利率 ${formatPercentForReport(baseProduct.grossMarginPct)}，收入占比 ${formatPercentForReport(baseProduct.revenueSharePct)}。`,
            `- 量价口径：销量 ${baseProduct.volume ?? "n/a"}，混合 ASP ${baseProduct.asp == null ? "n/a" : `${baseProduct.asp}${baseProduct.aspUnit ? ` ${baseProduct.aspUnit}` : ""}`}。`,
            "- 投资含义：载带业务给出现金流和估值底座，薄膜/高端材料决定估值弹性；若薄膜验证失败，应回到载带现金牛定价。",
          ].join("\n")
        : null,
    }
  }
  if (/半导体|兆易|603986|存储|DRAM|NOR|NAND|Flash|MCU|微控制器|传感器/.test(text)) {
    return {
      kind: "semiconductor_memory",
      productPatterns: [/存储/, /DRAM/i, /NOR/i, /NAND/i, /Flash/i, /MCU/i, /微控制器/, /传感器/, /芯片/, /集成电路/],
      coreProductPatterns: [/存储/, /DRAM/i, /NOR/i, /NAND/i, /Flash/i],
      baseProductPatterns: [/MCU/i, /微控制器/, /传感器/, /模拟产品/],
      focusSubsidiaryPatterns: [/兆易/, /合肥/, /芯技佳易/, /思立微/],
      coreProductName: "存储产品/高弹性业务",
      coreShortName: "存储产品",
      baseProductName: "MCU/传感器等现金流底座",
      baseSectionTitle: "## 五、核心业务与现金流底座",
      baseSectionMissing: "- 未从公告表格中稳定抽出 MCU/传感器等成熟产品线数据，需人工复核。",
      aspSectionTitle: "### 1.2 价格/毛利率线索",
      scenarioVolumeHeader: "2026E核心产品量",
      scenarioAspHeader: "2026E价格/毛利率",
      scenarioVolumeUnit: "",
      scenarioAspUnit: "",
      scenarioWorkbookVolume2026: "Core Product Volume 2026E",
      scenarioWorkbookAsp2026: "Core Product Price/Margin 2026E",
      scenarioWorkbookVolume2027: "Core Product Volume 2027E",
      scenarioWorkbookAsp2027: "Core Product Price/Margin 2027E",
      coreVariableText: "核心变量是存储价格周期、产品结构、毛利率修复、库存去化和 MCU/传感器业务韧性。",
      currentPositionText: "当前价格大致贴近基准情景，关键在于存储价格周期和毛利率修复能否兑现。",
      coreMissingText: "存储/MCU/传感器等核心产品线未能从公告表格中稳定拆出，需要人工复核。",
      aspNote: "若公告只披露分产品收入/毛利率而不披露销量，价格弹性只能作为毛利率和产品结构线索，不能强行反推单颗芯片 ASP。",
      techNotes: [
        "- 自动报告只把技术路线、客户和供应链资料作为 C 级或待验证判断，除非来自公告、投资者关系记录或公司官网的明确表述。",
        "- 若外部资料提到 DRAM/NOR Flash/MCU 价格周期、国产替代或客户导入，默认进入乐观情景和验证清单，不进入基准估值。",
        "- 后续增强可以把官方 IR Q&A PDF/网页作为 A/B 证据抽取，单独更新产品线和库存周期验证表。",
      ],
      scenarioThesis: {
        pessimistic: "存储价格修复慢，库存和费用拖累毛利率，MCU/传感器只提供估值底座。",
        base: "存储价格和产品结构温和修复，MCU/传感器维持现金流韧性。",
        optimistic: "存储周期上行叠加新品/客户导入，毛利率和收入弹性同步释放。",
      },
      valuationSensitivityText: "估值对存储价格周期、毛利率修复和库存去化速度高度敏感。",
      scenarioInterpretationText: "悲观情景代表存储周期兑现慢；基准情景代表价格和毛利率按公告可验证路径修复；乐观情景需要客户导入、新品放量或价格周期得到独立验证。",
      sensitivityNote: "基准情景若目标价低于现价，说明市场已提前定价一部分周期修复；乐观情景需要官方客户、产品结构或毛利率证据兑现。",
      subsidiaryLossText: (value) => value
        ? `重点子公司营业利润合计 ${formatNumberForReport(value)}，提示业务结构和研发投入仍需拆分复核。`
        : "重点子公司盈亏未能完整量化，需要继续复核年报子公司表。",
      baseSectionText: (baseProduct) => baseProduct
        ? [
            `- 年报确认：${baseProduct.name}收入 ${formatNumberForReport(baseProduct.revenue)}，毛利率 ${formatPercentForReport(baseProduct.grossMarginPct)}，收入占比 ${formatPercentForReport(baseProduct.revenueSharePct)}。`,
            "- 投资含义：成熟产品线决定估值底座，存储价格周期和新品导入决定估值弹性；若周期验证失败，应回到现金流底座定价。",
          ].join("\n")
        : null,
    }
  }
  return {
    kind: "generic",
    productPatterns: [],
    coreProductPatterns: [],
    baseProductPatterns: [],
    focusSubsidiaryPatterns: [],
    coreProductName: "高弹性业务线",
    coreShortName: "高弹性业务",
    baseProductName: "成熟业务底座",
    baseSectionTitle: "## 五、核心业务与现金流底座",
    baseSectionMissing: "- 未从公告表格中稳定抽出成熟业务底座，需人工复核。",
    aspSectionTitle: "### 1.2 价格/毛利率线索",
    scenarioVolumeHeader: "2026E核心业务量",
    scenarioAspHeader: "2026E价格/毛利率",
    scenarioVolumeUnit: "",
    scenarioAspUnit: "",
    scenarioWorkbookVolume2026: "Core Business Volume 2026E",
    scenarioWorkbookAsp2026: "Core Business Price/Margin 2026E",
    scenarioWorkbookVolume2027: "Core Business Volume 2027E",
    scenarioWorkbookAsp2027: "Core Business Price/Margin 2027E",
    coreVariableText: "核心变量是收入增长、产品结构、毛利率修复、现金流和估值消化速度。",
    currentPositionText: "当前价格大致贴近基准情景，关键在于核心业务增长和毛利率验证。",
    coreMissingText: "核心业务线未能从公告表格中稳定拆出，需要人工复核。",
    aspNote: "若公告未披露销量，价格弹性只能作为毛利率和产品结构线索，不能强行反推单品 ASP。",
    techNotes: [
      "- 自动报告只把行业和同业资料作为 C 级或待验证判断，除非来自公告、投资者关系记录或公司官网的明确表述。",
      "- 外部资料默认进入乐观情景和验证清单，不进入基准估值。",
      "- 后续增强可以把官方 IR Q&A PDF/网页作为 A/B 证据抽取。",
    ],
    scenarioThesis: {
      pessimistic: "核心业务改善慢，估值难继续扩张。",
      base: "核心业务温和修复，成熟业务提供现金流底座。",
      optimistic: "产品结构和客户验证超预期，利润弹性释放。",
    },
    valuationSensitivityText: "估值对核心业务兑现速度高度敏感。",
    scenarioInterpretationText: "悲观情景代表兑现慢；基准情景代表按公告可验证路径推进；乐观情景需要客户、价格或结构证据得到独立验证。",
    sensitivityNote: "基准情景若目标价低于现价，说明市场已提前定价一部分弹性；乐观情景需要官方证据兑现。",
    subsidiaryLossText: () => "重点子公司盈亏未能完整量化，需要继续复核子公司表。",
    baseSectionText: (baseProduct) => baseProduct
      ? `- 年报确认：${baseProduct.name}收入 ${formatNumberForReport(baseProduct.revenue)}，毛利率 ${formatPercentForReport(baseProduct.grossMarginPct)}，收入占比 ${formatPercentForReport(baseProduct.revenueSharePct)}。`
      : null,
  }
}

function productLineRowsForReport(rows, profile = companyResearchProfile()) {
  const allRows = rows ?? []
  const productPatterns = profile.productPatterns ?? []
  const filtered = productPatterns.length
    ? allRows.filter((row) => productPatterns.some((pattern) => pattern.test(String(row.name ?? ""))))
    : []
  return filtered.length ? filtered : allRows.slice(0, 12)
}

function parseVolumeYiFromRow(row) {
  if (!row?.volume) return null
  const match = String(row.volume).match(/(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const raw = Number(match[1])
  if (!Number.isFinite(raw)) return null
  return String(row.volume).includes("万") ? raw / 10000 : raw / 100000000
}

function roundOrNull(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? null : roundMetric(Number(value), digits)
}

function latestAnnualIncomeRow(businessBreakdown) {
  return (businessBreakdown.historicalFinancials?.income ?? []).find((row) => row.reportType === "annual") ?? null
}

function buildCompanyResearchInsightModel({ company, businessBreakdown, evidencePack }) {
  const profile = companyResearchProfile(company)
  const metrics = businessBreakdown.keyMetrics ?? {}
  const productLines = businessBreakdown.productLines ?? []
  const carrier = findBusinessRow(productLines, profile.baseProductPatterns) ?? (profile.kind === "jiemei" ? null : productLines[1] ?? null)
  const film = findBusinessRow(productLines, profile.coreProductPatterns) ?? (profile.kind === "jiemei" ? null : productLines[0] ?? null)
  const other = findBusinessRow(productLines, /^其他$/)
  const annualIncome = latestAnnualIncomeRow(businessBreakdown)
  const baseNetProfit = annualIncome?.netProfit ?? metrics.netProfit ?? 0
  const marketValue = metrics.totalMarketValue ?? 0
  const close = metrics.close ?? null
  const shares = marketValue && close ? marketValue / close : null
  const filmVolumeYi = parseVolumeYiFromRow(film)
  const filmAsp = film?.asp ?? null
  const focusSubsidiaries = (businessBreakdown.subsidiaryProfit ?? []).filter((row) =>
    (profile.focusSubsidiaryPatterns ?? []).some((pattern) => pattern.test(String(row.name ?? row.subsidiary ?? ""))),
  )
  const guangdong = focusSubsidiaries[0] ?? null
  const tianjin = focusSubsidiaries[1] ?? null
  const filmSubsidiaryLoss = focusSubsidiaries
    .map((row) => row?.operatingProfit)
    .filter((value) => Number.isFinite(Number(value)))
    .reduce((sum, value) => sum + Number(value), 0)
  const scenarioNetProfit = {
    pessimistic2026: baseNetProfit ? baseNetProfit * 1.6 : null,
    base2026: baseNetProfit ? baseNetProfit * 2.2 : null,
    optimistic2026: baseNetProfit ? baseNetProfit * 2.8 : null,
    pessimistic2027: baseNetProfit ? baseNetProfit * 2.3 : null,
    base2027: baseNetProfit ? baseNetProfit * 3.6 : null,
    optimistic2027: baseNetProfit ? baseNetProfit * 6.1 : null,
  }
  const scenarios = [
    {
      name: "悲观",
      evidenceLevel: "B/C",
      thesis: profile.scenarioThesis.pessimistic,
      filmVolume2026: filmVolumeYi ? filmVolumeYi * 1.5 : null,
      filmAsp2026: filmAsp ? filmAsp * 1.15 : null,
      filmVolume2027: filmVolumeYi ? filmVolumeYi * 2.1 : null,
      filmAsp2027: filmAsp ? filmAsp * 1.35 : null,
      netProfit2026: scenarioNetProfit.pessimistic2026,
      netProfit2027: scenarioNetProfit.pessimistic2027,
      targetPe2027: 30,
    },
    {
      name: "基准",
      evidenceLevel: "B/C",
      thesis: profile.scenarioThesis.base,
      filmVolume2026: filmVolumeYi ? filmVolumeYi * 1.8 : null,
      filmAsp2026: filmAsp ? Math.max(filmAsp * 1.35, 1.6) : null,
      filmVolume2027: filmVolumeYi ? filmVolumeYi * 2.9 : null,
      filmAsp2027: filmAsp ? Math.max(filmAsp * 1.6, 1.9) : null,
      netProfit2026: scenarioNetProfit.base2026,
      netProfit2027: scenarioNetProfit.base2027,
      targetPe2027: 40,
    },
    {
      name: "乐观",
      evidenceLevel: "C/待验证",
      thesis: profile.scenarioThesis.optimistic,
      filmVolume2026: filmVolumeYi ? filmVolumeYi * 2.1 : null,
      filmAsp2026: filmAsp ? Math.max(filmAsp * 1.6, 2.0) : null,
      filmVolume2027: filmVolumeYi ? filmVolumeYi * 3.8 : null,
      filmAsp2027: filmAsp ? Math.max(filmAsp * 2.2, 2.8) : null,
      netProfit2026: scenarioNetProfit.optimistic2026,
      netProfit2027: scenarioNetProfit.optimistic2027,
      targetPe2027: 45,
    },
  ].map((scenario) => {
    const targetMarketValue = scenario.netProfit2027 == null ? null : scenario.netProfit2027 * scenario.targetPe2027
    const targetPrice = targetMarketValue != null && shares ? targetMarketValue / shares : null
    return {
      ...scenario,
      targetMarketValue,
      targetPrice,
      upsidePct: targetPrice != null && close ? (targetPrice / close - 1) * 100 : null,
      impliedPe2026: scenario.netProfit2026 && marketValue ? marketValue / scenario.netProfit2026 : null,
      impliedPe2027: scenario.netProfit2027 && marketValue ? marketValue / scenario.netProfit2027 : null,
    }
  })
  const webEvidence = evidencePack?.tavily?.results ?? []
  return {
    profile,
    company,
    carrier,
    film,
    baseProduct: carrier,
    coreProduct: film,
    other,
    annualIncome,
    marketValue,
    close,
    shares,
    baseNetProfit,
    filmVolumeYi,
    filmAsp,
    guangdong,
    tianjin,
    filmSubsidiaryLoss,
    scenarios,
    officialDocumentCount: businessBreakdown.productLines?.filter((row) => row.sourceType === "annual_report").length ?? 0,
    webEvidenceCount: webEvidence.length,
  }
}

function buildEvidenceConfidenceRows({ documentExtract, evidencePack }) {
  const docs = (documentExtract.documents ?? []).map((doc) => ({
    来源: doc.title,
    可信度: doc.type === "annual_report" || doc.type === "semiannual_report" || doc.type === "quarterly_report" ? "A 一手公告" : "A 官方公告",
    用途: doc.type === "annual_report" ? "年度基准模型、产品/毛利率/在建工程" : doc.type === "semiannual_report" ? "子公司与中期经营补充" : "事项验证",
  }))
  const web = (evidencePack?.tavily?.results ?? []).slice(0, 3).map((item) => ({
    来源: item.title || item.query || "Web evidence",
    可信度: "C 外部资料",
    用途: "技术能力、同业、供应链辅助判断，不进入基准事实",
  }))
  return [...docs, ...web]
}

function scenarioMarkdownTable(scenarios, close, profile = companyResearchProfile()) {
  const volumeHeader = profile.scenarioVolumeHeader ?? "2026E核心业务量"
  const aspHeader = profile.scenarioAspHeader ?? "2026E价格/毛利率"
  return markdownTable(
    ["情景", volumeHeader, aspHeader, "2027E净利", "2027E目标PE", "目标价", "较当前", "证据等级"],
    scenarios.map((item) => ({
      情景: item.name,
      [volumeHeader]: item.filmVolume2026 == null ? "n/a" : `${roundMetric(item.filmVolume2026, 2)}${profile.scenarioVolumeUnit ?? ""}`,
      [aspHeader]: item.filmAsp2026 == null ? "n/a" : `${roundMetric(item.filmAsp2026, 2)}${profile.scenarioAspUnit ?? ""}`,
      "2027E净利": formatYi(item.netProfit2027),
      "2027E目标PE": `${item.targetPe2027}x`,
      目标价: item.targetPrice == null ? "n/a" : `${roundMetric(item.targetPrice, 2)}元`,
      较当前: item.upsidePct == null ? "n/a" : `${roundMetric(item.upsidePct, 1)}%`,
      证据等级: item.evidenceLevel,
    })),
  )
}

function impliedPeMarkdownTable(scenarios) {
  return markdownTable(
    ["情景", "2026E隐含PE", "2027E隐含PE", "含义"],
    scenarios.map((item) => ({
      情景: item.name,
      "2026E隐含PE": item.impliedPe2026 == null ? "n/a" : `${roundMetric(item.impliedPe2026, 1)}x`,
      "2027E隐含PE": item.impliedPe2027 == null ? "n/a" : `${roundMetric(item.impliedPe2027, 1)}x`,
      含义: item.thesis,
    })),
  )
}

function buildExitSignalRows(profile = companyResearchProfile()) {
  if (profile.kind === "semiconductor_memory") {
    return [
      { 指标: "存储产品收入/毛利率", 观测时间: "半年报/季报", 乐观信号: "收入恢复且毛利率持续改善", 悲观信号: "收入修复但毛利率停留低位" },
      { 指标: "库存与渠道", 观测时间: "季报/年报附注", 乐观信号: "库存周转改善、减值压力下降", 悲观信号: "库存继续累积或跌价准备扩大" },
      { 指标: "MCU/传感器韧性", 观测时间: "分产品表/IR", 乐观信号: "成熟产品收入稳定且毛利率不恶化", 悲观信号: "成熟产品同步下滑，现金流底座削弱" },
      { 指标: "研发/新品导入", 观测时间: "公告/IR/客户验证", 乐观信号: "官方明确新品量产或客户导入", 悲观信号: "长期只有外部传闻" },
      { 指标: "在建工程/资本开支", 观测时间: "资产负债表附注", 乐观信号: "转固后收入释放", 悲观信号: "高投入但收入/利润没有跟上" },
      { 指标: "重大事项", 观测时间: "公告原文", 乐观信号: "标的盈利、对价、协同清晰且可并表验证", 悲观信号: "长期只有外部线索，缺官方条款或财务影响" },
    ]
  }
  if (profile.kind === "jiemei") {
    return [
    { 指标: "薄膜材料季度收入", 观测时间: "半年报/季报", 乐观信号: "收入显著高于历史季度 run-rate", 悲观信号: "收入增速低于产能爬坡假设" },
    { 指标: "薄膜毛利率", 观测时间: "半年报/年报", 乐观信号: ">25% 并持续改善", 悲观信号: "<15% 或改善停滞" },
    { 指标: "ASP", 观测时间: "公告/年报量价表", 乐观信号: "混合 ASP 上行且销量同步增长", 悲观信号: "ASP 停留在低端产品价格带" },
    { 指标: "在建工程", 观测时间: "资产负债表附注", 乐观信号: "转固后收入释放", 悲观信号: "高余额、高进度但利润不释放" },
    { 指标: "高端客户/产品", 观测时间: "公告/IR/客户验证", 乐观信号: "明确批量或价格带披露", 悲观信号: "长期只有外部传闻" },
    { 指标: "重大事项", 观测时间: "公告原文", 乐观信号: "标的资产盈利、对价、协同清晰且可并表验证", 悲观信号: "长期只有外部线索，缺官方条款或财务影响" },
  ]
  }
  return [
    { 指标: "核心业务收入/毛利率", 观测时间: "半年报/季报", 乐观信号: "收入和毛利率同步改善", 悲观信号: "收入修复但利润率不改善" },
    { 指标: "现金流底座", 观测时间: "季报/年报", 乐观信号: "经营现金流和利润同步改善", 悲观信号: "利润增长但现金流持续背离" },
    { 指标: "客户/产品验证", 观测时间: "公告/IR/客户验证", 乐观信号: "官方明确批量或价格带披露", 悲观信号: "长期只有外部传闻" },
    { 指标: "资本开支", 观测时间: "资产负债表附注", 乐观信号: "转固后收入释放", 悲观信号: "高投入但收入/利润没有跟上" },
  ]
}

function buildValuationSensitivityRows(insight) {
  const peLevels = [25, 30, 35, 40, 45, 50]
  const scenarios = ["悲观", "基准", "乐观"].map((name) => insight.scenarios.find((row) => row.name === name)).filter(Boolean)
  return peLevels.map((pe) => {
    const row = { PE: `${pe}x` }
    for (const scenario of scenarios) {
      const targetMarketValue = scenario.netProfit2027 == null ? null : scenario.netProfit2027 * pe
      const targetPrice = targetMarketValue != null && insight.shares ? targetMarketValue / insight.shares : null
      row[`${scenario.name}目标价`] = targetPrice == null ? "n/a" : `${roundMetric(targetPrice, 2)}元`
      row[`${scenario.name}市值`] = targetMarketValue == null ? "n/a" : formatNumberForReport(targetMarketValue)
      if (scenario.name === "基准") {
        row["基准较当前"] = targetPrice != null && insight.close ? `${roundMetric((targetPrice / insight.close - 1) * 100, 1)}%` : "n/a"
      }
    }
    return row
  })
}

function buildValidationChecklistRows({ insight, businessBreakdown }) {
  const profile = insight.profile ?? companyResearchProfile(insight.company)
  const corporateAction = (businessBreakdown.corporateActions ?? []).find((row) => row.terms?.targetName)
  if (profile.kind === "semiconductor_memory") {
    return [
      {
        事项: "存储产品收入与毛利率",
        当前证据: insight.coreProduct ? `${formatNumberForReport(insight.coreProduct.revenue)}收入，毛利率${formatPercentForReport(insight.coreProduct.grossMarginPct)}` : "manual_needed",
        下一步数据: "半年报/年报分产品收入、毛利率和库存附注",
        乐观确认: "收入恢复且毛利率连续改善",
        证伪信号: "收入恢复但毛利率低位停滞或库存减值扩大",
        责任状态: insight.coreProduct ? "已抽取基准，等待下一期复核" : "manual_needed",
      },
      {
        事项: "MCU/传感器现金流底座",
        当前证据: insight.baseProduct ? `${formatNumberForReport(insight.baseProduct.revenue)}收入，毛利率${formatPercentForReport(insight.baseProduct.grossMarginPct)}` : "manual_needed",
        下一步数据: "分产品表、IR 对下游需求和价格的官方说明",
        乐观确认: "成熟产品收入稳定且毛利率不恶化",
        证伪信号: "成熟产品同步下滑，底座削弱",
        责任状态: insight.baseProduct ? "已抽取基准，等待下一期复核" : "manual_needed",
      },
      {
        事项: "库存去化与跌价准备",
        当前证据: (businessBreakdown.historicalFinancials?.balance ?? []).some((row) => row.inventories != null) ? "已拉取资产负债表库存字段，需附注复核" : "manual_needed",
        下一步数据: "存货附注、跌价准备、库存周转天数",
        乐观确认: "库存周转改善，跌价准备压力下降",
        证伪信号: "库存继续累积或跌价准备扩大",
        责任状态: "cross_check",
      },
      {
        事项: "在建工程转固与折旧压力",
        当前证据: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取在建工程项目和进度" : "manual_needed",
        下一步数据: "资产负债表附注、在建工程明细、固定资产折旧",
        乐观确认: "转固后收入释放快于折旧压力",
        证伪信号: "高进度项目转固后收入/利润没有跟上",
        责任状态: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取项目，需跟踪转固" : "manual_needed",
      },
      {
        事项: "收购/投资事项",
        当前证据: corporateAction?.terms?.targetName ? `${corporateAction.terms.targetName}；${corporateAction.terms.priceStatus ?? "作价待定"}` : "manual_needed",
        下一步数据: "公告原文、基金/并购标的、审计评估、并表节奏",
        乐观确认: "标的盈利、作价、协同和并表节奏清晰",
        证伪信号: "长期只有进展公告，缺少财务影响",
        责任状态: corporateAction?.terms?.targetName ? "已抽取条款，等待后续公告" : "manual_needed",
      },
      {
        事项: "新品/客户/国产替代验证",
        当前证据: `${businessBreakdown.technicalAndIndustryEvidence?.length ?? 0} 条 C 级外部资料`,
        下一步数据: "官方 IR、公告、客户认证或批量供货披露",
        乐观确认: "官方明确新品量产、客户导入或价格改善",
        证伪信号: "长期只有外部资料或研报表述，没有官方验证",
        责任状态: "C 级线索，不能进入基准模型",
      },
    ]
  }
  if (profile.kind !== "jiemei") {
    return [
      {
        事项: "核心业务收入与毛利率",
        当前证据: insight.coreProduct ? `${formatNumberForReport(insight.coreProduct.revenue)}收入，毛利率${formatPercentForReport(insight.coreProduct.grossMarginPct)}` : "manual_needed",
        下一步数据: "半年报/年报分产品收入和毛利率表",
        乐观确认: "收入和毛利率同步改善",
        证伪信号: "收入放量但毛利率停留低位或继续下滑",
        责任状态: insight.coreProduct ? "已抽取基准，等待下一期复核" : "manual_needed",
      },
      {
        事项: "成熟业务现金流底座",
        当前证据: insight.baseProduct ? `${formatNumberForReport(insight.baseProduct.revenue)}收入，毛利率${formatPercentForReport(insight.baseProduct.grossMarginPct)}` : "manual_needed",
        下一步数据: "分产品表、现金流量表、客户/价格官方说明",
        乐观确认: "成熟业务收入稳定且现金流改善",
        证伪信号: "利润增长但现金流持续背离",
        责任状态: insight.baseProduct ? "已抽取基准，等待下一期复核" : "manual_needed",
      },
      {
        事项: "在建工程转固与折旧压力",
        当前证据: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取在建工程项目和进度" : "manual_needed",
        下一步数据: "资产负债表附注、在建工程明细、固定资产折旧",
        乐观确认: "转固后收入释放快于折旧压力",
        证伪信号: "高进度项目转固后收入/利润没有跟上",
        责任状态: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取项目，需跟踪转固" : "manual_needed",
      },
      {
        事项: "客户/技术验证",
        当前证据: `${businessBreakdown.technicalAndIndustryEvidence?.length ?? 0} 条 C 级外部资料`,
        下一步数据: "官方 IR、公告、客户认证或批量供货披露",
        乐观确认: "官方明确客户、价格或批量供货",
        证伪信号: "长期只有外部资料或研报表述，没有官方验证",
        责任状态: "C 级线索，不能进入基准模型",
      },
    ]
  }
  return [
    {
      事项: "薄膜材料收入与毛利率",
      当前证据: insight.film ? `${formatNumberForReport(insight.film.revenue)}收入，毛利率${formatPercentForReport(insight.film.grossMarginPct)}` : "manual_needed",
      下一步数据: "半年报/年报分产品收入和毛利率表",
      乐观确认: "收入增速继续高于公司整体，毛利率持续改善",
      证伪信号: "收入放量但毛利率停留低位或继续下滑",
      责任状态: insight.film ? "已抽取基准，等待下一期复核" : "manual_needed",
    },
    {
      事项: "薄膜 ASP 与销量",
      当前证据: insight.film?.asp == null ? "manual_needed" : `${insight.film.volume ?? "n/a"}，ASP ${insight.film.asp}${insight.film.aspUnit ?? ""}`,
      下一步数据: "年报产销量表、IR 对高端产品价格带的官方说明",
      乐观确认: "销量和混合 ASP 同时上行",
      证伪信号: "只有销量增长，ASP 仍在低端价格带",
      责任状态: insight.film?.asp == null ? "manual_needed" : "已推算，需口径复核",
    },
    {
      事项: "广东/天津薄膜子公司亏损修复",
      当前证据: insight.filmSubsidiaryLoss ? `营业利润合计 ${formatNumberForReport(insight.filmSubsidiaryLoss)}` : "manual_needed",
      下一步数据: "半年报/年报主要子公司盈亏表",
      乐观确认: "亏损明显收窄或转正",
      证伪信号: "收入增长但子公司仍扩大亏损",
      责任状态: insight.filmSubsidiaryLoss ? "已抽取基准，等待下一期复核" : "manual_needed",
    },
    {
      事项: "在建工程转固与折旧压力",
      当前证据: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取在建工程项目和进度" : "manual_needed",
      下一步数据: "资产负债表附注、在建工程明细、固定资产折旧",
      乐观确认: "转固后收入释放快于折旧压力",
      证伪信号: "高进度项目转固后收入/利润没有跟上",
      责任状态: (businessBreakdown.capex ?? []).some((row) => row.status === "extracted") ? "已抽取项目，需跟踪转固" : "manual_needed",
    },
    {
      事项: "收购/重组期权",
      当前证据: corporateAction?.terms?.targetName ? `${corporateAction.terms.targetName}；${corporateAction.terms.priceStatus ?? "作价待定"}` : "manual_needed",
      下一步数据: "重组报告书、审计评估报告、交易价格、业绩承诺",
      乐观确认: "标的盈利、作价、协同和并表节奏清晰",
      证伪信号: "审计评估迟迟不落地，或交易价格/业绩承诺低于预期",
      责任状态: corporateAction?.terms?.targetName ? "已抽取预案条款，等待正式报告书" : "manual_needed",
    },
    {
      事项: "高端客户/技术验证",
      当前证据: `${businessBreakdown.technicalAndIndustryEvidence?.length ?? 0} 条 C 级外部资料`,
      下一步数据: "官方 IR、公告、客户认证或批量供货披露",
      乐观确认: "官方明确高端 MLCC/客户/批量供货",
      证伪信号: "长期只有外部资料或研报表述，没有官方验证",
      责任状态: "C 级线索，不能进入基准模型",
    },
  ]
}

function buildDeepCompanyReportMarkdown({ company, ledger, documentExtract, businessBreakdown, evidencePack, wikiCandidatesMarkdown, generatedAt }) {
  const metrics = businessBreakdown.keyMetrics ?? {}
  const insight = buildCompanyResearchInsightModel({ company, businessBreakdown, evidencePack })
  const profile = insight.profile ?? companyResearchProfile(company)
  const reportProductLines = productLineRowsForReport(businessBreakdown.productLines ?? [], profile)
  const productRows = reportProductLines.map((row) => ({
    业务或产品: row.name ?? row.product ?? row.segment ?? "n/a",
    收入: row.revenue == null ? "manual_needed" : formatNumberForReport(row.revenue),
    成本: row.cost == null ? "" : formatNumberForReport(row.cost),
    收入占比: row.revenueSharePct == null ? "" : `${roundMetric(row.revenueSharePct, 2)}%`,
    毛利率: row.grossMarginPct == null ? "manual_needed" : `${roundMetric(row.grossMarginPct, 2)}%`,
    收入同比: row.yoyRevenuePct == null ? "" : `${roundMetric(row.yoyRevenuePct, 2)}%`,
    销量: row.volume ?? "manual_needed",
    ASP: row.asp == null ? "manual_needed" : `${row.asp}${row.aspUnit ? ` ${row.aspUnit}` : ""}`,
    状态: row.status ?? "n/a",
    页码: row.sourcePages?.join(",") ?? row.sourcePage ?? "",
    来源: row.sourceTitle ?? row.source ?? "n/a",
  }))
  const subsidiaryRows = (businessBreakdown.subsidiaryProfit ?? []).map((row) => ({
    子公司: row.name ?? row.subsidiary ?? "n/a",
    总资产: row.totalAssets == null ? "" : formatNumberForReport(row.totalAssets),
    净资产: row.netAssets == null ? "" : formatNumberForReport(row.netAssets),
    收入: row.revenue == null ? "manual_needed" : formatNumberForReport(row.revenue),
    营业利润: row.operatingProfit == null ? "" : formatNumberForReport(row.operatingProfit),
    净利润: row.netProfit == null ? "manual_needed" : formatNumberForReport(row.netProfit),
    状态: row.status ?? "n/a",
    页码: row.sourcePage ?? "",
    来源: row.sourceTitle ?? row.source ?? "n/a",
  }))
  const capexRows = (businessBreakdown.capex ?? []).map((row) => ({
    项目: row.name ?? row.project ?? "n/a",
    预算: row.budget == null ? "" : formatNumberForReport(row.budget),
    期末余额: row.closingBalance == null ? (row.amount == null ? "manual_needed" : formatNumberForReport(row.amount)) : formatNumberForReport(row.closingBalance),
    工程进度: row.progressPct == null ? "" : `${roundMetric(row.progressPct, 2)}%`,
    状态: row.status ?? "n/a",
    页码: row.sourcePage ?? "",
    来源: row.sourceTitle ?? row.source ?? "n/a",
    说明: row.reason ?? "",
  }))
  const incomeRows = (businessBreakdown.historicalFinancials?.income ?? []).slice(0, 6).map((row) => ({
    期间: row.periodLabel,
    收入: formatNumberForReport(row.revenue),
    归母净利润: formatNumberForReport(row.netProfit),
    经营利润: formatNumberForReport(row.operatingProfit),
    报告类型: row.reportType,
  }))
  const industryRows = (businessBreakdown.technicalAndIndustryEvidence ?? []).slice(0, 8).map((row) => ({
    主题: row.query ?? "",
    标题: row.title ?? "",
    证据等级: row.evidenceLevel,
    链接: row.url ?? "",
  }))
  const corporateActionRows = (businessBreakdown.corporateActions ?? []).map((row) => ({
    事项: row.title ?? "n/a",
    日期: row.date ?? "",
    类型: row.type ?? "",
    状态: row.status ?? "",
    证据等级: row.evidenceLevel ?? "",
    来源: row.source ?? "",
    页码或链接: row.pages || row.filePath || "",
    摘要: row.summary ?? "",
  }))
  const termLabels = {
    transactionForm: "交易形式",
    transactionOverview: "交易方案简介",
    targetName: "交易标的",
    targetBusiness: "标的主营业务",
    targetIndustry: "标的所属行业",
    counterparties: "交易对方",
    priceStatus: "交易价格状态",
    performanceCommitment: "业绩承诺状态",
    auditValuationStatus: "审计/评估状态",
  }
  const corporateTermRows = (businessBreakdown.corporateActions ?? []).flatMap((row) =>
    Object.entries(row.terms ?? {}).map(([field, value]) => ({
      事项: row.title ?? "",
      字段: termLabels[field] ?? field,
      内容: value,
      证据等级: row.evidenceLevel ?? "",
      状态: row.status ?? "",
    })),
  )
  const exitSignalRows = buildExitSignalRows(profile)
  const valuationSensitivityRows = buildValuationSensitivityRows(insight)
  const validationChecklistRows = buildValidationChecklistRows({ insight, businessBreakdown })
  const manualItems = [
    ...(businessBreakdown.productLines ?? []).filter((row) => row.status === "manual_needed").map((row) => row.name ?? "产品拆分"),
    ...(businessBreakdown.subsidiaryProfit ?? []).filter((row) => row.status === "manual_needed").map((row) => row.name ?? "子公司盈亏"),
    ...(businessBreakdown.capacity ?? []).filter((row) => row.status === "manual_needed").map((row) => row.name ?? "产能/ASP"),
  ]
  const confidenceRows = buildEvidenceConfidenceRows({ documentExtract, evidencePack })
  const currentPosition = insight.scenarios.find((item) => item.name === "基准")
  const coreVerdict = currentPosition?.targetPrice != null && metrics.close
    ? (currentPosition.targetPrice > metrics.close * 1.15 ? "基准情景仍有上行空间，但需要后续经营验证。" : currentPosition.targetPrice < metrics.close * 0.9 ? "当前价格已接近或高于基准情景，主要价值来自乐观期权。" : profile.currentPositionText)
    : "估值位置需要股价/市值和情景净利润继续校验。"
  const filmLossText = profile.subsidiaryLossText(insight.filmSubsidiaryLoss)
  const coreProduct = insight.coreProduct
  const baseProduct = insight.baseProduct
  const baseSectionText = profile.baseSectionText(baseProduct) ?? profile.baseSectionMissing
  const riskRows = profile.kind === "semiconductor_memory"
    ? [
        { 风险: "存储价格周期修复失败", 量化影响: "基准/乐观情景下修，估值回到成熟业务底座定价", 触发条件: "存储收入或毛利率连续低于模型假设" },
        { 风险: "库存去化慢或跌价压力", 量化影响: "毛利率和现金流承压", 触发条件: "库存继续累积或跌价准备扩大" },
        { 风险: "新品/客户验证慢", 量化影响: "乐观期权折价或归零", 触发条件: "官方公告/IR 持续缺少量产和客户导入证据" },
        { 风险: "C 级资料无法证实", 量化影响: "情景假设降级", 触发条件: "外部资料与公告表格冲突或没有官方确认" },
      ]
    : profile.kind === "jiemei"
      ? [
          { 风险: "薄膜量价双升失败", 量化影响: "基准/乐观情景下修，估值回到载带现金牛定价", 触发条件: "薄膜收入或毛利率连续低于模型假设" },
          { 风险: "高端产品验证慢", 量化影响: "乐观期权折价或归零", 触发条件: "官方公告/IR 持续停留在验证中，缺少批量供货证据" },
          { 风险: "在建工程转固压力", 量化影响: "折旧压制利润释放", 触发条件: "在建工程余额高、工程进度高但收入不提速" },
          { 风险: "C 级资料无法证实", 量化影响: "情景假设降级", 触发条件: "外部资料与公告表格冲突或没有官方确认" },
        ]
      : [
          { 风险: "核心业务兑现失败", 量化影响: "基准/乐观情景下修", 触发条件: "收入或毛利率连续低于模型假设" },
          { 风险: "现金流验证不足", 量化影响: "估值折价", 触发条件: "利润增长但经营现金流持续背离" },
          { 风险: "客户/产品验证慢", 量化影响: "乐观期权折价或归零", 触发条件: "官方公告/IR 缺少批量供货证据" },
          { 风险: "C 级资料无法证实", 量化影响: "情景假设降级", 触发条件: "外部资料与公告表格冲突或没有官方确认" },
        ]
  return [
    `# ${company.stockName ?? company.stockInput} 深度公司研究底稿`,
    "",
    `- 生成时间：${generatedAt}`,
    `- 股票代码：${company.tsCode ?? company.stockCode ?? "n/a"}`,
    `- 行业：${company.industry ?? "n/a"}`,
    "- 输出性质：可复核深度底稿，不自动写入正式 wiki。",
    "- 报告方法：以公告和结构化财务为基准，外部资料仅用于技术定位、催化和情景假设。",
    "",
    "## 自动重建说明",
    "",
    "- 本版本从 CNINFO PDF 原文表格、Tushare 财务快照、Tavily/Web 资料和既有 wiki 检索重建公司研究底稿。",
    "- 基准事实只采用 A/B 级证据；C 级资料进入技术能力、催化、乐观情景或待验证清单。",
    "- 和人工 DOCX 相比，本报告把未经核实的调研、路演、群聊数据降级为待验证，不直接进入基准模型。",
    "",
    "## 数据拉取确认",
    "",
    markdownTable(
      ["数据项", "来源", "工具", "状态", "完成时间", "用途", "可信等级"],
      ledger.rows.map((row) => ({
        数据项: row.dataItem,
        来源: row.source,
        工具: row.tool,
        状态: row.status,
        完成时间: row.completedAt,
        用途: row.purpose,
        可信等级: row.evidenceLevel,
      })),
    ),
    "",
    "## 数据可信度说明",
    "",
    markdownTable(["来源", "可信度", "用途"], confidenceRows),
    "",
    "## 开篇结论",
    "",
    `- 核心判断：${coreVerdict}`,
    `- 基础事实：最新报告期 ${formatPeriod(metrics.latestPeriod)}，收入 ${formatNumberForReport(metrics.revenue)}，归母净利润 ${formatNumberForReport(metrics.netProfit)}，毛利率 ${metrics.grossMarginPct == null ? "n/a" : `${roundMetric(metrics.grossMarginPct, 2)}%`}。`,
    `- 估值状态：股价 ${metrics.close == null ? "n/a" : `${roundMetric(metrics.close, 2)}元`}，总市值 ${formatNumberForReport(metrics.totalMarketValue)}，PE TTM ${metrics.peTtm == null ? "n/a" : roundMetric(metrics.peTtm, 2)}，PB ${metrics.pb == null ? "n/a" : roundMetric(metrics.pb, 2)}。`,
    `- 主导矛盾：${coreProduct ? `${coreProduct.name ?? profile.coreProductName}收入 ${formatNumberForReport(coreProduct.revenue)}、毛利率 ${formatPercentForReport(coreProduct.grossMarginPct)}，${coreProduct.asp == null ? "价格/ASP 口径需复核" : `混合 ASP ${coreProduct.asp} ${coreProduct.aspUnit ?? ""}`}，决定未来弹性。` : profile.coreMissingText}`,
    "- 证据边界：A/B 级事实进入基础模型；C 级网页/研报证据只用于技术定位和乐观情景；manual_needed 不进入估值。",
    manualItems.length ? `- 主要缺口：${manualItems.slice(0, 6).join("、")} 仍需人工复核。` : "- 主要缺口：暂无强制人工缺口，但仍需复核公告原表。",
    "",
    "## 一、业务地图（公告确认数据）",
    "",
    "### 1.1 分产品收入与毛利率",
    "",
    markdownTable(["业务或产品", "收入", "成本", "收入占比", "毛利率", "收入同比", "销量", "ASP", "状态", "页码", "来源"], productRows),
    "",
    profile.aspSectionTitle,
    "",
    coreProduct
      ? [
          `- 年报直接数据：${coreProduct.name ?? profile.coreProductName}收入 ${formatNumberForReport(coreProduct.revenue)}，销量 ${coreProduct.volume ?? "n/a"}，反推/观察口径 ${coreProduct.asp == null ? "manual_needed" : `${coreProduct.asp}${coreProduct.aspUnit ? ` ${coreProduct.aspUnit}` : ""}`}。`,
          `- 口径说明：${profile.aspNote}`,
          "- 建模含义：基准情景看结构升级和利用率改善；乐观情景必须由高端客户、高 ASP 产品或明确公告验证。",
        ].join("\n")
      : "- 未抽到可反推 ASP 的销量/收入组合，需人工复核。",
    "",
    "### 1.3 子公司盈亏核实",
    "",
    filmLossText,
    "",
    "## 子公司盈亏核实",
    "",
    markdownTable(["子公司", "总资产", "净资产", "收入", "营业利润", "净利润", "状态", "页码", "来源"], subsidiaryRows),
    "",
    "## 二、技术能力与同业/海外对标",
    "",
    profile.techNotes.join("\n"),
    "",
    industryRows.length
      ? markdownTable(["主题", "标题", "证据等级", "链接"], industryRows)
      : "- 暂无 C 级外部技术/同业证据。",
    "",
    "## 三、产能规划与折旧压力",
    "",
    markdownTable(["项目", "预算", "期末余额", "工程进度", "状态", "页码", "来源", "说明"], capexRows),
    "",
    "## 四、历史财务重建",
    "",
    markdownTable(["期间", "收入", "归母净利润", "经营利润", "报告类型"], incomeRows),
    "",
    profile.baseSectionTitle,
    "",
    baseSectionText,
    "",
    "## 六、重大事项/收购期权价值",
    "",
    markdownTable(["事项", "日期", "类型", "状态", "证据等级", "来源", "页码或链接", "摘要"], corporateActionRows),
    "",
    "### 6.1 预案关键条款自动抽取",
    "",
    corporateTermRows.length
      ? markdownTable(["事项", "字段", "内容", "证据等级", "状态"], corporateTermRows)
      : "- 未从官方重大事项 PDF 中稳定抽出交易条款，需人工打开预案原文复核。",
    "",
    "- 处理原则：官方公告 PDF 属于 A 级，可进入事项验证；外部资料或网页线索只能作为 C 级期权假设，不进入基准估值。",
    "- 若状态为 `manual_needed` 或 `announcement_only`，需要补下载/打开原 PDF 表格，确认交易标的、对价、利润、商誉和并表时间。",
    "",
    "## 七、三年财务模型（三情景）",
    "",
    "- 情景模型不是官方预测，而是把公告事实转成可讨论的买方底稿；基准只依赖 A/B 级事实锚点，C 级资料只改变乐观路径。",
    `- ${profile.coreVariableText}`,
    "",
    scenarioMarkdownTable(insight.scenarios, metrics.close, profile),
    "",
    "## 八、估值分析",
    "",
    impliedPeMarkdownTable(insight.scenarios),
    "",
    `- 当前市值 ${formatNumberForReport(metrics.totalMarketValue)}。若以 2027E 情景净利衡量，${profile.valuationSensitivityText}`,
    `- ${profile.scenarioInterpretationText}`,
    "",
    "## 九、PE/市值敏感性矩阵",
    "",
    markdownTable(["PE", "悲观目标价", "基准目标价", "乐观目标价", "基准较当前"], valuationSensitivityRows),
    "",
    "- 读法：敏感性矩阵不是预测结论，而是把 2027E 情景净利润和目标 PE 展开，帮助判断当前价格隐含了哪一种兑现路径。",
    `- ${profile.sensitivityNote}`,
    "",
    "## 十、核心风险",
    "",
    markdownTable(
      ["风险", "量化影响", "触发条件"],
      riskRows,
    ),
    "",
    "## 十一、退出信号体系",
    "",
    markdownTable(["指标", "观测时间", "乐观信号", "悲观信号"], exitSignalRows),
    "",
    "## 十二、验证清单",
    "",
    markdownTable(["事项", "当前证据", "下一步数据", "乐观确认", "证伪信号", "责任状态"], validationChecklistRows),
    "",
    "## 十三、研究边界声明",
    "",
    "- 本报告基于可核实的一手公告、结构化财务和已标级外部资料生成。",
    "- 没有页码、公告标题或结构化来源绑定的数字不会作为基准模型事实。",
    "- C/D 级资料可进入观察线索、催化和乐观情景，但不能替代公告表格。",
    "- 下一次更新触发：半年报/季报披露、官方 IR 明确高端产品批量、或重大收购事项进展。",
    "",
    "## wiki 写入候选",
    "",
    wikiCandidatesMarkdown.split("\n").slice(4, 24).join("\n"),
    "",
    "## PDF/表格抽取状态",
    "",
    markdownTable(
      ["文件", "状态", "抽取字符", "原始表数", "关键表数", "关键行数", "工具"],
      (documentExtract.documents ?? []).map((doc) => ({
        文件: doc.title,
        状态: doc.status,
        抽取字符: doc.extractedChars ?? 0,
        原始表数: doc.tables?.length ?? 0,
        关键表数: (doc.tables ?? []).filter((table) => table.type !== "other").length,
        关键行数: (doc.tables ?? []).filter((table) => table.type !== "other").reduce((sum, table) => sum + (table.rows?.length ?? 0), 0),
        工具: doc.extractionTool,
      })),
    ),
    "",
    "## 口径复核提示",
    "",
    "- `ASP` 若显示 `requires_review` 相关说明，表示它由收入和销量表推导，尚未把产品与销量单位完全确认为同一口径。",
    "- PDF 表格页码来自自动抽取页码，最终引用正式报告前仍建议打开原 PDF 对照。",
    "",
  ].join("\n")
}

function buildDeepReviewChecklist({ documentExtract, businessBreakdown }) {
  const items = []
  const corporateActionsByTitle = new Map((businessBreakdown.corporateActions ?? []).map((row) => [row.title, row]))
  for (const doc of documentExtract.documents ?? []) {
    if (doc.status !== "success" || (doc.tables?.length ?? 0) === 0) {
      if (isCorporateActionDocument(doc)) {
        const action = corporateActionsByTitle.get(doc.title)
        const termCount = Object.keys(action?.terms ?? {}).length
        items.push({
          item: doc.title,
          status: termCount > 0 ? "review_required" : "manual_needed",
          reason: termCount > 0
            ? "Corporate action terms were extracted; review original PDF for final price, audited financials, performance commitment and approval status."
            : "Official event PDF was cached, but key transaction terms were not machine-extracted.",
          evidenceLevel: "A",
        })
        continue
      }
      if (doc.type === "quarterly_report" || /摘要/.test(doc.title ?? "")) {
        items.push({
          item: doc.title,
          status: "review_optional",
          reason: "PDF text was cached; detailed annual-report table normalization is not required for the base model.",
          evidenceLevel: "A",
        })
        continue
      }
      items.push({
        item: doc.title,
        status: "manual_needed",
        reason: doc.issues?.join("; ") || "PDF table extraction not verified.",
        evidenceLevel: "A",
      })
    }
  }
  for (const section of ["productLines", "subsidiaryProfit", "capacity", "capex"]) {
    for (const row of businessBreakdown[section] ?? []) {
      if (row.status === "manual_needed") {
        items.push({
          item: row.name ?? section,
          status: "manual_needed",
          reason: row.reason ?? "Requires official table/text review.",
          evidenceLevel: row.evidenceLevel ?? "A",
        })
      }
    }
  }
  const insight = buildCompanyResearchInsightModel({ company: businessBreakdown.company, businessBreakdown, evidencePack: null })
  const validationRows = buildValidationChecklistRows({ insight, businessBreakdown })
  return [
    "# Deep Company Research Review Checklist",
    "",
    items.length
      ? markdownTable(["事项", "状态", "原因", "证据等级"], items.map((item) => ({
          事项: item.item,
          状态: item.status,
          原因: item.reason,
          证据等级: item.evidenceLevel,
        })))
      : "- No mandatory manual review items detected.",
    "",
    "## Validation Checklist",
    "",
    markdownTable(["事项", "当前证据", "下一步数据", "乐观确认", "证伪信号", "责任状态"], validationRows),
    "",
  ].join("\n")
}

function buildDeepCompanyWorkbookRows({ company, businessBreakdown, ledger, evidencePack }) {
  const metrics = businessBreakdown.keyMetrics ?? {}
  const revenue = metrics.revenue ?? 0
  const netProfit = metrics.netProfit ?? 0
  const pe = metrics.peTtm ?? 25
  const insight = buildCompanyResearchInsightModel({ company, businessBreakdown, evidencePack })
  const profile = insight.profile ?? companyResearchProfile(company)
  const productRows = (businessBreakdown.productLines ?? []).map((row) => [
    row.name ?? row.product ?? row.segment ?? "n/a",
    row.revenue ?? "",
    row.cost ?? "",
    row.revenueSharePct ?? "",
    row.grossMarginPct ?? "",
    row.yoyRevenuePct ?? "",
    row.volume ?? "",
    row.asp ?? "",
    row.aspUnit ?? "",
    row.aspStatus ?? "",
    row.status ?? "",
    row.evidenceLevel ?? "",
    row.sourcePages?.join(",") ?? row.sourcePage ?? "",
    row.sourceTitle ?? row.source ?? "",
  ])
  const capexRows = (businessBreakdown.capex ?? []).map((row) => [
    row.name ?? row.project ?? "n/a",
    row.budget ?? "",
    row.openingBalance ?? "",
    row.additions ?? "",
    row.transferredToFixedAssets ?? "",
    row.closingBalance ?? row.amount ?? "",
    row.progressPct ?? "",
    row.status ?? "",
    row.evidenceLevel ?? "",
    row.sourcePage ?? "",
    row.sourceTitle ?? row.source ?? "",
    row.reason ?? "",
  ])
  const scenarioRows = insight.scenarios.map((row) => [
    row.name,
    row.thesis,
    row.evidenceLevel,
    row.filmVolume2026 ?? "",
    row.filmAsp2026 ?? "",
    row.netProfit2026 ?? "",
    row.filmVolume2027 ?? "",
    row.filmAsp2027 ?? "",
    row.netProfit2027 ?? "",
    row.impliedPe2026 ?? "",
    row.impliedPe2027 ?? "",
    row.targetPe2027 ?? "",
    row.targetMarketValue ?? "",
    row.targetPrice ?? "",
    row.upsidePct ?? "",
  ])
  const valuationMatrixRows = buildValuationSensitivityRows(insight).map((row) => [
    row.PE,
    row["悲观目标价"] ?? "",
    row["悲观市值"] ?? "",
    row["基准目标价"] ?? "",
    row["基准市值"] ?? "",
    row["基准较当前"] ?? "",
    row["乐观目标价"] ?? "",
    row["乐观市值"] ?? "",
  ])
  const corporateRows = (businessBreakdown.corporateActions ?? []).map((row) => [
    row.title ?? "",
    row.date ?? "",
    row.type ?? "",
    row.status ?? "",
    row.evidenceLevel ?? "",
    row.source ?? "",
    row.pages ?? "",
    row.filePath ?? "",
    row.terms?.transactionForm ?? "",
    row.terms?.targetName ?? "",
    row.terms?.targetBusiness ?? "",
    row.terms?.targetIndustry ?? "",
    row.terms?.counterparties ?? "",
    row.terms?.priceStatus ?? "",
    row.terms?.performanceCommitment ?? "",
    row.summary ?? "",
  ])
  const exitRows = buildExitSignalRows(profile).map((row) => [row.指标, row.观测时间, row.乐观信号, row.悲观信号])
  const validationRows = buildValidationChecklistRows({ insight, businessBreakdown }).map((row) => [
    row.事项,
    row.当前证据,
    row.下一步数据,
    row.乐观确认,
    row.证伪信号,
    row.责任状态,
  ])
  return {
    Summary: [
      ["Deep Company Research Model", "", "", COMPANY_DEEP_TEMPLATE_VERSION],
      ["Company", company.stockName ?? company.stockInput],
      ["Stock", company.tsCode ?? company.stockCode ?? ""],
      ["Latest Period", metrics.latestPeriod ?? ""],
      ["Revenue", revenue],
      ["Net Profit", netProfit],
      ["Market Value", metrics.totalMarketValue ?? ""],
      ["PE TTM", metrics.peTtm ?? ""],
      ["Close", metrics.close ?? ""],
      ["Base 2027 Target Price", insight.scenarios.find((row) => row.name === "基准")?.targetPrice ?? ""],
    ],
    "Product Lines": [
      ["Product/Segment", "Revenue", "Cost", "Revenue Share %", "Gross Margin %", "Revenue YoY %", "Volume", "ASP", "ASP Unit", "ASP Status", "Status", "Evidence Level", "Page", "Source"],
      ...productRows,
    ],
    "Subsidiary P&L": [
      ["Subsidiary", "Registered Capital", "Total Assets", "Net Assets", "Revenue", "Operating Profit", "Net Profit", "Status", "Evidence Level", "Page", "Source"],
      ...(businessBreakdown.subsidiaryProfit ?? []).map((row) => [
        row.name ?? row.subsidiary ?? "n/a",
        row.registeredCapital ?? "",
        row.totalAssets ?? "",
        row.netAssets ?? "",
        row.revenue ?? "",
        row.operatingProfit ?? "",
        row.netProfit ?? "",
        row.status ?? "",
        row.evidenceLevel ?? "",
        row.sourcePage ?? "",
        row.sourceTitle ?? row.source ?? "",
      ]),
    ],
    Capex: [
      ["Project", "Budget", "Opening Balance", "Additions", "Transferred To Fixed Assets", "Closing Balance", "Progress %", "Status", "Evidence Level", "Page", "Source", "Note"],
      ...capexRows,
    ],
    Forecast: [
      ["Metric", "Y0", "Y1 Base", "Y2 Base", "Y3 Base"],
      ["Revenue", revenue, { f: "B2*1.08", t: "n" }, { f: "C2*1.10", t: "n" }, { f: "D2*1.10", t: "n" }],
      ["Net Margin", metrics.netMarginPct ? metrics.netMarginPct / 100 : 0.1, 0.1, 0.105, 0.11],
      ["Net Profit", netProfit, { f: "C2*C3", t: "n" }, { f: "D2*D3", t: "n" }, { f: "E2*E3", t: "n" }],
    ],
    Valuation: [
      ["Scenario", "Net Profit Y1", "Target PE", "Equity Value", "Evidence Rule"],
      ["Downside", { f: "Forecast!C4*0.85", t: "n" }, Math.max(10, pe * 0.65), { f: "B2*C2", t: "n" }, "A/B only"],
      ["Base", { f: "Forecast!C4", t: "n" }, Math.max(12, pe * 0.85), { f: "B3*C3", t: "n" }, "A/B only"],
      ["Upside", { f: "Forecast!C4*1.2", t: "n" }, Math.max(15, pe * 1.05), { f: "B4*C4", t: "n" }, "C only affects scenario"],
    ],
    Sensitivity: [
      ["PE / NP", "Downside", "Base", "Upside"],
      [Math.max(10, pe * 0.65), { f: "A2*Valuation!B2", t: "n" }, { f: "A2*Valuation!B3", t: "n" }, { f: "A2*Valuation!B4", t: "n" }],
      [Math.max(12, pe * 0.85), { f: "A3*Valuation!B2", t: "n" }, { f: "A3*Valuation!B3", t: "n" }, { f: "A3*Valuation!B4", t: "n" }],
      [Math.max(15, pe * 1.05), { f: "A4*Valuation!B2", t: "n" }, { f: "A4*Valuation!B3", t: "n" }, { f: "A4*Valuation!B4", t: "n" }],
    ],
    "Scenario Model": [
      ["Scenario", "Thesis", "Evidence Level", profile.scenarioWorkbookVolume2026, profile.scenarioWorkbookAsp2026, "Net Profit 2026E", profile.scenarioWorkbookVolume2027, profile.scenarioWorkbookAsp2027, "Net Profit 2027E", "Implied PE 2026E", "Implied PE 2027E", "Target PE 2027E", "Target Market Value", "Target Price", "Upside %"],
      ...scenarioRows,
    ],
    "Corporate Actions": [
      ["Title", "Date", "Type", "Status", "Evidence Level", "Source", "Pages", "File/URL", "Transaction Form", "Target", "Target Business", "Target Industry", "Counterparties", "Price Status", "Performance Commitment", "Summary"],
      ...corporateRows,
    ],
    "Valuation Matrix": [
      ["PE", "Downside Target Price", "Downside Market Value", "Base Target Price", "Base Market Value", "Base Upside %", "Upside Target Price", "Upside Market Value"],
      ...valuationMatrixRows,
    ],
    "Exit Signals": [
      ["Metric", "Observation Time", "Bullish Signal", "Bearish Signal"],
      ...exitRows,
    ],
    "Validation Checklist": [
      ["Item", "Current Evidence", "Next Data", "Bullish Confirmation", "Bearish Disproof", "Status"],
      ...validationRows,
    ],
    Evidence: [
      ["Data Item", "Source", "Tool", "Status", "Completed At", "Evidence Level"],
      ...ledger.rows.map((row) => [row.dataItem, row.source, row.tool, row.status, row.completedAt, row.evidenceLevel]),
    ],
  }
}

function modelPctDecimal(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.abs(n) > 1.5 ? n / 100 : n
}

function modelNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function fiscalYearFromPeriod(value) {
  const raw = String(value ?? "")
  const match = raw.match(/^(\d{4})/)
  return match ? Number(match[1]) : new Date().getFullYear()
}

function forecastYearLabels(latestPeriod) {
  const year = fiscalYearFromPeriod(latestPeriod)
  return [`${year}E`, `${year + 1}E`, `${year + 2}E`]
}

function sortFinancialRowsAsc(rows) {
  return [...(rows ?? [])].sort((a, b) => String(a.period ?? "").localeCompare(String(b.period ?? "")))
}

function deriveShareCountForModel(businessBreakdown) {
  const balanceRows = businessBreakdown.historicalFinancials?.balance ?? []
  const latestBalance = balanceRows[0] ?? {}
  const fromBalance = modelNumber(latestBalance.totalShare, null)
  if (fromBalance && fromBalance > 0) return fromBalance
  const metrics = businessBreakdown.keyMetrics ?? {}
  const marketValue = modelNumber(metrics.totalMarketValue, null)
  const close = modelNumber(metrics.close, null)
  if (marketValue && close && close > 0) return marketValue / close
  return null
}

function inferFinancialModelPack(company = {}, profile = companyResearchProfile(company)) {
  const text = [
    company.stockName,
    company.secName,
    company.stockInput,
    company.stockCode,
    company.tsCode,
    company.industry,
  ].filter(Boolean).join(" ")
  if (profile.kind === "jiemei") {
    return {
      kind: "electronic-materials",
      frameworkName: "电子材料量价产能模型",
      statementCore: "三表底座 + 分产品量价 + 产能/转固/折旧 + 子公司扭亏",
      defaultSegments: [
        { name: "载带/电子封装材料", role: "现金流底座", revenueShare: 0.62, gm: 0.32, growth: [0.06, 0.07, 0.07] },
        { name: "离型膜/电子级薄膜", role: "估值弹性", revenueShare: 0.26, gm: 0.22, growth: [0.18, 0.24, 0.20] },
        { name: "其他材料", role: "补充业务", revenueShare: 0.12, gm: 0.18, growth: [0.04, 0.05, 0.05] },
      ],
      operatingDrivers: ["销量", "ASP", "良率/稼动率", "产品结构", "子公司亏损收窄", "转固折旧"],
      valuationMethods: ["PE", "FCF", "P/S"],
      defaultAssumptions: { opexRatio: 0.18, taxRate: 0.15, capexPct: 0.12, daPct: 0.06, nwcPct: 0.18, targetPe: 35, evFcf: 28, ps: 4.5, discountRate: 0.1 },
      externalDataNeeds: [
        { item: "MLCC 离型膜 ASP/客户认证", preferredSource: "公司公告/IR/客户验证", requiredFor: "乐观情景", status: "manual_input" },
        { item: "MLCC/薄膜行业价格与需求", preferredSource: "CINNO/TrendForce/产业链调研", requiredFor: "价格弹性", status: "provider_needed" },
        { item: "一致预期净利润", preferredSource: "Wind/iFinD/Choice", requiredFor: "估值交叉验证", status: "provider_needed" },
      ],
    }
  }
  if (profile.kind === "semiconductor_memory") {
    return {
      kind: "semiconductor-memory",
      frameworkName: "半导体周期/产品线模型",
      statementCore: "三表底座 + 存储价格周期 + MCU/传感器底座 + 库存/现金流",
      defaultSegments: [
        { name: "存储芯片/NOR Flash/DRAM", role: "周期弹性", revenueShare: 0.52, gm: 0.34, growth: [0.14, 0.12, 0.08] },
        { name: "微控制器 MCU", role: "现金流底座", revenueShare: 0.28, gm: 0.38, growth: [0.08, 0.08, 0.07] },
        { name: "传感器/模拟及其他", role: "结构补充", revenueShare: 0.20, gm: 0.30, growth: [0.07, 0.08, 0.08] },
      ],
      operatingDrivers: ["存储价格指数", "出货量", "库存周转", "产品结构", "晶圆/封测成本", "研发费用率"],
      valuationMethods: ["PE", "FCF", "P/S"],
      defaultAssumptions: { opexRatio: 0.22, taxRate: 0.15, capexPct: 0.09, daPct: 0.05, nwcPct: 0.22, targetPe: 42, evFcf: 35, ps: 7, discountRate: 0.11 },
      externalDataNeeds: [
        { item: "DRAM/NOR Flash 价格指数", preferredSource: "TrendForce/DRAMeXchange/CFM", requiredFor: "周期弹性", status: "provider_needed" },
        { item: "渠道库存与交期", preferredSource: "产业链调研/券商数据库", requiredFor: "毛利率修复验证", status: "manual_input" },
        { item: "一致预期 EPS/净利润", preferredSource: "Wind/iFinD/Choice", requiredFor: "估值交叉验证", status: "provider_needed" },
      ],
    }
  }
  if (/银行|证券|保险|金融/.test(text)) {
    return {
      kind: "financial-services",
      frameworkName: "金融机构资产负债/资本约束模型",
      statementCore: "净息差/手续费/信用成本/资本充足率，三表口径不同于制造业",
      defaultSegments: [
        { name: "净利息收入", role: "收入底座", revenueShare: 0.58, gm: 0.55, growth: [0.03, 0.04, 0.04] },
        { name: "手续费及佣金", role: "弹性收入", revenueShare: 0.25, gm: 0.62, growth: [0.06, 0.07, 0.07] },
        { name: "投资及其他收益", role: "波动项", revenueShare: 0.17, gm: 0.45, growth: [0.02, 0.03, 0.03] },
      ],
      operatingDrivers: ["生息资产", "净息差", "信用成本", "手续费率", "资本充足率", "拨备覆盖率"],
      valuationMethods: ["P/B", "PE", "ROE spread"],
      defaultAssumptions: { opexRatio: 0.28, taxRate: 0.25, capexPct: 0.01, daPct: 0.01, nwcPct: 0.05, targetPe: 8, evFcf: 10, ps: 2, discountRate: 0.1 },
      externalDataNeeds: [
        { item: "生息资产/净息差/不良率", preferredSource: "年报附注/Wind/iFinD", requiredFor: "金融框架", status: "provider_needed" },
        { item: "资本充足率和拨备覆盖率", preferredSource: "年报/监管指标库", requiredFor: "估值安全边际", status: "provider_needed" },
      ],
    }
  }
  if (/医药|创新药|医疗|生物/.test(text)) {
    return {
      kind: "healthcare-pharma",
      frameworkName: "医药管线/产品生命周期模型",
      statementCore: "三表底座 + 核心产品放量 + 管线概率调整 + 研发费用率",
      defaultSegments: [
        { name: "已上市核心产品", role: "现金流底座", revenueShare: 0.60, gm: 0.72, growth: [0.10, 0.10, 0.08] },
        { name: "新品/适应症扩展", role: "估值弹性", revenueShare: 0.25, gm: 0.76, growth: [0.22, 0.26, 0.22] },
        { name: "服务及其他", role: "补充业务", revenueShare: 0.15, gm: 0.45, growth: [0.06, 0.06, 0.06] },
      ],
      operatingDrivers: ["患者数", "渗透率", "价格/医保", "管线成功率", "销售费用率", "研发费用率"],
      valuationMethods: ["PE", "rNPV", "P/S"],
      defaultAssumptions: { opexRatio: 0.36, taxRate: 0.15, capexPct: 0.06, daPct: 0.03, nwcPct: 0.18, targetPe: 32, evFcf: 24, ps: 5, discountRate: 0.12 },
      externalDataNeeds: [
        { item: "核心产品销量/中标价格/医保限制", preferredSource: "公告/药智/米内/医保局", requiredFor: "产品放量模型", status: "provider_needed" },
        { item: "临床管线概率和峰值销售", preferredSource: "ClinicalTrials/公司公告/医药数据库", requiredFor: "rNPV", status: "provider_needed" },
      ],
    }
  }
  if (/消费|食品|饮料|家电|白酒|零售/.test(text)) {
    return {
      kind: "consumer",
      frameworkName: "消费品渠道/单品模型",
      statementCore: "三表底座 + SKU/渠道/价格带 + 费用投放效率",
      defaultSegments: [
        { name: "核心单品/主品牌", role: "现金流底座", revenueShare: 0.70, gm: 0.45, growth: [0.07, 0.08, 0.07] },
        { name: "新品/新渠道", role: "估值弹性", revenueShare: 0.20, gm: 0.38, growth: [0.16, 0.18, 0.15] },
        { name: "其他", role: "补充业务", revenueShare: 0.10, gm: 0.30, growth: [0.03, 0.04, 0.04] },
      ],
      operatingDrivers: ["销量", "ASP", "渠道库存", "费用率", "经销商数量", "同店/动销"],
      valuationMethods: ["PE", "FCF", "P/S"],
      defaultAssumptions: { opexRatio: 0.24, taxRate: 0.25, capexPct: 0.04, daPct: 0.03, nwcPct: 0.16, targetPe: 26, evFcf: 22, ps: 3, discountRate: 0.1 },
      externalDataNeeds: [
        { item: "渠道动销/库存/价格带", preferredSource: "渠道调研/第三方零售数据", requiredFor: "收入质量", status: "manual_input" },
        { item: "一致预期", preferredSource: "Wind/iFinD/Choice", requiredFor: "估值交叉验证", status: "provider_needed" },
      ],
    }
  }
  return {
    kind: "generic-industrial",
    frameworkName: "通用制造/成长股三表模型",
    statementCore: "三表底座 + 分业务收入/毛利率 + 营运资本 + Capex/折旧 + 多方法估值",
    defaultSegments: [
      { name: "核心业务", role: "现金流底座", revenueShare: 0.65, gm: 0.30, growth: [0.08, 0.09, 0.08] },
      { name: "高弹性业务", role: "估值弹性", revenueShare: 0.25, gm: 0.35, growth: [0.18, 0.20, 0.18] },
      { name: "其他", role: "补充业务", revenueShare: 0.10, gm: 0.22, growth: [0.04, 0.05, 0.05] },
    ],
    operatingDrivers: ["收入增长", "毛利率", "费用率", "营运资本周转", "Capex", "折旧摊销"],
    valuationMethods: ["PE", "FCF", "P/S"],
    defaultAssumptions: { opexRatio: 0.20, taxRate: 0.20, capexPct: 0.08, daPct: 0.04, nwcPct: 0.18, targetPe: 25, evFcf: 20, ps: 3, discountRate: 0.1 },
    externalDataNeeds: [
      { item: "分业务收入/毛利率官方表", preferredSource: "年报附注/CNINFO PDF", requiredFor: "分部模型", status: "manual_input" },
      { item: "一致预期净利润/收入", preferredSource: "Wind/iFinD/Choice", requiredFor: "估值交叉验证", status: "provider_needed" },
    ],
  }
}

function buildFinancialModelV2SegmentInputs({ businessBreakdown, pack }) {
  const revenue = modelNumber(businessBreakdown.keyMetrics?.revenue, 0)
  const profile = companyResearchProfile(businessBreakdown.company)
  const productRows = (businessBreakdown.productLines ?? []).filter((row) => row.status !== "manual_needed" && modelNumber(row.revenue, null) != null)
  const specificPatterns = [
    ...(profile.coreProductPatterns ?? []),
    ...(profile.baseProductPatterns ?? []),
    /^其他$/,
  ]
  const specificProductRows = productRows.filter((row) =>
    specificPatterns.some((pattern) => pattern.test(String(row.name ?? row.product ?? row.segment ?? ""))),
  )
  const modelProductRows = specificProductRows.length ? specificProductRows : productLineRowsForReport(productRows, profile)
  if (modelProductRows.length > 0) {
    return modelProductRows.slice(0, 8).map((row, index) => {
      const defaults = pack.defaultSegments[index] ?? pack.defaultSegments[pack.defaultSegments.length - 1] ?? {}
      return {
        name: row.name ?? row.product ?? row.segment ?? defaults.name ?? "业务线",
        role: defaults.role ?? "业务线",
        revenue: modelNumber(row.revenue, 0),
        gm: modelPctDecimal(row.grossMarginPct, defaults.gm ?? modelPctDecimal(businessBreakdown.keyMetrics?.grossMarginPct, 0.3)),
        growth: defaults.growth ?? [0.08, 0.08, 0.08],
        evidenceLevel: row.evidenceLevel ?? "A",
        status: row.status ?? "extracted",
        source: row.sourceTitle ?? row.source ?? "annual_report_product_table",
        notes: row.aspStatus === "requires_review" ? "ASP/销量映射需复核" : "",
      }
    })
  }
  return pack.defaultSegments.map((segment) => ({
    name: segment.name,
    role: segment.role,
    revenue: revenue * segment.revenueShare,
    gm: segment.gm,
    growth: segment.growth,
    evidenceLevel: revenue ? "B" : "manual_needed",
    status: revenue ? "template_allocated_from_total_revenue" : "manual_needed",
    source: revenue ? "tushare.income + industry_driver_pack" : "manual_input",
    notes: revenue ? "分产品表缺失时按行业模板临时分摊，需用公告表替换" : "缺少总收入或分部收入",
  }))
}

function buildFinancialModelV2Blueprint({ company, businessBreakdown, ledger, evidencePack, generatedAt }) {
  const profile = companyResearchProfile(company)
  const pack = inferFinancialModelPack(company, profile)
  const sourceMap = [
    { item: "三表历史数据", source: "tushare income/balancesheet/cashflow", evidenceLevel: "B", status: (businessBreakdown.historicalFinancials?.income?.length ?? 0) ? "available" : "manual_needed" },
    { item: "分产品收入/毛利率", source: "CNINFO annual report PDF tables", evidenceLevel: "A", status: businessBreakdown.validationStatus?.productLineCompleteness ?? "manual_needed" },
    { item: "子公司盈亏", source: "CNINFO annual report notes", evidenceLevel: "A", status: businessBreakdown.validationStatus?.subsidiaryCompleteness ?? "manual_needed" },
    { item: "在建工程/Capex", source: "CNINFO annual report tables + Tushare balance sheet", evidenceLevel: "A/B", status: businessBreakdown.validationStatus?.capexCompleteness ?? "manual_needed" },
    { item: "估值和市值", source: "Tushare daily_basic / local market data", evidenceLevel: "B", status: businessBreakdown.keyMetrics?.totalMarketValue ? "available" : "manual_needed" },
    ...pack.externalDataNeeds.map((row) => ({ ...row, evidenceLevel: row.status === "provider_needed" ? "B/C" : "manual_needed", source: row.preferredSource })),
  ]
  return {
    schema: `${COMPANY_FINANCIAL_MODEL_V2_VERSION}-blueprint`,
    generatedAt,
    company,
    profileKind: profile.kind,
    frameworkKind: pack.kind,
    frameworkName: pack.frameworkName,
    statementCore: pack.statementCore,
    workbookArchitecture: [
      "Cover",
      "Financial Framework",
      "Data Sources",
      "Driver Assumptions",
      "Historical IS",
      "Historical BS",
      "Historical CF",
      "Segment Drivers",
      "Working Capital",
      "Capex D&A",
      "Forecast",
      "Valuation v2",
      "Sensitivity",
      "Checks",
      "Manual Inputs",
    ],
    operatingDrivers: pack.operatingDrivers,
    valuationMethods: pack.valuationMethods,
    sourcePolicy: "A/B evidence drives actuals and base model. C/D evidence may only enter upside notes, risks, or manual-input watchlist.",
    sourceMap,
    providerStatus: {
      tushareRows: ledger.rows.filter((row) => row.source === "tushare").reduce((sum, row) => sum + (row.details?.rows ?? 0), 0),
      cninfoDownloads: ledger.rows.filter((row) => row.tool === "cninfo_pdf_download" && row.status === "success").length,
      webResults: evidencePack?.tavily?.results?.length ?? 0,
    },
  }
}

function buildFinancialModelV2Json({ blueprint, rows }) {
  return {
    schema: COMPANY_FINANCIAL_MODEL_V2_VERSION,
    generatedAt: blueprint.generatedAt,
    company: blueprint.company,
    frameworkKind: blueprint.frameworkKind,
    frameworkName: blueprint.frameworkName,
    sheets: Object.keys(rows),
    sourcePolicy: blueprint.sourcePolicy,
    sourceMap: blueprint.sourceMap,
    formulaMap: {
      forecastRevenue: "Forecast forecast-year revenue equals SUM of Segment Drivers forecast revenue.",
      forecastFcf: "Free Cash Flow = Net Profit + D&A - Capex - Change in NWC.",
      blendedValuation: "Valuation v2 blends PE, FCF multiple, and P/S outputs with visible weights.",
      checks: "Checks sheet ties segment revenue, forecast revenue, FCF, evidence completeness, and write boundaries.",
    },
    manualInputPolicy: "Provider-needed or manual-input rows are visible in Manual Inputs and must not be silently filled by the model generator.",
  }
}

function latestFinancialRow(rows) {
  return (rows ?? [])[0] ?? {}
}

function buildHistoricalSheetRows(rows, metrics) {
  const ordered = sortFinancialRowsAsc(rows).slice(-5)
  const labels = ordered.map((row) => row.periodLabel ?? formatPeriod(row.period))
  const rowFor = (label, key, fallback = "") => [
    label,
    ...ordered.map((row) => row[key] ?? ""),
    fallback,
  ]
  return { labels, rowFor }
}

function buildFinancialModelV2WorkbookRows({ company, businessBreakdown, ledger, evidencePack, blueprint }) {
  const profile = companyResearchProfile(company)
  const pack = inferFinancialModelPack(company, profile)
  const metrics = businessBreakdown.keyMetrics ?? {}
  const revenue = modelNumber(metrics.revenue, 0)
  const netProfit = modelNumber(metrics.netProfit, 0)
  const grossMargin = modelPctDecimal(metrics.grossMarginPct, pack.defaultAssumptions.grossMargin ?? 0.3)
  const netMargin = modelPctDecimal(metrics.netMarginPct, revenue ? netProfit / revenue : 0.08)
  const latestBalance = latestFinancialRow(businessBreakdown.historicalFinancials?.balance)
  const latestCashflow = latestFinancialRow(businessBreakdown.historicalFinancials?.cashflow)
  const capexPct = revenue && latestCashflow.capexCashOutflow != null
    ? Math.min(0.5, Math.abs(Number(latestCashflow.capexCashOutflow)) / revenue)
    : pack.defaultAssumptions.capexPct
  const nwcActual = modelNumber(latestBalance.accountsReceivable, 0) + modelNumber(latestBalance.inventories, 0)
  const nwcPct = revenue ? Math.min(0.8, nwcActual / revenue) : pack.defaultAssumptions.nwcPct
  const opexRatio = Math.max(0.02, grossMargin - Math.max(netMargin, 0.02))
  const targetPe = modelNumber(metrics.peTtm, pack.defaultAssumptions.targetPe) || pack.defaultAssumptions.targetPe
  const shareCount = deriveShareCountForModel(businessBreakdown)
  const forecastYears = forecastYearLabels(metrics.latestPeriod)
  const segmentInputs = buildFinancialModelV2SegmentInputs({ businessBreakdown, pack })
  const segmentEndRow = segmentInputs.length + 1
  const manualInputRows = blueprint.sourceMap
    .filter((row) => row.status === "provider_needed" || row.status === "manual_input" || row.status === "manual_needed")
    .map((row) => [row.item, row.preferredSource ?? row.source, row.requiredFor ?? "", row.status, row.evidenceLevel ?? "", ""])
  const assumptions = [
    ["Revenue Overlay", -0.05, 0, 0.08, "%", "model", "Visible override; segment growth remains primary", "optional", "Keep zero unless analyst wants top-down override"],
    ["Gross Margin Normalization", -0.02, 0, 0.03, "ppt", "A/B/C", "Used as review cue, not embedded in segment GM", "optional", ""],
    ["Opex Ratio", Math.max(0.02, opexRatio * 1.1), opexRatio, Math.max(0.02, opexRatio * 0.9), "% revenue", "B", "Derived from latest gross/net margin", "derived", ""],
    ["Tax Rate", Math.min(0.3, pack.defaultAssumptions.taxRate + 0.03), pack.defaultAssumptions.taxRate, Math.max(0.05, pack.defaultAssumptions.taxRate - 0.03), "% pretax", "template", "Industry default until official tax note is parsed", "manual_review", ""],
    ["Capex % Revenue", Math.max(capexPct * 0.7, 0.01), capexPct, Math.min(capexPct * 1.4, 0.5), "% revenue", "B", "Tushare cashflow or industry default", latestCashflow.capexCashOutflow != null ? "derived" : "manual_review", ""],
    ["D&A % Revenue", Math.max(pack.defaultAssumptions.daPct * 0.8, 0.005), pack.defaultAssumptions.daPct, pack.defaultAssumptions.daPct * 1.25, "% revenue", "template", "Needs annual report fixed asset/depreciation note", "manual_review", ""],
    ["NWC % Revenue", Math.max(nwcPct * 0.75, 0.02), nwcPct, Math.min(nwcPct * 1.25, 0.8), "% revenue", "B", "AR + inventory / revenue", "derived", ""],
    ["Target PE", Math.max(8, targetPe * 0.65), Math.max(10, targetPe * 0.85), Math.max(12, targetPe * 1.05), "x", "B", "Anchored to latest PE TTM where available", metrics.peTtm ? "derived" : "manual_review", ""],
    ["Exit FCF Multiple", Math.max(8, pack.defaultAssumptions.evFcf * 0.7), pack.defaultAssumptions.evFcf, pack.defaultAssumptions.evFcf * 1.25, "x", "template", "Fallback cross-check", "manual_review", ""],
    ["P/S Multiple", Math.max(0.5, pack.defaultAssumptions.ps * 0.7), pack.defaultAssumptions.ps, pack.defaultAssumptions.ps * 1.25, "x", "template", "Fallback cross-check", "manual_review", ""],
    ["Discount Rate", pack.defaultAssumptions.discountRate + 0.02, pack.defaultAssumptions.discountRate, Math.max(0.06, pack.defaultAssumptions.discountRate - 0.02), "%", "template", "For later DCF/rNPV extension", "manual_review", ""],
  ]
  const segmentRows = segmentInputs.map((segment, index) => {
    const row = index + 2
    return [
      segment.name,
      segment.role,
      segment.revenue,
      segment.gm,
      segment.growth?.[0] ?? 0.08,
      segment.growth?.[1] ?? 0.08,
      segment.growth?.[2] ?? 0.08,
      { f: `C${row}*(1+E${row})`, t: "n" },
      { f: `H${row}*(1+F${row})`, t: "n" },
      { f: `I${row}*(1+G${row})`, t: "n" },
      { f: `J${row}*D${row}`, t: "n" },
      segment.evidenceLevel,
      segment.status,
      segment.source,
      segment.notes,
    ]
  })
  const income = buildHistoricalSheetRows(businessBreakdown.historicalFinancials?.income, metrics)
  const balance = buildHistoricalSheetRows(businessBreakdown.historicalFinancials?.balance, metrics)
  const cashflow = buildHistoricalSheetRows(businessBreakdown.historicalFinancials?.cashflow, metrics)
  const dataSourceRows = [
    ["Item", "Source", "Evidence Level", "Status", "Required For", "Notes"],
    ...blueprint.sourceMap.map((row) => [row.item, row.source ?? row.preferredSource ?? "", row.evidenceLevel ?? "", row.status ?? "", row.requiredFor ?? "", row.notes ?? ""]),
    [],
    ["Ledger Item", "Source", "Tool", "Status", "Completed At", "Evidence Level"],
    ...ledger.rows.map((row) => [row.dataItem, row.source, row.tool, row.status, row.completedAt, row.evidenceLevel]),
  ]
  return {
    Cover: [
      ["Company Financial Model v2", "", "", COMPANY_FINANCIAL_MODEL_V2_VERSION],
      ["Company", company.stockName ?? company.stockInput],
      ["Stock", company.tsCode ?? company.stockCode ?? ""],
      ["Framework", blueprint.frameworkName],
      ["Framework Kind", blueprint.frameworkKind],
      ["Latest Period", metrics.latestPeriod ?? ""],
      ["Model Status", { f: "Checks!F2", t: "s", v: "" }],
      ["Write Policy", "No raw/** or formal wiki/** writes; artifacts only under .llm-wiki/company-research"],
      ["Evidence Rule", blueprint.sourcePolicy],
    ],
    "Financial Framework": [
      ["Section", "Design"],
      ["Model architecture", blueprint.statementCore],
      ["Industry driver pack", blueprint.frameworkKind],
      ["Operating drivers", blueprint.operatingDrivers.join(", ")],
      ["Valuation methods", blueprint.valuationMethods.join(", ")],
      ["Universal base", "Historical IS/BS/CF, forecast, valuation, checks, source map"],
      ["Company override", "Use official product-line tables and annual-report notes when available; otherwise keep manual_input/provider_needed visible"],
    ],
    "Data Sources": dataSourceRows,
    "Driver Assumptions": [
      ["Driver", "Downside", "Base", "Upside", "Unit", "Evidence", "Source", "Status", "Notes"],
      ...assumptions,
    ],
    "Historical IS": [
      ["Metric", ...income.labels, "Source"],
      income.rowFor("Revenue", "revenue", "tushare.income"),
      income.rowFor("Operating Profit", "operatingProfit", "tushare.income"),
      income.rowFor("Net Profit", "netProfit", "tushare.income"),
      income.rowFor("R&D Expense", "rdExpense", "tushare.income"),
      ["Net Margin %", ...sortFinancialRowsAsc(businessBreakdown.historicalFinancials?.income).slice(-5).map((row) => row.revenue ? modelNumber(row.netProfit, 0) / row.revenue : ""), "derived"],
    ],
    "Historical BS": [
      ["Metric", ...balance.labels, "Source"],
      balance.rowFor("Total Assets", "totalAssets", "tushare.balancesheet"),
      balance.rowFor("Total Liabilities", "totalLiabilities", "tushare.balancesheet"),
      balance.rowFor("Fixed Assets", "fixedAssets", "tushare.balancesheet"),
      balance.rowFor("Construction in Progress", "constructionInProgress", "tushare.balancesheet"),
      balance.rowFor("Inventories", "inventories", "tushare.balancesheet"),
      balance.rowFor("Accounts Receivable", "accountsReceivable", "tushare.balancesheet"),
      balance.rowFor("Share Count", "totalShare", "tushare.balancesheet"),
    ],
    "Historical CF": [
      ["Metric", ...cashflow.labels, "Source"],
      cashflow.rowFor("Operating Cash Flow", "operatingCashflow", "tushare.cashflow"),
      cashflow.rowFor("Capex Cash Outflow", "capexCashOutflow", "tushare.cashflow"),
      cashflow.rowFor("Free Cash Flow", "freeCashflow", "tushare.cashflow/manual derived"),
    ],
    "Segment Drivers": [
      ["Segment", "Role", "Actual Revenue", "Actual GM %", `${forecastYears[0]} Growth`, `${forecastYears[1]} Growth`, `${forecastYears[2]} Growth`, `${forecastYears[0]} Revenue`, `${forecastYears[1]} Revenue`, `${forecastYears[2]} Revenue`, `${forecastYears[2]} Gross Profit`, "Evidence", "Status", "Source", "Notes"],
      ...segmentRows,
    ],
    "Working Capital": [
      ["Metric", "Actual", "% Revenue", forecastYears[0], forecastYears[1], forecastYears[2], "Source/Note"],
      ["Accounts Receivable", modelNumber(latestBalance.accountsReceivable, 0), revenue ? modelNumber(latestBalance.accountsReceivable, 0) / revenue : 0, { f: "Forecast!C2*C2", t: "n" }, { f: "Forecast!D2*C2", t: "n" }, { f: "Forecast!E2*C2", t: "n" }, "tushare.balancesheet"],
      ["Inventory", modelNumber(latestBalance.inventories, 0), revenue ? modelNumber(latestBalance.inventories, 0) / revenue : 0, { f: "Forecast!C2*C3", t: "n" }, { f: "Forecast!D2*C3", t: "n" }, { f: "Forecast!E2*C3", t: "n" }, "tushare.balancesheet"],
      ["Operating NWC", nwcActual, revenue ? nwcActual / revenue : 0, { f: "D2+D3", t: "n" }, { f: "E2+E3", t: "n" }, { f: "F2+F3", t: "n" }, "AR + inventory proxy"],
      ["NWC % Revenue", revenue ? nwcActual / revenue : pack.defaultAssumptions.nwcPct, { f: "B4/Forecast!B2", t: "n" }, { f: "D4/Forecast!C2", t: "n" }, { f: "E4/Forecast!D2", t: "n" }, { f: "F4/Forecast!E2", t: "n" }, "proxy"],
      ["Change in NWC", "", "", { f: "D4-B4", t: "n" }, { f: "E4-D4", t: "n" }, { f: "F4-E4", t: "n" }, "cash-flow deduction"],
    ],
    "Capex D&A": [
      ["Metric", "Actual", "% Revenue", forecastYears[0], forecastYears[1], forecastYears[2], "Source/Note"],
      ["Fixed Assets", modelNumber(latestBalance.fixedAssets, 0), revenue ? modelNumber(latestBalance.fixedAssets, 0) / revenue : 0, "", "", "", "tushare.balancesheet"],
      ["Construction in Progress", modelNumber(latestBalance.constructionInProgress, 0), revenue ? modelNumber(latestBalance.constructionInProgress, 0) / revenue : 0, "", "", "", "tushare.balancesheet / annual-report capex table"],
      ["Capex % Revenue", "", { f: "'Driver Assumptions'!C6", t: "n" }, { f: "C4", t: "n" }, { f: "C4", t: "n" }, { f: "C4", t: "n" }, "assumption"],
      ["D&A % Revenue", "", { f: "'Driver Assumptions'!C7", t: "n" }, { f: "C5", t: "n" }, { f: "C5", t: "n" }, { f: "C5", t: "n" }, "assumption"],
      ["Forecast Capex", "", "", { f: "Forecast!C2*D4", t: "n" }, { f: "Forecast!D2*E4", t: "n" }, { f: "Forecast!E2*F4", t: "n" }, "revenue linked"],
      ["Forecast D&A", "", "", { f: "Forecast!C2*D5", t: "n" }, { f: "Forecast!D2*E5", t: "n" }, { f: "Forecast!E2*F5", t: "n" }, "revenue linked"],
      ["Depreciation Pressure", "", "", { f: "IF(Forecast!C3=0,0,D7/Forecast!C3)", t: "n" }, { f: "IF(Forecast!D3=0,0,E7/Forecast!D3)", t: "n" }, { f: "IF(Forecast!E3=0,0,F7/Forecast!E3)", t: "n" }, "D&A / gross profit"],
    ],
    Forecast: [
      ["Metric", "Actual", forecastYears[0], forecastYears[1], forecastYears[2], "Evidence/Formula"],
      ["Revenue", revenue, { f: `SUM('Segment Drivers'!H2:H${segmentEndRow})`, t: "n" }, { f: `SUM('Segment Drivers'!I2:I${segmentEndRow})`, t: "n" }, { f: `SUM('Segment Drivers'!J2:J${segmentEndRow})`, t: "n" }, "segment driver sum"],
      ["Gross Profit", revenue * grossMargin, { f: `SUMPRODUCT('Segment Drivers'!H2:H${segmentEndRow},'Segment Drivers'!D2:D${segmentEndRow})`, t: "n" }, { f: `SUMPRODUCT('Segment Drivers'!I2:I${segmentEndRow},'Segment Drivers'!D2:D${segmentEndRow})`, t: "n" }, { f: `SUMPRODUCT('Segment Drivers'!J2:J${segmentEndRow},'Segment Drivers'!D2:D${segmentEndRow})`, t: "n" }, "segment revenue * GM"],
      ["Gross Margin %", grossMargin, { f: "IF(C2=0,0,C3/C2)", t: "n" }, { f: "IF(D2=0,0,D3/D2)", t: "n" }, { f: "IF(E2=0,0,E3/E2)", t: "n" }, "derived"],
      ["Opex Ratio", opexRatio, { f: "'Driver Assumptions'!C4", t: "n" }, { f: "'Driver Assumptions'!C4", t: "n" }, { f: "'Driver Assumptions'!C4", t: "n" }, "assumption"],
      ["EBIT", revenue * Math.max(grossMargin - opexRatio, 0), { f: "C2*(C4-C5)", t: "n" }, { f: "D2*(D4-D5)", t: "n" }, { f: "E2*(E4-E5)", t: "n" }, "revenue * spread"],
      ["Tax Rate", pack.defaultAssumptions.taxRate, { f: "'Driver Assumptions'!C5", t: "n" }, { f: "'Driver Assumptions'!C5", t: "n" }, { f: "'Driver Assumptions'!C5", t: "n" }, "assumption"],
      ["Net Profit", netProfit, { f: "C6*(1-C7)", t: "n" }, { f: "D6*(1-D7)", t: "n" }, { f: "E6*(1-E7)", t: "n" }, "EBIT after tax"],
      ["D&A", "", { f: "'Capex D&A'!D7", t: "n" }, { f: "'Capex D&A'!E7", t: "n" }, { f: "'Capex D&A'!F7", t: "n" }, "Capex D&A"],
      ["Capex", Math.abs(modelNumber(latestCashflow.capexCashOutflow, 0)), { f: "'Capex D&A'!D6", t: "n" }, { f: "'Capex D&A'!E6", t: "n" }, { f: "'Capex D&A'!F6", t: "n" }, "Capex D&A"],
      ["Change in NWC", "", { f: "'Working Capital'!D6", t: "n" }, { f: "'Working Capital'!E6", t: "n" }, { f: "'Working Capital'!F6", t: "n" }, "Working Capital"],
      ["Free Cash Flow", modelNumber(latestCashflow.operatingCashflow, 0) - Math.abs(modelNumber(latestCashflow.capexCashOutflow, 0)), { f: "C8+C9-C10-C11", t: "n" }, { f: "D8+D9-D10-D11", t: "n" }, { f: "E8+E9-E10-E11", t: "n" }, "NI + D&A - capex - delta NWC"],
    ],
    "Valuation v2": [
      ["Method", `${forecastYears[1]} Metric`, "Multiple", "Equity Value", "Weight", "Weighted Value", "Evidence Rule", "Notes"],
      ["PE", { f: "Forecast!D8", t: "n" }, { f: "'Driver Assumptions'!C9", t: "n" }, { f: "B2*C2", t: "n" }, 0.5, { f: "D2*E2", t: "n" }, "A/B base; C only in note", "净利润口径"],
      ["FCF", { f: "Forecast!D12", t: "n" }, { f: "'Driver Assumptions'!C10", t: "n" }, { f: "B3*C3", t: "n" }, 0.3, { f: "D3*E3", t: "n" }, "A/B base", "现金流交叉验证"],
      ["P/S", { f: "Forecast!D2", t: "n" }, { f: "'Driver Assumptions'!C11", t: "n" }, { f: "B4*C4", t: "n" }, 0.2, { f: "D4*E4", t: "n" }, "B/template", "成长股辅助"],
      [],
      ["Blended Equity Value", "", "", { f: "SUM(F2:F4)", t: "n" }],
      ["Share Count", "", "", shareCount ?? ""],
      ["Target Price", "", "", { f: 'IF(D7>0,D6/D7,"")', t: "n" }],
      ["Current Market Value", "", "", metrics.totalMarketValue ?? ""],
      ["Upside %", "", "", { f: 'IF(D9>0,D6/D9-1,"")', t: "n" }],
    ],
    Sensitivity: [
      ["Target PE / Net Profit", "Downside NP", "Base NP", "Upside NP"],
      [Math.max(8, targetPe * 0.65), { f: 'IF(\'Valuation v2\'!$D$7>0,A2*Forecast!$D$8*0.85/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A2*Forecast!$D$8/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A2*Forecast!$D$8*1.15/\'Valuation v2\'!$D$7,"")', t: "n" }],
      [Math.max(10, targetPe * 0.85), { f: 'IF(\'Valuation v2\'!$D$7>0,A3*Forecast!$D$8*0.85/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A3*Forecast!$D$8/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A3*Forecast!$D$8*1.15/\'Valuation v2\'!$D$7,"")', t: "n" }],
      [Math.max(12, targetPe * 1.05), { f: 'IF(\'Valuation v2\'!$D$7>0,A4*Forecast!$D$8*0.85/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A4*Forecast!$D$8/\'Valuation v2\'!$D$7,"")', t: "n" }, { f: 'IF(\'Valuation v2\'!$D$7>0,A4*Forecast!$D$8*1.15/\'Valuation v2\'!$D$7,"")', t: "n" }],
    ],
    Checks: [
      ["Check", "Actual", "Expected", "Difference", "Tolerance", "Status", "Notes"],
      ["Overall model status", "", "", "", "", { f: 'IF(COUNTIF(F3:F20,"REVIEW")=0,"OK","REVIEW")', t: "s", v: "" }, "Visible on Cover"],
      ["Product revenue ties to reported revenue", { f: `SUM('Segment Drivers'!C2:C${segmentEndRow})`, t: "n" }, { f: "Forecast!B2", t: "n" }, { f: "B3-C3", t: "n" }, { f: "MAX(ABS(C3)*0.05,1)", t: "n" }, { f: 'IF(OR(C3=0,ABS(D3)<=E3),"OK","REVIEW")', t: "s", v: "" }, "If template allocation is used this should tie; official product table may require review"],
      ["Forecast revenue sourced from segment drivers", { f: "Forecast!C2", t: "n" }, { f: `SUM('Segment Drivers'!H2:H${segmentEndRow})`, t: "n" }, { f: "B4-C4", t: "n" }, 1, { f: 'IF(ABS(D4)<=E4,"OK","REVIEW")', t: "s", v: "" }, ""],
      ["FCF formula tie", { f: "Forecast!C12", t: "n" }, { f: "Forecast!C8+Forecast!C9-Forecast!C10-Forecast!C11", t: "n" }, { f: "B5-C5", t: "n" }, 1, { f: 'IF(ABS(D5)<=E5,"OK","REVIEW")', t: "s", v: "" }, ""],
      ["Evidence/manual input count", manualInputRows.length, 0, { f: "B6-C6", t: "n" }, 0, { f: 'IF(B6=0,"OK","REVIEW")', t: "s", v: "" }, "REVIEW is expected when professional data is not connected"],
      ["Write boundary", 0, 0, { f: "B7-C7", t: "n" }, 0, { f: 'IF(B7=C7,"OK","REVIEW")', t: "s", v: "" }, "No raw/wiki formal writes"],
    ],
    "Manual Inputs": [
      ["Input", "Preferred Source", "Required For", "Status", "Evidence Level", "Analyst Fill"],
      ...manualInputRows,
    ],
  }
}

function buildDeepQualityAudit({ company, documentExtract, businessBreakdown, deepReport, deepModelRows }) {
  const profile = companyResearchProfile(company ?? businessBreakdown.company)
  const report = String(deepReport ?? "")
  const sheetNames = Object.keys(deepModelRows ?? {})
  const hasSheet = (name) => sheetNames.includes(name)
  const hasProductLines = (businessBreakdown.productLines ?? []).some((row) => row.status === "extracted")
  const hasSubsidiary = (businessBreakdown.subsidiaryProfit ?? []).some((row) => row.status === "extracted")
  const hasCapex = (businessBreakdown.capex ?? []).some((row) => row.status === "extracted")
  const hasCorporateTerms = (businessBreakdown.corporateActions ?? []).some((row) => Object.keys(row.terms ?? {}).length >= 4)
  const hasOfficialTables = (documentExtract.summary?.keyTables ?? 0) > 0 && (documentExtract.summary?.keyRows ?? 0) > 0
  const hasPriceOrMarginLine = profile.kind === "jiemei"
    ? (businessBreakdown.productLines ?? []).some((row) => row.asp != null)
    : hasProductLines && (businessBreakdown.productLines ?? []).some((row) => row.grossMarginPct != null)
  const capexReviewed = hasCapex || (profile.kind !== "jiemei" && businessBreakdown.validationStatus?.capexCompleteness === "cross_check")
  const requirements = [
    { id: "data_pull_confirmation", label: "数据拉取确认", completed: report.includes("## 数据拉取确认"), evidence: "deep report section" },
    { id: "evidence_confidence", label: "数据可信度说明", completed: report.includes("## 数据可信度说明"), evidence: "deep report section" },
    { id: "opening_conclusion", label: "开篇结论", completed: report.includes("## 开篇结论"), evidence: "deep report section" },
    { id: "official_table_extraction", label: "公告原文表格抽取", completed: hasOfficialTables, evidence: `${documentExtract.summary?.keyTables ?? 0} key tables / ${documentExtract.summary?.keyRows ?? 0} key rows` },
    { id: "product_breakdown", label: "分产品收入和毛利率", completed: hasProductLines && report.includes("分产品收入与毛利率"), evidence: businessBreakdown.validationStatus?.productLineCompleteness ?? "unknown" },
    { id: "price_or_asp_inference", label: profile.kind === "jiemei" ? "ASP 独立推算" : "价格/毛利率线索", completed: hasPriceOrMarginLine && (report.includes("ASP 独立推算") || report.includes("价格/毛利率线索")), evidence: profile.kind === "jiemei" ? "product line ASP field" : "product line gross margin field" },
    { id: "subsidiary_profit", label: "子公司盈亏核实", completed: hasSubsidiary && report.includes("子公司盈亏核实"), evidence: businessBreakdown.validationStatus?.subsidiaryCompleteness ?? "unknown" },
    { id: "capex_capacity", label: "产能/在建工程/折旧压力", completed: capexReviewed && report.includes("产能规划与折旧压力"), evidence: businessBreakdown.validationStatus?.capexCompleteness ?? "unknown" },
    { id: "cashflow_base_module", label: "核心业务/现金流底座", completed: report.includes("载带业务（稳定现金牛）") || report.includes("核心业务与现金流底座"), evidence: "deep report section" },
    { id: "corporate_action_terms", label: "重大事项/收购条款", completed: hasCorporateTerms && report.includes("预案关键条款自动抽取"), evidence: businessBreakdown.validationStatus?.corporateActionCompleteness ?? "unknown" },
    { id: "scenario_model", label: "三情景财务模型", completed: report.includes("三年财务模型（三情景）") && hasSheet("Scenario Model"), evidence: "report section + Scenario Model sheet" },
    { id: "valuation_matrix", label: "PE/市值敏感性矩阵", completed: report.includes("PE/市值敏感性矩阵") && hasSheet("Valuation Matrix"), evidence: "report section + Valuation Matrix sheet" },
    { id: "risk_table", label: "核心风险", completed: report.includes("核心风险"), evidence: "deep report section" },
    { id: "exit_signals", label: "退出信号体系", completed: report.includes("退出信号体系") && hasSheet("Exit Signals"), evidence: "report section + Exit Signals sheet" },
    { id: "validation_checklist", label: "验证清单", completed: report.includes("验证清单") && hasSheet("Validation Checklist"), evidence: "report section + Validation Checklist sheet" },
    { id: "wiki_candidates", label: "wiki 写入候选", completed: report.includes("wiki 写入候选"), evidence: "deep report section" },
    { id: "safe_write_policy", label: "安全写入边界", completed: true, evidence: "company-research writes under .llm-wiki/company-research only" },
  ]
  const completed = requirements.filter((item) => item.completed).length
  const score = requirements.length ? completed / requirements.length : 0
  return {
    schema: "company-deep-quality-audit-v1",
    generatedAt: nowLocalTimestamp(),
    targetScore: 0.9,
    score: roundMetric(score, 4),
    completed,
    total: requirements.length,
    pass: score >= 0.9,
    requirements,
    residualRisks: [
      hasCorporateTerms ? null : "重大事项只命中标题或 PDF 摘要，未抽出足够交易条款。",
      hasOfficialTables ? null : "公告 PDF 未抽出足够关键表格。",
      "自动报告仍需人工复核 PDF 页码、ASP 口径和情景假设，不直接等同于可发布投研报告。",
    ].filter(Boolean),
  }
}

async function buildDeepCompanyResearchArtifacts({ projectPath, outputDir, paths, company, financials, ledger, evidencePack, downloads, wikiCandidatesMarkdown, generatedAt, options = {} }) {
  const documentExtract = buildDeepDocumentExtract({ projectPath, downloads, options })
  const businessBreakdown = buildDeepBusinessBreakdown({ projectPath, company, financials, evidencePack, documentExtract })
  const deepReport = buildDeepCompanyReportMarkdown({
    company,
    ledger,
    documentExtract,
    businessBreakdown,
    evidencePack,
    wikiCandidatesMarkdown,
    generatedAt,
  })
  const deepChecklist = buildDeepReviewChecklist({ documentExtract, businessBreakdown })
  const deepModelRows = buildDeepCompanyWorkbookRows({ company, businessBreakdown, ledger, evidencePack })
  const financialModelV2Blueprint = buildFinancialModelV2Blueprint({ company, businessBreakdown, ledger, evidencePack, generatedAt })
  const financialModelV2Rows = buildFinancialModelV2WorkbookRows({
    company,
    businessBreakdown,
    ledger,
    evidencePack,
    blueprint: financialModelV2Blueprint,
  })
  const financialModelV2Json = buildFinancialModelV2Json({ blueprint: financialModelV2Blueprint, rows: financialModelV2Rows })
  const deepQualityAudit = buildDeepQualityAudit({ company, documentExtract, businessBreakdown, deepReport, deepModelRows })
  const deepPaths = {
    documentExtract: path.join(outputDir, "document-extract.json"),
    businessBreakdown: path.join(outputDir, "business-breakdown.json"),
    deepReport: path.join(outputDir, "deep-company-report.md"),
    deepModelXlsx: path.join(outputDir, "deep-company-model.xlsx"),
    financialModelV2Xlsx: path.join(outputDir, "financial-model-v2.xlsx"),
    financialModelV2Json: path.join(outputDir, "financial-model-v2.json"),
    financialModelV2Template: path.join(outputDir, "financial-model-v2-template.json"),
    deepChecklist: path.join(outputDir, "deep-review-checklist.md"),
    deepQualityAudit: path.join(outputDir, "deep-quality-audit.json"),
  }
  await writeJson(deepPaths.documentExtract, documentExtract)
  await writeJson(deepPaths.businessBreakdown, businessBreakdown)
  await fs.writeFile(deepPaths.deepReport, deepReport, "utf8")
  await writeCompanyWorkbook(deepPaths.deepModelXlsx, deepModelRows)
  await writeCompanyWorkbook(deepPaths.financialModelV2Xlsx, financialModelV2Rows)
  await writeJson(deepPaths.financialModelV2Json, financialModelV2Json)
  await writeJson(deepPaths.financialModelV2Template, financialModelV2Blueprint)
  await fs.writeFile(deepPaths.deepChecklist, deepChecklist, "utf8")
  await writeJson(deepPaths.deepQualityAudit, deepQualityAudit)
  return {
    enabled: true,
    templateVersion: COMPANY_DEEP_TEMPLATE_VERSION,
    financialModelVersion: COMPANY_FINANCIAL_MODEL_V2_VERSION,
    providerPolicy: documentExtract.providerPolicy,
    outputs: Object.fromEntries(Object.entries(deepPaths).map(([key, value]) => [key, projectRelative(projectPath, value)])),
    summary: {
      documents: documentExtract.summary,
      financialModelKind: financialModelV2Blueprint.frameworkKind,
      productLineCompleteness: businessBreakdown.validationStatus.productLineCompleteness,
      subsidiaryCompleteness: businessBreakdown.validationStatus.subsidiaryCompleteness,
      capexCompleteness: businessBreakdown.validationStatus.capexCompleteness,
      corporateActionCompleteness: businessBreakdown.validationStatus.corporateActionCompleteness,
      noInventedFigures: businessBreakdown.validationStatus.noInventedFigures,
      qualityScore: deepQualityAudit.score,
      qualityPass: deepQualityAudit.pass,
    },
  }
}

async function writeCompanyWorkbook(filePath, modelRows) {
  const xlsx = await import("xlsx")
  const XLSX = xlsx.default ?? xlsx
  const wb = XLSX.utils.book_new()
  for (const [sheetName, rows] of Object.entries(modelRows)) {
    const normalizedRows = rows.map((row) => row.map((cell) => {
      if (cell && typeof cell === "object" && !Array.isArray(cell) && cell.f) {
        return { t: cell.t ?? "n", v: cell.v ?? 0, f: cell.f }
      }
      return cell
    }))
    const ws = XLSX.utils.aoa_to_sheet(normalizedRows)
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  }
  await ensureDirectory(path.dirname(filePath))
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
  await fs.writeFile(filePath, buffer)
}

async function buildCompanyWikiContext({ projectPath, company, options }) {
  const query = [
    company.stockName,
    company.stockCode,
    company.tsCode,
    "公司 财务 模型 技术能力 产业链 估值 关联页面 最近20个交易日股价 成交额",
  ].filter(Boolean).join(" ")
  try {
    return await buildAskRetrievalContext({
      projectPath,
      query,
      sources: "wiki,raw,graph,stock-price",
      useLlmSourceRouting: false,
      topWiki: options.topWiki ?? 10,
      topRaw: options.topRaw ?? 6,
      graphNeighbors: options.graphNeighbors ?? 8,
      sqlLimit: options.sqlLimit ?? 60,
      stockDailyExecutor: options.stockDailyExecutor,
      stockDailyColumns: options.stockDailyColumns,
      stockDailyDescriptor: options.stockDailyDescriptor,
      pgConnectTimeoutMs: options.pgConnectTimeoutMs,
      pgStatementTimeoutMs: options.pgStatementTimeoutMs,
    })
  } catch (err) {
    return {
      query,
      retrievalWarnings: [`wiki retrieval failed: ${safeErrorMessage(err)}`],
      counts: {},
      wikiResults: [],
      rawResults: [],
      graphExpansions: [],
      stockDailyResults: [],
      marketValidation: null,
    }
  }
}

function resolveCompanyFromInputs({ stockInput, tushareEvidence }) {
  const normalizedCode = normalizeStockCode(stockInput)
  const stockBasic = latestByDate(tushareEvidence?.tables?.stock_basic?.rows, ["list_date"])
  const tsCode = stockBasic?.ts_code ?? toTushareCode(normalizedCode ?? stockInput)
  return {
    stockInput,
    stockCode: normalizedCode ?? normalizeStockCode(stockBasic?.ts_code),
    tsCode,
    stockName: stockBasic?.name ?? (normalizedCode ? null : stockInput),
    secName: stockBasic?.name ?? null,
    industry: stockBasic?.industry ?? null,
    market: stockBasic?.market ?? null,
    area: stockBasic?.area ?? null,
    listDate: stockBasic?.list_date ?? null,
  }
}

export async function runCompanyResearch(options = {}) {
  const projectPath = resolveProjectPath(options)
  const stockInput = String(options.stock ?? options.company ?? "").trim()
  if (!stockInput) throw new Error("Missing --stock for company-research")
  const generatedAt = nowLocalTimestamp()
  const credentials = getCompanyResearchCredentials(options)

  const seedCompany = {
    stockInput,
    stockCode: normalizeStockCode(stockInput),
    tsCode: toTushareCode(stockInput),
    stockName: normalizeStockCode(stockInput) ? null : stockInput,
    secName: normalizeStockCode(stockInput) ? null : stockInput,
    industry: null,
  }
  const tushareEvidence = await collectTushareEvidence({ company: seedCompany, credentials, options })
  const company = resolveCompanyFromInputs({ stockInput, tushareEvidence })
  const reportId = companyResearchReportId(company, options)
  const outputDir = path.join(projectPath, COMPANY_RESEARCH_ROOT, reportId)
  ensureCompanyResearchRelative(projectPath, outputDir)
  await ensureDirectory(outputDir)

  const cninfoClient = options.cninfoClient ?? defaultCninfoClient
  let cninfo
  try {
    const result = await cninfoClient({
      company,
      from: options.from,
      to: options.to,
      timeoutMs: options.cninfoTimeoutMs,
      options,
    })
    cninfo = {
      status: result.status ?? "success",
      requests: result.requests ?? [],
      announcements: dedupeAnnouncements((result.announcements ?? []).map((item) => item.downloadUrl ? item : normalizeCninfoAnnouncement(item))),
      error: result.error ?? null,
    }
  } catch (err) {
    cninfo = { status: "failed", requests: [], announcements: [], error: safeErrorMessage(err) }
  }
  if (!options.cninfoClient && options.disableSseFallback !== true && isShanghaiListedCompany(company)) {
    try {
      const sse = await defaultSseAnnouncementClient({
        company,
        to: options.to,
        timeoutMs: options.sseTimeoutMs ?? options.cninfoTimeoutMs,
        options,
      })
      if ((sse.announcements?.length ?? 0) > 0) {
        cninfo = {
          ...cninfo,
          status: cninfo.status === "failed" ? "partial" : cninfo.status,
          requests: [...(cninfo.requests ?? []), ...(sse.requests ?? [])],
          announcements: dedupeAnnouncements([...(cninfo.announcements ?? []), ...(sse.announcements ?? [])]),
          error: cninfo.error ?? null,
        }
      }
    } catch (err) {
      cninfo = {
        ...cninfo,
        status: cninfo.status === "success" ? "partial" : cninfo.status,
        error: [cninfo.error, `SSE fallback failed: ${safeErrorMessage(err)}`].filter(Boolean).join("; "),
      }
    }
  }
  let downloads = await downloadCninfoArtifacts({ projectPath, outputDir, announcements: cninfo.announcements, options })
  if (downloads.length === 0) {
    const cachedDownloads = await findCachedCninfoArtifacts({ projectPath, outputDir, company, options })
    if (cachedDownloads.length > 0) {
      downloads = cachedDownloads
      cninfo = {
        ...cninfo,
        status: "partial",
        error: [cninfo.error, `used ${cachedDownloads.length} cached CNINFO artifact(s)`].filter(Boolean).join("; "),
      }
    }
  }
  const tavilyEvidence = await collectTavilyEvidence({ company, credentials, options })
  const wikiContext = await buildCompanyWikiContext({ projectPath, company, options })
  const financials = buildFinancialsFromTushare(tushareEvidence)
  const ledger = buildEvidenceLedger({
    company,
    cninfo,
    downloads,
    tushare: tushareEvidence,
    tavily: tavilyEvidence,
    wikiContext,
    generatedAt,
  })
  const evidencePack = {
    schema: "company-evidence-pack-v1",
    generatedAt,
    company,
    cninfo,
    cninfoDownloads: downloads,
    tushare: {
      status: tushareEvidence.status,
      calls: tushareEvidence.calls,
      tables: tushareEvidence.tables,
      error: tushareEvidence.error,
    },
    tavily: tavilyEvidence,
    wikiContext: {
      query: wikiContext.query,
      counts: wikiContext.counts,
      retrievalWarnings: wikiContext.retrievalWarnings,
      wikiResults: (wikiContext.wikiResults ?? []).map(({ ref, path, title, score, type, snippet }) => ({ ref, path, title, score, type, snippet })),
      rawResults: (wikiContext.rawResults ?? []).map(({ ref, path, title, score, snippet }) => ({ ref, path, title, score, snippet })),
      graphExpansions: (wikiContext.graphExpansions ?? []).map(({ ref, path, title, score, reasons, from, snippet }) => ({ ref, path, title, score, reasons, from, snippet })),
      stockDailyResults: (wikiContext.stockDailyResults ?? []).map(({ ref, path, title, score, type, excerpt, nativeQuery }) => ({ ref, path, title, score, type, excerpt, nativeQuery })),
      marketValidation: wikiContext.marketValidation,
    },
  }
  const modelRows = buildCompanyWorkbookRows({ company, financials, ledger })
  const modelJson = {
    schema: COMPANY_RESEARCH_TEMPLATE_VERSION,
    generatedAt,
    company,
    sheets: Object.keys(modelRows),
    assumptions: modelRows.Assumptions.slice(1).map((row) => ({
      name: row[0],
      downside: row[1],
      base: row[2],
      upside: row[3],
      evidenceLevel: row[4],
      note: row[5],
    })),
    formulaPolicy: "formulas are deterministic template cells; LLM/provider text must not invent model formulas",
    evidenceRefs: ledger.rows.map((row, index) => ({ index: index + 1, dataItem: row.dataItem, evidenceLevel: row.evidenceLevel, status: row.status })),
  }
  const reportMarkdown = buildCompanyReportMarkdown({
    company,
    financials,
    ledger,
    cninfo,
    tavily: tavilyEvidence,
    wikiContext,
    generatedAt,
  })
  const wikiCandidatesMarkdown = buildWikiChangeCandidates({ company, wikiContext, ledger })
  const paths = {
    evidenceLedger: path.join(outputDir, "evidence-ledger.json"),
    evidencePack: path.join(outputDir, "evidence-pack.json"),
    financials: path.join(outputDir, "financials.json"),
    modelXlsx: path.join(outputDir, "company-model.xlsx"),
    modelJson: path.join(outputDir, "company-model.json"),
    report: path.join(outputDir, "company-report.md"),
    wikiCandidates: path.join(outputDir, "wiki-change-candidates.md"),
    runSummary: path.join(outputDir, "run-summary.json"),
  }
  await writeJson(paths.evidenceLedger, ledger)
  await writeJson(paths.evidencePack, evidencePack)
  await writeJson(paths.financials, financials)
  await writeCompanyWorkbook(paths.modelXlsx, modelRows)
  await writeJson(paths.modelJson, modelJson)
  await fs.writeFile(paths.report, reportMarkdown, "utf8")
  await fs.writeFile(paths.wikiCandidates, wikiCandidatesMarkdown, "utf8")
  const deep = options.deep
    ? await buildDeepCompanyResearchArtifacts({
        projectPath,
        outputDir,
        paths,
        company,
        financials,
        ledger,
        evidencePack,
        downloads,
        wikiCandidatesMarkdown,
        generatedAt,
        options,
      })
    : { enabled: false }
  const runSummary = {
    mode: "company-research",
    generatedAt,
    projectPath,
    outputDir: projectRelative(projectPath, outputDir),
    company,
    providers: {
      cninfo: { mode: "public_web_adapter", configured: true, status: cninfo.status, announcements: cninfo.announcements.length, downloads: downloads.filter((item) => item.status === "success").length },
      tushare: { configured: credentials.status.tushare.configured, auth: credentials.status.tushare.auth, status: tushareEvidence.status, calls: tushareEvidence.calls.length },
      tavily: { configured: credentials.status.tavily.configured, auth: credentials.status.tavily.auth, status: tavilyEvidence.status, queries: tavilyEvidence.queries.length },
      wiki: { configured: true, status: wikiContext.retrievalWarnings?.length ? "partial" : "success", counts: wikiContext.counts },
    },
    deep,
    outputs: {
      ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, projectRelative(projectPath, value)])),
      ...(deep.enabled ? deep.outputs : {}),
    },
    writePolicy: {
      wroteRaw: false,
      wroteFormalWiki: false,
      outputRoot: COMPANY_RESEARCH_ROOT,
    },
  }
  await writeJson(paths.runSummary, runSummary)
  return {
    ...runSummary,
    outputDirPath: outputDir,
    outputPaths: paths,
    ledger,
    financials,
  }
}

async function collectWikiDirs(projectPath) {
  try {
    const entries = await fs.readdir(path.join(projectPath, "wiki"), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => `wiki/${entry.name}/`)
      .sort()
  } catch {
    return []
  }
}

async function gitDirtyStatus(projectPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "status", "--short"], {
      maxBuffer: 1024 * 1024 * 4,
    })
    return stdout.trim().split(/\r?\n/).filter(Boolean)
  } catch (err) {
    return [`git status unavailable: ${err instanceof Error ? err.message : String(err)}`]
  }
}

function buildContextMarkdown({
  projectPath,
  sourcePath,
  sourceRelativePath,
  sourceHash,
  sourceContent,
  schema,
  purpose,
  index,
  overview,
  wikiDirs,
  candidates,
  temporalFactContext,
  methodologyContext,
  createdAt,
}) {
  const candidateLines = candidates.wikiCandidates
    .slice(0, 20)
    .map(
      (item, i) =>
        `${i + 1}. ${item.path} | score=${item.score} | type=${item.type} | title=${item.title}\n   ${item.snippet}`,
    )
    .join("\n")

  const rawLines = candidates.rawCandidates
    .slice(0, 12)
    .map((item, i) => `${i + 1}. ${item.path} | score=${item.score} | title=${item.title}\n   ${item.snippet}`)
    .join("\n")
  const segmentLines = segmentCandidateSummary(candidates.segments ?? [])

  return [
    "# Codex Text Ingest Context",
    "",
    "Use this context to produce an application-grade ingest manifest. This is not a summary-only task.",
    "",
    "## Critical Rules",
    "- Read the source as the primary evidence and preserve its operational meaning.",
    "- Put wiki/page/log changes only in `writes`; put temporal facts only in `factWrites`.",
    "- `writes` may write only `wiki/**`, `wiki/index.md`, `wiki/overview.md`, and daily logs in `wiki/logs/`.",
    `- \`factWrites\` may write only \`${TEMPORAL_FACTS_RELATIVE_PATH}\` and must never be mixed into \`writes\`.`,
    "- Never modify `raw/**`.",
    "- For updates, preserve existing page knowledge and merge the new source as additional evidence.",
    "- Use full-path wikilinks like `[[概念/XXX]]`.",
    "- Keep `related` frontmatter synchronized with `## 相关页面`.",
    "- Do not create deprecated directories such as `wiki/市场环境/` or `wiki/进化/`.",
    "- If a candidate page is relevant, update it instead of creating a duplicate.",
    "",
    "## Expected Manifest Shape",
    "```json",
    JSON.stringify(
      {
        $schema: MANIFEST_SCHEMA,
        projectPath,
        sourcePath,
        sourceRelativePath,
        sourceHash,
        writes: [
          {
            action: "update",
            path: "wiki/概念/示例.md",
            content: "FULL UPDATED FILE CONTENT",
          },
          {
            action: "append",
            path: dailyLogPathFromTimestamp(createdAt),
            content: "## [YYYY-MM-DD] ingest | source-name.md\\n- ...",
          },
        ],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "规范实体名",
            predicate: "HAS_CATALYST",
            object: "事件或事实对象",
            claim: "一句话事实",
            status: "active",
            evidenceLevel: "A|B|C|D",
            sourceKind: "official_announcement|broker_research|expert_meeting|media_report|social_chat|market_price",
            validAt: "YYYY-MM-DD",
            sourceDate: "YYYY-MM-DD",
            sourcePath: sourceRelativePath,
            sourceHash,
            wikiPath: "wiki/股票/示例.md",
            supersedes: [],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "## Project",
    `- projectPath: ${projectPath}`,
    `- sourcePath: ${sourcePath}`,
    `- sourceRelativePath: ${sourceRelativePath}`,
    `- sourceHash: ${sourceHash}`,
    `- createdAt: ${createdAt}`,
    `- wikiDirs: ${wikiDirs.join(", ") || "(none)"}`,
    "",
    "## Source Content",
    "```markdown",
    sourceContent,
    "```",
    "",
    "## Candidate Wiki Pages",
    candidateLines || "(no candidates found)",
    "",
    "## Related Raw Text Candidates",
    rawLines || "(no related raw text candidates found)",
    "",
    "## Segment Candidate Groups",
    segmentLines,
    "",
    formatTemporalFactContextMarkdown(temporalFactContext, { includeSegments: true }),
    "",
    ...(methodologyContext?.markdown ? [methodologyContext.markdown, ""] : []),
    "## schema.md",
    "```markdown",
    schema || "(missing schema.md)",
    "```",
    "",
    "## purpose.md",
    "```markdown",
    purpose || "(missing purpose.md)",
    "```",
    "",
    "## wiki/index.md",
    "```markdown",
    index || "(missing wiki/index.md)",
    "```",
    "",
    "## wiki/overview.md",
    "```markdown",
    overview || "(missing wiki/overview.md)",
    "```",
  ].join("\n")
}

function buildDryRunMarkdown({ sourceRelativePath, sourceHash, reportDir, candidates, dirtyStatus }) {
  const wikiRows = candidates.wikiCandidates
    .slice(0, 20)
    .map((item) => `- ${item.path} — score ${item.score}; ${item.snippet}`)
    .join("\n")
  const rawRows = candidates.rawCandidates
    .slice(0, 10)
    .map((item) => `- ${item.path} — score ${item.score}; ${item.snippet}`)
    .join("\n")
  const segmentRows = (candidates.segments ?? [])
    .slice(0, INGEST_SEGMENT_DEFAULT_MAX)
    .map((segment) => {
      const topWiki = (segment.wikiCandidates ?? [])
        .slice(0, 5)
        .map((item) => `  - ${item.path} — score ${item.score}; ${item.snippet}`)
        .join("\n")
      return [`- ${segment.id} ${segment.title}${segment.heat ? `｜热度：${segment.heat}` : ""}｜lines ${segment.lineStart}-${segment.lineEnd}`, `  preview: ${segment.textPreview}`, topWiki || "  - no wiki candidates"].join("\n")
    })
    .join("\n")
  const dirtyRows = dirtyStatus.length > 0 ? dirtyStatus.map((line) => `- ${line}`).join("\n") : "- clean"

  return [
    "# Codex Ingest Prepare Report",
    "",
    `- source: ${sourceRelativePath}`,
    `- sourceHash: ${sourceHash}`,
    `- reportDir: ${reportDir}`,
    "",
    "## Candidate Wiki Pages",
    wikiRows || "- none",
    "",
    "## Related Raw Candidates",
    rawRows || "- none",
    "",
    "## Segment Candidate Groups",
    segmentRows || "- none",
    "",
    "## Temporal Fact Context",
    "- See context.md and candidate-pages.json for entity candidates, related temporal facts, and segment fact seeds.",
    "",
    "## Git Dirty Status",
    dirtyRows,
    "",
    "## Next Step",
    "Fill `changes.template.json` as `changes.json`, then run:",
    "",
    "```sh",
    "npm run codex:ingest -- apply --manifest <changes.json>",
    "npm run codex:ingest -- apply --manifest <changes.json> --write",
    "```",
  ].join("\n")
}

export async function prepareIngest(options) {
  const projectPath = resolveProjectPath(options)
  const sourcePath = normalizePath(options.sourcePath)
  if (!isTextSourcePath(sourcePath)) {
    throw new Error(`Unsupported source type for text ingest: ${sourcePath}`)
  }

  const fullSourceContent = sanitizeTextControlCharacters(await readTextFile(sourcePath))
  const sourceHash = shortHash(fullSourceContent)
  const sourceContent = compactSourceContentForPrompt(fullSourceContent, sourcePath, sourceHash)
  const sourceRelativePath = projectRelative(projectPath, sourcePath)
  const createdAt = nowLocalTimestamp()

  const dailyLogPath = dailyLogPathFromTimestamp(createdAt)
  const [schema, purpose, index, overview, log, dailyLog, wikiDirs, dirtyStatus, candidates, methodologyContext] = await Promise.all([
    readIfExists(options.schemaPath ? normalizePath(options.schemaPath) : path.join(projectPath, "schema.md")),
    readIfExists(path.join(projectPath, "purpose.md")),
    readIfExists(path.join(projectPath, "wiki/index.md")),
    readIfExists(path.join(projectPath, "wiki/overview.md")),
    readIfExists(path.join(projectPath, "wiki/log.md")),
    readIfExists(path.join(projectPath, dailyLogPath)),
    collectWikiDirs(projectPath),
    gitDirtyStatus(projectPath),
    searchCandidatePages(projectPath, sourcePath, fullSourceContent, options.search ?? {}),
    buildMethodologyContext(projectPath, options.methodologyContext ?? options.methodology ?? {}),
  ])
  const temporalFactContext = await buildTemporalFactContext({
    projectPath,
    sourcePath,
    sourceContent: fullSourceContent,
    candidates,
    options: options.temporalFacts ?? {},
  })

  const reportId = options.reportId ?? makeReportId(sourcePath)
  const reportDir = path.join(projectPath, REPORT_ROOT, reportId)
  const manifestTemplate = {
    $schema: MANIFEST_SCHEMA,
    mode: "dry-run",
    generatedBy: "codex-ingest prepare",
    createdAt,
    projectPath,
    sourcePath,
    sourceRelativePath,
    sourceHash,
    factWrites: [],
    writes: [],
  }

  const contextMarkdown = buildContextMarkdown({
    projectPath,
    sourcePath,
    sourceRelativePath,
    sourceHash,
    sourceContent,
    schema,
    purpose,
    index,
    overview,
    wikiDirs,
    candidates,
    temporalFactContext,
    methodologyContext,
    createdAt,
  })

  const dryRunMarkdown = buildDryRunMarkdown({
    sourceRelativePath,
    sourceHash,
    reportDir,
    candidates,
    dirtyStatus,
  })

  if (!options.noReport) {
    await ensureDirectory(reportDir)
    await fs.writeFile(path.join(reportDir, "context.md"), contextMarkdown, "utf8")
    await writeJson(path.join(reportDir, "candidate-pages.json"), {
      source: sourceRelativePath,
      sourceHash,
      tokens: candidates.tokens,
      wikiCandidates: candidates.wikiCandidates,
      rawCandidates: candidates.rawCandidates,
      segments: candidates.segments ?? [],
      temporalFactContext,
    })
    await writeJson(path.join(reportDir, "methodology-context.json"), methodologyContext)
    await writeJson(path.join(reportDir, "changes.template.json"), manifestTemplate)
    await fs.writeFile(path.join(reportDir, "dry-run.md"), dryRunMarkdown, "utf8")
  }

  return {
    projectPath,
    sourcePath,
    sourceRelativePath,
    sourceHash,
    sourceContent,
    schema,
    purpose,
    index,
    overview,
    log,
    dailyLog,
    dailyLogPath,
    wikiDirs,
    createdAt,
    reportDir,
    contextMarkdown,
    dryRunMarkdown,
    manifestTemplate,
    candidates,
    temporalFactContext,
    methodologyContext,
    dirtyStatus,
  }
}

export function cleanBlockPath(raw) {
  let p = raw.trim()
  const pairs = [["**", "**"], ["`", "`"], ["<", ">"], ['"', '"'], ["'", "'"]]
  let changed = true
  while (changed) {
    changed = false
    for (const [left, right] of pairs) {
      if (p.startsWith(left) && p.endsWith(right) && p.length > left.length + right.length) {
        p = p.slice(left.length, p.length - right.length).trim()
        changed = true
      }
    }
  }
  return p
}

export function parseFileBlocks(text) {
  const fencedRegex = /^(`{3,})FILE:?\s*(.+?)\s*\r?\n([\s\S]*?)^\1\s*$/gm
  const fencedBlocks = []
  let fencedMatch
  while ((fencedMatch = fencedRegex.exec(text)) !== null) {
    const filePath = cleanBlockPath(fencedMatch[2])
    if (filePath) fencedBlocks.push({ path: filePath, content: fencedMatch[3].replace(/\r?\n$/, "") })
  }
  if (fencedBlocks.length > 0) return fencedBlocks

  const startRegex = /-{2,}\s*FILE:\s*(.+?)\s*-{2,}\r?\n/g
  const starts = []
  let match
  while ((match = startRegex.exec(text)) !== null) {
    const filePath = cleanBlockPath(match[1])
    if (filePath) starts.push({ path: filePath, markerStart: match.index, contentStart: match.index + match[0].length })
  }
  const blocks = []
  const endRegex = /-{2,}\s*END\s+FILE\s*-{2,}/i
  for (let i = 0; i < starts.length; i++) {
    const { path: blockPath, contentStart } = starts[i]
    const sliceEnd = i + 1 < starts.length ? starts[i + 1].markerStart : text.length
    const segment = text.slice(contentStart, sliceEnd)
    const endMatch = endRegex.exec(segment)
    const content = endMatch ? segment.slice(0, endMatch.index).replace(/\r?\n$/, "") : segment.replace(/\r?\n$/, "")
    blocks.push({ path: blockPath, content })
  }
  return blocks
}

export function parseManifestFromModelText(text, baseManifest) {
  try {
    const parsed = parseModelJson(text)
    if (parsed && Array.isArray(parsed.writes)) return { ...baseManifest, ...parsed }
  } catch {
    // Fall through to FILE block parsing.
  }
  const blocks = parseFileBlocks(text)
  if (blocks.length === 0) {
    throw new Error("Model output did not contain a manifest JSON object or FILE blocks")
  }
  return {
    ...baseManifest,
    writes: blocks.map((block) => ({
      action: isLogPath(block.path) ? "append" : "update",
      path: block.path,
      content: block.content,
    })),
  }
}

export function parsePlanFromModelText(text) {
  const parsed = parseModelJson(text)
  const create = Array.isArray(parsed?.create) ? parsed.create : []
  const update = Array.isArray(parsed?.update) ? parsed.update : []
  const factWrites = Array.isArray(parsed?.factWrites) ? parsed.factWrites : []
  return {
    create: create.map((item) => ({
      path: item.path,
      type: item.type,
      title: item.title,
      why: item.why ?? "",
    })),
    update: update.map((item) => ({
      path: item.path,
      why: item.why ?? "",
    })),
    factWrites,
  }
}

function pathToTitle(relativePath) {
  return path.posix.basename(relativePath, ".md").replace(/-/g, " ")
}

function sourceArchivePath(sourceBaseName) {
  return `wiki/sources/${sourceBaseName}.md`
}

function normalizePlanPath(rawPath) {
  return assertSafeWikiPath(String(rawPath ?? "").trim())
}

export async function normalizeIngestPlan(projectPath, plan, sourceBaseName) {
  const pp = normalizePath(projectPath)
  const sourcePath = sourceArchivePath(sourceBaseName)
  const seen = new Set()
  const create = []
  const update = []

  async function addItem(rawItem, preferredAction, forced = false) {
    const safePath = normalizePlanPath(rawItem.path)
    if (seen.has(safePath)) return
    seen.add(safePath)
    const targetExists = await exists(path.join(pp, safePath))
    const action = targetExists ? "update" : "create"
    const why = rawItem.why || (forced ? "归档本次 source 的清洗版证据页，供后续知识页引用。" : "")
    if (action === "update") {
      update.push({ path: safePath, why })
    } else {
      create.push({
        path: safePath,
        type: normalizeTypeAlias(rawItem.type) ?? inferTypeFromPath(safePath),
        title: rawItem.title || pathToTitle(safePath),
        why,
      })
    }
  }

  await addItem(
    {
      path: sourcePath,
      type: "源文档",
      title: sourceBaseName,
      why: "归档本次 source 的清洗版证据页，供后续概念、模式、错误和策略页面引用。",
    },
    "create",
    true,
  )

  for (const item of plan.create ?? []) await addItem(item, "create")
  for (const item of plan.update ?? []) await addItem(item, "update")

  return { create, update, factWrites: Array.isArray(plan.factWrites) ? plan.factWrites : [] }
}

function parseOptionalPositiveInteger(value) {
  if (value == null || value === "") return null
  return parsePositiveInteger(value, null)
}

function assessIngestPlanBudget(plan, options = {}) {
  const createCount = plan.create?.length ?? 0
  const updateCount = plan.update?.length ?? 0
  const pageCount = createCount + updateCount
  const limits = [
    ["maxPlanItems", parseOptionalPositiveInteger(options.maxPlanItems), pageCount, "planned wiki page writes"],
    ["maxCreatePages", parseOptionalPositiveInteger(options.maxCreatePages), createCount, "planned creates"],
    ["maxUpdatePages", parseOptionalPositiveInteger(options.maxUpdatePages), updateCount, "planned updates"],
  ]
  const violations = limits
    .filter(([, limit, actual]) => limit != null && actual > limit)
    .map(([field, limit, actual, label]) => `${label} ${actual} exceeds --${field.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)} ${limit}`)
  return {
    counts: {
      create: createCount,
      update: updateCount,
      pageWrites: pageCount,
      factWrites: plan.factWrites?.length ?? 0,
    },
    limits: {
      maxPlanItems: parseOptionalPositiveInteger(options.maxPlanItems),
      maxCreatePages: parseOptionalPositiveInteger(options.maxCreatePages),
      maxUpdatePages: parseOptionalPositiveInteger(options.maxUpdatePages),
    },
    warnings: violations,
  }
}

function planItemsInGenerationOrder(plan, sourceBaseName) {
  const sourcePath = sourceArchivePath(sourceBaseName)
  const items = [
    ...plan.update.map((item) => ({ ...item, action: "update", type: inferTypeFromPath(item.path), title: pathToTitle(item.path) })),
    ...plan.create.map((item) => ({ ...item, action: "create" })),
  ]
  return items.sort((a, b) => {
    if (a.path === sourcePath) return -1
    if (b.path === sourcePath) return 1
    if (a.action !== b.action) return a.action === "update" ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

function candidateSummary(candidates, wikiLimit = 30, rawLimit = 12) {
  const formatMatchedSegments = (item) => {
    const segments = item.matchedSegments ?? []
    if (!segments.length) return ""
    return ` | matchedSegments=${segments.map((segment) => segment.title).join(" / ")}`
  }
  const wiki = candidates.wikiCandidates
    .slice(0, wikiLimit)
    .map(
      (item, i) =>
        `${i + 1}. ${item.path} | score=${item.score} | type=${item.type} | title=${item.title}${formatMatchedSegments(item)}\n   ${item.snippet}`,
    )
    .join("\n")
  const raw = candidates.rawCandidates
    .slice(0, rawLimit)
    .map((item, i) => `${i + 1}. ${item.path} | score=${item.score} | title=${item.title}${formatMatchedSegments(item)}\n   ${item.snippet}`)
    .join("\n")
  return { wiki: wiki || "(none)", raw: raw || "(none)", segments: segmentCandidateSummary(candidates.segments ?? []) }
}

function segmentCandidateSummary(segments, segmentLimit = INGEST_SEGMENT_DEFAULT_MAX, wikiLimit = 6, rawLimit = 3) {
  if (!segments.length) return "(none)"
  return segments
    .slice(0, segmentLimit)
    .map((segment, i) => {
      const wikiRows = (segment.wikiCandidates ?? [])
        .slice(0, wikiLimit)
        .map((item, j) => `${j + 1}. ${item.path} | score=${item.score} | type=${item.type} | title=${item.title}\n      ${item.snippet}`)
        .join("\n")
      const rawRows = (segment.rawCandidates ?? [])
        .slice(0, rawLimit)
        .map((item, j) => `${j + 1}. ${item.path} | score=${item.score} | title=${item.title}\n      ${item.snippet}`)
        .join("\n")
      return [
        `### ${i + 1}. ${segment.id} ${segment.title}${segment.heat ? ` | heat=${segment.heat}` : ""}${segment.sourceGroups ? ` | groups=${segment.sourceGroups}` : ""} | lines=${segment.lineStart}-${segment.lineEnd}`,
        `preview: ${segment.textPreview}`,
        "Wiki candidates:",
        wikiRows || "(none)",
        "Raw candidates:",
        rawRows || "(none)",
      ].join("\n")
    })
    .join("\n\n")
}

function formatTemporalFactContextMarkdown(context, options = {}) {
  if (!context) return "## Temporal Fact Context\n\n- none"
  const entityRows = (context.entityCandidates ?? [])
    .slice(0, 16)
    .map((item) => `- ${item.entityKey} | ${item.canonicalSubject}${item.stockCode ? ` | ${item.stockCode}` : ""} | score=${item.score} | reasons=${(item.reasons ?? []).join("; ")}`)
    .join("\n")
  const factRows = (context.relatedFacts ?? [])
    .slice(0, 18)
    .map((item) => {
      const object = item.object ? ` -> ${item.object}` : ""
      const claim = item.claim ? ` | claim=${item.claim}` : ""
      return `- ${item.id} | line=${item.line} | status=${item.status} | ${item.entityKey ?? item.canonicalSubject ?? "unknown"} | ${item.predicate ?? "FACT"}${object} | validAt=${item.validAt ?? "?"}${claim}`
    })
    .join("\n")
  const rows = [
    "## Temporal Fact Context",
    "",
    `- factsPath: ${context.factsPath}`,
    `- indexPath: ${context.indexPath}`,
    `- counts: total=${context.counts?.totalFacts ?? 0}; active=${context.counts?.activeFacts ?? 0}; inactive=${context.counts?.inactiveFacts ?? 0}; related=${context.counts?.relatedFacts ?? 0}; segmentSeeds=${context.counts?.segmentFactSeeds ?? 0}`,
    "",
    "### Entity Candidates",
    entityRows || "- none",
    "",
    "### Related Existing Temporal Facts",
    factRows || "- none",
  ]
  if (options.includeSegments) {
    const segmentRows = (context.segmentFactSeeds ?? [])
      .slice(0, INGEST_SEGMENT_DEFAULT_MAX)
      .map((segment) => {
        const entities = (segment.entityCandidates ?? []).slice(0, 6).map((item) => item.entityKey).join(", ") || "none"
        const facts = (segment.relatedFacts ?? []).slice(0, 6).map((item) => `${item.id}:${item.status}`).join(", ") || "none"
        const tokens = (segment.tokens ?? []).slice(0, 12).join(", ") || "none"
        return [`- ${segment.id} ${segment.title}${segment.heat ? ` | heat=${segment.heat}` : ""} | lines=${segment.lineStart}-${segment.lineEnd}`, `  entities: ${entities}`, `  relatedFacts: ${facts}`, `  tokens: ${tokens}`, `  preview: ${segment.textPreview}`].join("\n")
      })
      .join("\n")
    rows.push("", "### Segment Fact Seeds", segmentRows || "- none")
  }
  return rows.join("\n")
}

function buildAnalysisStagePrompt(prepared) {
  const candidates = candidateSummary(prepared.candidates)
  const hasSegments = (prepared.candidates.segments ?? []).length > 0
  return [
    "# Stage 1/4: 分析源文档",
    "",
    "请像桌面应用摄入一样阅读 source，并生成结构化分析。不要只做摘要；要说明它应如何接入既有 wiki 知识网络。",
    "",
    "## 输出要求",
    "- 使用 Markdown。",
    "- 先判断 source 类型（如日复盘、微信舆情、研报新闻、夜间交流、OpenClaw 文本）。",
    "- 提炼核心结论、时间线/传播路径、重要主题、可沉淀概念、可沉淀模式、错误/交易纪律。",
    "- 明确区分事实强度：公告/财报/政策/权威报道/研报推演/群聊传闻/小作文。",
    "- 明确列出建议更新已有页面和建议新建页面。",
    hasSegments ? "- 本 source 已启用分段候选定位：按 Segment Candidate Groups 逐段判断主题，不要只围绕全局 Top 候选或最热主题。" : "",
    hasSegments ? "- 对多主题微信/夜间交流源，高热主线可进入概念/股票/模式/错误页；中等主题优先更新已有页；低证据小主题只进 source archive 或分析。" : "",
    "- 不要把高舆情直接写成高事实强度。",
    "",
    ...(prepared.methodologyContext?.markdown ? [prepared.methodologyContext.markdown, ""] : []),
    "## Source",
    `- sourceRelativePath: ${prepared.sourceRelativePath}`,
    `- sourceHash: ${prepared.sourceHash}`,
    "",
    "```markdown",
    prepared.sourceContent,
    "```",
    "",
    "## Candidate Wiki Pages",
    candidates.wiki,
    "",
    "## Related Raw Text Candidates",
    candidates.raw,
    "",
    "## Segment Candidate Groups",
    candidates.segments,
    "",
    "## purpose.md",
    "```markdown",
    prepared.purpose || "(missing purpose.md)",
    "```",
    "",
    "## wiki/index.md",
    "```markdown",
    prepared.index ? compactPreview(prepared.index, 260) : "(missing wiki/index.md)",
    "```",
    "",
    "## wiki/overview.md",
    "```markdown",
    prepared.overview ? compactPreview(prepared.overview, 220) : "(missing wiki/overview.md)",
    "```",
  ].join("\n")
}

function buildPlanStagePrompt({ prepared, analysis, sourceBaseName }) {
  const candidates = candidateSummary(prepared.candidates)
  const hasSegments = (prepared.candidates.segments ?? []).length > 0
  return [
    "# Stage 2/4: 规划变更",
    "",
    "根据 Stage 1 分析生成 create/update 计划。输出必须是单个 ```json fenced block，不要输出额外文字。",
    "",
    "## JSON Shape",
    "```json",
    JSON.stringify(
      {
        create: [{ path: `wiki/sources/${sourceBaseName}.md`, type: "源文档", title: sourceBaseName, why: "..." }],
        update: [{ path: "wiki/模式/当前市场阶段判断.md", why: "..." }],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "股票或概念名",
            predicate: "HAS_CATALYST|HAS_ORDER|CONTRADICTS|VALIDATES",
            object: "事件/事实对象",
            claim: "一句话事实，不写推测成真",
            status: "active",
            evidenceLevel: "A|B|C|D",
            sourceKind: "official_announcement|broker_research|expert_meeting|media_report|social_chat|market_price",
            validAt: "YYYY-MM-DD",
            sourceDate: "YYYY-MM-DD",
            sourcePath: prepared.sourceRelativePath,
            sourceHash: prepared.sourceHash,
            wikiPath: "wiki/股票/示例.md",
            supersedes: [],
          },
        ],
      },
      null,
      2,
    ),
    "```",
    "",
    "## Rules",
    `- 必须包含 source archive：wiki/sources/${sourceBaseName}.md。`,
    "- 规划可以发散，但要优先更新已有同义/上位页面，只有独立复用价值明确时才新建。",
    hasSegments ? "- 本 source 是多主题分段候选：采用更充分写入策略，允许多个重要 segment 进入计划，但同一页面跨 segment 命中时只规划一次，并在 why 中合并 matchedSegments/主题理由。" : "",
    hasSegments ? "- 微信舆情/夜间交流默认可规划约 10-18 个已有正式页更新、2-5 个新建页；新建页必须没有高匹配已有页，且主题有持续复用价值，不只是单条群聊转发。" : "",
    hasSegments ? "- 日复盘/总结页只作为背景候选；除非 source 明确是日复盘，否则不要让总结页压过概念页、股票页、模式页和错误页。" : "",
    hasSegments ? "- 低证据小主题可以只进入 source archive；不要为了覆盖每个 segment 而强行新建低价值页面。" : "",
    "- 不要规划 raw/**，不要规划已废弃目录 wiki/市场环境/ 或 wiki/进化/。",
    "- `wiki/index.md`、`wiki/overview.md`、`wiki/log.md`、`wiki/logs/**` 不要出现在计划中；Stage 4 会统一处理。",
    `- 如果 source 给出可独立复用的时间敏感事实，可以在 factWrites 中规划 temporal edge；path 必须是 ${TEMPORAL_FACTS_RELATIVE_PATH}，不要把事实 JSONL 放进 writes。`,
    `- factWrites predicate 只能使用：${TEMPORAL_FACT_PREDICATES.join(" / ")}。`,
    `- factWrites status 只能使用：${TEMPORAL_FACT_STATUSES.join(" / ")}。`,
    `- evidenceLevel 只能是 ${TEMPORAL_FACT_EVIDENCE_LEVELS.join(" / ")}；sourceKind 只能是 ${TEMPORAL_FACT_SOURCE_KINDS.join(" / ")}。`,
    "- factWrites 只写明确事实、撤销/证伪/替代关系和验证结果；传闻、小作文或无时间锚的弱观点不要写入 factWrites。",
    "- C/D 证据如果进入 factWrites，claim 必须明确写成传闻/待验证/观察项，不能写成已确认事实。",
    "- 如果新事实推翻旧事实，在新事实里填写 supersedes/invalidates/contradicts 的旧 fact id；不要直接改旧 JSONL 行。",
    "- 优先使用 Temporal Fact Context 中的 entityKey/canonicalSubject/stockCode；长文多主题时按 Segment Fact Seeds 逐段判断事实，避免把不同 segment 的公司/事件混写成一条 fact。",
    "- Related Existing Temporal Facts 给出了可 supersede 的旧 fact id；如果上下文里没有命中旧 fact，不要编造旧 id，可以新增 active fact 或用 claim 说明待后续匹配。",
    "- 概念/模式/错误/策略等正式页正文软上限为 2000 行。",
    "",
    ...(prepared.methodologyContext?.markdown ? [prepared.methodologyContext.markdown, ""] : []),
    "## Stage 1 Analysis",
    analysis,
    "",
    "## Candidate Wiki Pages",
    candidates.wiki,
    "",
    "## Segment Candidate Groups",
    candidates.segments,
    "",
    formatTemporalFactContextMarkdown(prepared.temporalFactContext, { includeSegments: true }),
    "",
    "## Existing Index",
    "```markdown",
    prepared.index ? compactPreview(prepared.index, 360) : "(missing wiki/index.md)",
    "```",
    "",
    "## schema.md",
    "```markdown",
    prepared.schema || "(missing schema.md)",
    "```",
  ].join("\n")
}

function schemaPromptSection(nowTs) {
  return [
    "## Frontmatter Schema",
    "- 每个 wiki 页面必须用裸 `---` YAML frontmatter 开头，不能包在 ```yaml 里。",
    "- 必填字段：schema_version: 1, title, type, summary, tags, related, sources, created, updated, last_reviewed, confidence, status。",
    `- 时间字段格式为 YYYY-MM-DD HH:mm:ss；新建页面使用 ${nowTs}。`,
    `- type 只能使用：${WIKI_TYPES.join(" / ")}。`,
    `- confidence：${CONFIDENCE.join(" / ")}；status：${WIKI_STATUS.join(" / ")}。`,
    "- related 使用完整 wikilink，例如 \"[[概念/催化剂层级框架]]\"。",
    "- sources 必须包含本次 source 文件名（不带 .md）。",
    "- 概念页可以使用 parent、momentum（热/活跃/降温/已死）、catalysts。",
    `- 正文软上限 ${PAGE_BODY_LINE_SOFT_LIMIT} 行；超过也可校验通过，但应尽量清洗、归纳，不要复制 raw 全文。`,
  ].join("\n")
}

function buildPageFilePrompt({ prepared, item, existingContent, analysis, sourceBaseName, nowTs }) {
  const sourceArchive = item.path === sourceArchivePath(sourceBaseName)
  const type = normalizeTypeAlias(item.type) ?? inferTypeFromPath(item.path)
  return [
    `# Stage 3/4: ${item.action === "update" ? "更新" : "生成"} ${item.path}`,
    "",
    "输出 exactly one FILE block，不要输出 FILE block 之外的文字：",
    `---FILE: ${item.path}---`,
    "(完整 Markdown 文件内容，含 YAML frontmatter)",
    "---END FILE---",
    "",
    "## Writing Rules",
    sourceArchive
      ? "- 这是 source archive：生成清洗后的证据档案，保留传播路径、关键原始节点、证据强度和后续引用依据；不要直接完整复制 raw。"
      : "- 这是正式知识页：不要写成摘要。按应用风格写成可复用知识结构，包含定义/事实强度/链条/交易框架/风险/后续观察。",
    item.action === "update"
      ? "- 这是 update：必须保留旧页面已有理解，只追加或合并新 evidence；不要重写成只有本次 source 的页面。"
      : "- 这是 create：页面必须独立可复用，且与现有页面形成 related/wikilink 网络。",
    "- 对群聊、小作文、研报强 Call、目标市值等必须降权，不能写成已验证事实。",
    "- 当日盘面数值不要在概念/模式/错误页大段复制；必要时链接到总结或 source archive。",
    `- 本次页面 path 必须是 ${item.path}，title 应匹配文件名。`,
    "",
    ...(prepared.methodologyContext?.stage3Rules ? [prepared.methodologyContext.stage3Rules, ""] : []),
    schemaPromptSection(nowTs),
    "",
    "## Planned Change",
    `- action: ${item.action}`,
    `- type: ${type}`,
    `- title: ${item.title || pathToTitle(item.path)}`,
    `- why: ${item.why || "(none)"}`,
    "",
    item.action === "update"
      ? ["## Existing Full Page", "```markdown", existingContent || "(missing)", "```"].join("\n")
      : "",
    "",
    "## Stage 1 Analysis",
    analysis,
    "",
    "## Source Content",
    "```markdown",
    prepared.sourceContent,
    "```",
    "",
    "## schema.md",
    "```markdown",
    prepared.schema || "(missing schema.md)",
    "```",
  ]
    .filter(Boolean)
    .join("\n")
}

function generatedFilesSummary(writes) {
  return writes
    .map((write) => {
      const title = extractTitle(write.content, write.path)
      const { fm, body } = parseFrontmatter(write.content)
      const summary = typeof fm.summary === "string" ? fm.summary : body.slice(0, 180).replace(/\s+/g, " ")
      return `- ${write.path} (${write.action}) — ${title}: ${summary}`
    })
    .join("\n")
}

function tailLines(text, maxLines) {
  const lines = String(text ?? "").split(/\r?\n/)
  return lines.slice(-maxLines).join("\n")
}

function indexSectionName(relativePath) {
  const match = String(relativePath ?? "").match(/^wiki\/([^/]+)\//)
  return match?.[1] ?? "other"
}

function wikiIndexStem(relativePath) {
  return String(relativePath ?? "").replace(/^wiki\//, "").replace(/\.md$/i, "")
}

function hasIndexEntry(indexContent, stem) {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\[\\[${escaped}(?:\\||\\]\\])`).test(indexContent)
}

function indexEntryForWrite(write) {
  const stem = wikiIndexStem(write.path)
  const title = extractTitle(write.content, write.path)
  const display = title && title !== path.posix.basename(stem) ? `|${title}` : ""
  const { fm, body } = parseFrontmatter(write.content)
  const summary = typeof fm.summary === "string" && fm.summary.trim()
    ? fm.summary.trim()
    : body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? ""
  return `- [[${stem}${display}]]${summary ? ` - ${summary.replace(/\s+/g, " ").slice(0, 180)}` : ""}`
}

function mergeIndexEntriesText(existingIndex, pageWrites) {
  let next = String(existingIndex ?? "").trim() ? String(existingIndex).replace(/\s*$/, "") : "# Wiki Index"
  const additionsBySection = new Map()

  for (const write of pageWrites) {
    if (!write?.path?.startsWith("wiki/") || !write.path.endsWith(".md")) continue
    if (isReservedWikiPath(write.path)) continue
    const stem = wikiIndexStem(write.path)
    if (!stem || hasIndexEntry(next, stem)) continue
    const section = indexSectionName(write.path)
    if (!additionsBySection.has(section)) additionsBySection.set(section, [])
    additionsBySection.get(section).push(indexEntryForWrite(write))
  }

  for (const [section, lines] of additionsBySection.entries()) {
    if (!lines.length) continue
    const header = `## ${section}`
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`(^|\\n)${escapedHeader}\\n`).exec(next)
    if (match) {
      const insertAt = match.index + match[0].length
      next = `${next.slice(0, insertAt)}${lines.join("\n")}\n${next.slice(insertAt)}`
    } else {
      next = `${next}\n\n${header}\n${lines.join("\n")}`
    }
  }

  return `${next.replace(/\s*$/, "")}\n`
}

function buildProgrammaticDailyLog({ pageWrites, sourceBaseName, nowTs }) {
  const day = nowTs.slice(0, 10)
  const rows = [`## [${day}] ingest | ${sourceBaseName}.md`, ""]
  const creates = pageWrites.filter((write) => write.action === "create")
  const updates = pageWrites.filter((write) => write.action !== "create")
  rows.push(`- pages: ${pageWrites.length}; created: ${creates.length}; updated: ${updates.length}`)
  for (const write of pageWrites.slice(0, 30)) {
    rows.push(`- ${write.action}: [[${wikiIndexStem(write.path)}]]`)
  }
  if (pageWrites.length > 30) rows.push(`- ... ${pageWrites.length - 30} more page writes`)
  return `${rows.join("\n")}\n`
}

function buildProgrammaticOverview(existingOverview, pageWrites, sourceBaseName, nowTs) {
  const base = String(existingOverview ?? "").trim()
    ? String(existingOverview).replace(/\s*$/, "")
    : "# Wiki Overview\n\nThis overview is intentionally minimal until the wiki has a curated global summary."
  const day = String(nowTs ?? nowLocalTimestamp()).slice(0, 10)
  const source = `${sourceBaseName}.md`
  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (new RegExp(`^- \\d{4}-\\d{2}-\\d{2}: ${escapedSource}(?:\\s|$)`, "m").test(base)) return `${base}\n`

  const links = pageWrites
    .filter((write) => write?.path?.startsWith("wiki/") && write.path.endsWith(".md") && !isReservedWikiPath(write.path))
    .slice(0, 8)
    .map((write) => `[[${wikiIndexStem(write.path)}]]`)
    .join(", ")
  const more = pageWrites.length > 8 ? `, +${pageWrites.length - 8} more` : ""
  const line = `- ${day}: ${source}${links ? ` - ${links}${more}` : ""}`
  const headerMatch = /(^|\n)## Recent Ingests\n/.exec(base)
  if (!headerMatch) return `${base}\n\n## Recent Ingests\n${line}\n`
  const insertAt = headerMatch.index + headerMatch[0].length
  return `${base.slice(0, insertAt)}${line}\n${base.slice(insertAt).replace(/^\n/, "")}\n`
}

function renderHousekeepingArtifact(writes) {
  return writes
    .map((write) => [`---FILE: ${write.path}---`, write.content.replace(/\s*$/, ""), "---END FILE---"].join("\n"))
    .join("\n\n")
}

function buildProgrammaticHousekeepingWrites({ prepared, pageWrites, sourceBaseName, nowTs }) {
  const logPath = dailyLogPathFromTimestamp(nowTs)
  const writes = [
    {
      action: "update",
      path: "wiki/index.md",
      content: mergeIndexEntriesText(prepared.index, pageWrites),
    },
    {
      action: "update",
      path: "wiki/overview.md",
      content: buildProgrammaticOverview(prepared.overview, pageWrites, sourceBaseName, nowTs),
    },
    {
      action: "append",
      path: logPath,
      content: buildProgrammaticDailyLog({ pageWrites, sourceBaseName, nowTs }),
    },
  ]
  return { writes, artifact: renderHousekeepingArtifact(writes) }
}

function buildHousekeepingPrompt({ prepared, plan, analysis, pageWrites, sourceBaseName, nowTs }) {
  const logPath = dailyLogPathFromTimestamp(nowTs)
  return [
    "# Stage 4/4: 汇总 index / overview / log",
    "",
    `请输出 exactly three FILE blocks：wiki/index.md、wiki/overview.md、${logPath}。`,
    "",
    "## Rules",
    "- wiki/index.md：输出完整更新后文件，保留全部旧条目，加入本次新增/重要更新页面。",
    "- wiki/overview.md：输出完整更新后文件；只有当整体主线、市场阶段或风险原则变化时才实质更新，否则保留原文并做最小补充。",
    `- ${logPath}：只输出本次要 append 的日志条目，不要输出完整旧 log。格式：## [${nowTs.slice(0, 10)}] ingest | ${sourceBaseName}.md。`,
    "- 不要输出 wiki/log.md；旧的 wiki/log.md 只是历史遗留文件。",
    "- 不要输出 FILE block 之外的文字。",
    "",
    "## Generated/Updated Pages",
    generatedFilesSummary(pageWrites),
    "",
    "## Normalized Plan",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
    "",
    "## Stage 1 Analysis",
    analysis,
    "",
    "## Existing wiki/index.md",
    "```markdown",
    prepared.index || "(missing wiki/index.md)",
    "```",
    "",
    "## Existing wiki/overview.md",
    "```markdown",
    prepared.overview || "(missing wiki/overview.md)",
    "```",
    "",
    `## Existing ${logPath}`,
    "如果为空，说明今天的分片日志尚未创建。",
    "```markdown",
    prepared.dailyLog || `(missing ${logPath})`,
    "```",
    "",
    "## Legacy wiki/log.md Tail",
    "只给旧总日志尾部上下文用于避免重复；不要返回完整旧 log，也不要继续写 wiki/log.md。",
    "```markdown",
    tailLines(prepared.log || "(missing wiki/log.md)", 160),
    "```",
  ].join("\n")
}

function assertSafeWikiPath(relativePath) {
  const normalized = toPosixPath(relativePath).replace(/^\/+/, "")
  if (!normalized.startsWith("wiki/")) throw new Error(`Refusing to write outside wiki/: ${relativePath}`)
  if (normalized.includes("..")) throw new Error(`Refusing path traversal: ${relativePath}`)
  if (!normalized.endsWith(".md")) throw new Error(`Only markdown wiki files are supported: ${relativePath}`)
  return normalized
}

async function nextAvailableWikiPath(projectPath, relativePath) {
  const parsed = path.posix.parse(relativePath)
  let candidate = relativePath
  let i = 1
  while (await exists(path.join(projectPath, candidate))) {
    candidate = path.posix.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`)
    i += 1
  }
  return candidate
}

function wikiStem(relativePath) {
  return relativePath.replace(/^wiki\//, "").replace(/\.md$/i, "")
}

function rewriteCollisionReferences(content, collisionMap) {
  let out = content
  for (const [fromPath, toPath] of collisionMap.entries()) {
    const fromStem = wikiStem(fromPath)
    const toStem = wikiStem(toPath)
    out = out.split(fromPath).join(toPath)
    out = out.split(`[[${fromStem}]]`).join(`[[${toStem}]]`)
  }
  return out
}

function normalizeManifestWrites(manifest) {
  const writes = manifest.writes ?? manifest.files
  if (!Array.isArray(writes)) throw new Error("Manifest must contain a writes array")
  return writes.map((write) => ({
    action: write.action ?? "update",
    path: write.path ?? write.relativePath,
    content: write.content ?? "",
  }))
}

function compactPreview(text, maxLines = 80) {
  const lines = text.split(/\r?\n/)
  const preview = lines.slice(0, maxLines).join("\n")
  return lines.length > maxLines ? `${preview}\n... (${lines.length - maxLines} more lines)` : preview
}

function buildSimpleDiff(before, after) {
  if (before === after) return "(no content changes)"
  return [
    "--- before",
    "+++ after",
    "@@ before preview @@",
    compactPreview(before || "(new file)", 40)
      .split("\n")
      .map((line) => `- ${line}`)
      .join("\n"),
    "@@ after preview @@",
    compactPreview(after || "(empty)", 40)
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n"),
  ].join("\n")
}

function prepareWikiWriteContent(relativePath, content, nowTs) {
  if (!relativePath.startsWith("wiki/") || !relativePath.endsWith(".md")) {
    return sanitizeTextControlCharacters(content)
  }
  if (isReservedWikiPath(relativePath)) return sanitizeTextControlCharacters(content)
  return normalizeWikiPageContent(sanitizeTextControlCharacters(content), { now: nowTs, relativePath })
}

export async function applyManifest(options) {
  const manifestPath = normalizePath(options.manifestPath)
  const manifest = JSON.parse(await readTextFile(manifestPath))
  const projectPath = resolveProjectPath({ projectPath: options.projectPath ?? manifest.projectPath })
  const write = Boolean(options.write)
  const allowSourceChange = Boolean(options.allowSourceChange)
  const skipInvalid = Boolean(options.skipInvalid)
  const nowTs = manifest.createdAt ?? nowLocalTimestamp()

  if (manifest.sourcePath && manifest.sourceHash && !allowSourceChange) {
    const currentSource = sanitizeTextControlCharacters(await readTextFile(manifest.sourcePath))
    const currentHash = shortHash(currentSource)
    if (currentHash !== manifest.sourceHash) {
      throw new Error(`Source hash changed: expected ${manifest.sourceHash}, got ${currentHash}`)
    }
  }

  const rawWrites = normalizeManifestWrites(manifest)
  const factWrites = normalizeManifestFactWrites(manifest)
  const factPlan = await planTemporalFactWrites(projectPath, factWrites)
  const factValidation = validateTemporalFactPlan(factPlan)
  const collisionMap = new Map()
  const prepared = []

  for (const writeItem of rawWrites) {
    const safePath = assertSafeWikiPath(writeItem.path)
    if (safePath === "wiki/log.md") {
      throw new Error("Refusing to write legacy wiki/log.md. Use daily logs such as wiki/logs/log-YYYY-MM-DD.md.")
    }
    let action = writeItem.action
    let actualPath = safePath
    const fullPath = path.join(projectPath, safePath)
    const targetExists = await exists(fullPath)

    if (action === "create" && targetExists) {
      throw new Error(`Create target already exists: ${safePath}. Re-run api-run/prepare so the plan can merge it as an update.`)
    } else if (action === "update" && !targetExists) {
      action = "create"
    } else if (action === "append" && !targetExists) {
      action = "create"
    }

    prepared.push({ ...writeItem, action, originalPath: safePath, path: actualPath })
  }

  const finalWrites = []
  for (const item of prepared) {
    const content = rewriteCollisionReferences(String(item.content ?? ""), collisionMap)
    finalWrites.push({ ...item, content })
  }

  const validation = []
  const diffs = []
  const written = []
  const skipped = []
  const factsWritten = []
  let factIndex = null

  for (const item of finalWrites) {
    const fullPath = path.join(projectPath, item.path)
    const existing = await readIfExists(fullPath)
    const normalizedContent = prepareWikiWriteContent(item.path, item.content, nowTs)
    const after = item.action === "append" && existing
      ? `${existing.replace(/\s*$/, "")}\n\n${normalizedContent.trim()}\n`
      : normalizedContent

    const issues = [
      ...validateWikiContent(item.path, after),
      ...validatePreserveLargeHousekeepingPage(item.path, existing, after),
    ]
    validation.push({ path: item.path, issues })

    diffs.push({
      path: item.path,
      action: item.action,
      originalPath: item.originalPath,
      changed: existing !== after,
      diff: buildSimpleDiff(existing, after),
    })
  }

  const fatalIssues = validation.flatMap((item) =>
    item.issues.filter((issue) => issue.fatal).map((issue) => ({ path: item.path, ...issue })),
  )
  const fatalFactIssues = factValidation.filter((issue) => issue.fatal)
  if ((fatalIssues.length > 0 || fatalFactIssues.length > 0) && write && !skipInvalid) {
    const wikiMessages = fatalIssues.map((i) => `${i.path} [${i.field}] ${i.message}`)
    const factMessages = fatalFactIssues.map((i) => `${i.path} ${i.id ? `[${i.id}] ` : ""}[${i.field}] ${i.message}`)
    throw new Error(`Fatal schema validation failed:\n${[...wikiMessages, ...factMessages].join("\n")}`)
  }

  if (write) {
    for (const item of finalWrites) {
      const itemFatal = validation
        .find((entry) => entry.path === item.path)
        ?.issues.filter((issue) => issue.fatal) ?? []
      if (skipInvalid && itemFatal.length > 0) {
        skipped.push({ path: item.path, issues: itemFatal })
        continue
      }
      const fullPath = path.join(projectPath, item.path)
      const existing = await readIfExists(fullPath)
      const normalizedContent = prepareWikiWriteContent(item.path, item.content, nowTs)
      const after = item.action === "append" && existing
        ? `${existing.replace(/\s*$/, "")}\n\n${normalizedContent.trim()}\n`
        : normalizedContent
      await ensureDirectory(path.dirname(fullPath))
      await fs.writeFile(fullPath, after, "utf8")
      written.push(item.path)
    }
    for (const item of factPlan.plannedFactWrites) {
      const fullPath = path.join(projectPath, item.path)
      await appendJsonl(fullPath, item.record)
      factsWritten.push(item.record.id)
    }
    if (factsWritten.length > 0) {
      factIndex = await writeTemporalFactsIndex(projectPath)
    }
  }

  let sourceHashAfter = null
  if (manifest.sourcePath) {
    sourceHashAfter = shortHash(sanitizeTextControlCharacters(await readTextFile(manifest.sourcePath)))
  }

  const report = {
    manifestPath,
    projectPath,
    dryRun: !write,
    sourceHashBefore: manifest.sourceHash ?? null,
    sourceHashAfter,
    collisionMap: Object.fromEntries(collisionMap.entries()),
    validation,
    fatalIssues,
    diffs,
    written,
    plannedFactWrites: factPlan.plannedFactWrites.map((item) => ({
      path: item.path,
      id: item.record.id,
      status: item.record.status,
      subject: item.record.subject ?? null,
      predicate: item.record.predicate ?? null,
      object: item.record.object ?? null,
      claim: item.record.claim ?? null,
    })),
    duplicateFacts: factPlan.duplicateFacts,
    supersededFacts: factPlan.supersededFacts,
    invalidatedFacts: factPlan.invalidatedFacts,
    factValidation,
    fatalFactIssues,
    factsWritten,
    factIndex,
    skipped,
  }

  const reportPath = path.join(path.dirname(manifestPath), write ? "apply-report.json" : "apply-dry-run.json")
  await writeJson(reportPath, report)

  return { ...report, reportPath }
}

function buildResponsesBody({ model, prompt, instructions, reasoningEffort = "medium" }) {
  return {
    model,
    instructions:
      instructions ??
      [
        "You are Codex implementing an application-grade text ingest for a trading review wiki.",
        "Follow the stage-specific output format exactly.",
      ].join("\n"),
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    reasoning: { effort: reasoningEffort, summary: "auto" },
    store: false,
  }
}

const CHAT_COMPLETIONS_PATH = "/chat/completions"
const RESPONSES_PATH = "/v1/responses"

export function normalizeOpenAiEndpointBase(endpoint) {
  let trimmed = String(endpoint ?? "https://api.openai.com").trim().replace(/\/$/, "")
  trimmed = trimmed.replace(/\/v1\/responses$/i, "")
  trimmed = trimmed.replace(/\/responses$/i, "")
  trimmed = trimmed.replace(/\/v1\/chat\/completions$/i, "")
  trimmed = trimmed.replace(/\/chat\/completions$/i, "")
  trimmed = trimmed.replace(/\/v1$/i, "")
  return trimmed
}

export function resolveOpenAiEndpoint(options = {}) {
  return normalizeOpenAiEndpointBase(
    options.endpoint ?? process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
  )
}

export function resolveOpenAiApiMode(options = {}) {
  const requested = String(options.apiMode ?? process.env.OPENAI_API_MODE ?? "auto").trim().toLowerCase()
  if (requested === "chat" || requested === "responses") return requested

  const base = resolveOpenAiEndpoint(options).toLowerCase()
  if (base.includes("/chat/completions")) return "chat"
  if (base.includes("/responses")) return "responses"
  if (base.includes("deepseek.com")) return "chat"
  if (base.includes("moonshot.cn") || base.includes("api.moonshot")) return "chat"
  if (base.includes("api.minimaxi.com")) return "chat"
  if (base.includes("openrouter.ai")) return "chat"
  if (base.includes("localhost") || base.includes("127.0.0.1")) return "chat"
  if (!base || base.includes("api.openai.com")) return "responses"
  return "chat"
}

export function buildOpenAiChatCompletionsUrl(endpoint) {
  const base = normalizeOpenAiEndpointBase(endpoint)
  return `${base}${CHAT_COMPLETIONS_PATH}`
}

export function buildOpenAiResponsesUrl(endpoint) {
  const base = normalizeOpenAiEndpointBase(endpoint)
  return `${base}${RESPONSES_PATH}`
}

function normalizeChatReasoningEffort(reasoningEffort) {
  const raw = String(reasoningEffort ?? "").trim().toLowerCase()
  if (!raw || raw === "none" || raw === "off") return null
  if (raw === "xhigh") return "high"
  if (["minimal", "low", "medium", "high"].includes(raw)) return raw
  return "medium"
}

function shouldEnableDeepSeekThinking(model, reasoningEffort) {
  const lower = String(model ?? "").toLowerCase()
  if (lower.includes("reasoner")) return true
  if (lower.includes("v4-pro")) return true
  return reasoningEffort === "high"
}

export function buildChatCompletionsBody({ model, prompt, instructions, reasoningEffort = "medium", endpoint }) {
  const systemContent =
    instructions ??
    [
      "You are Codex implementing an application-grade text ingest for a trading review wiki.",
      "Follow the stage-specific output format exactly.",
    ].join("\n")
  const body = {
    model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: prompt },
    ],
    stream: false,
  }
  const effort = normalizeChatReasoningEffort(reasoningEffort)
  if (effort) body.reasoning_effort = effort
  if (resolveOpenAiEndpoint({ endpoint }).toLowerCase().includes("deepseek.com") && shouldEnableDeepSeekThinking(model, effort)) {
    body.thinking = { type: "enabled" }
  }
  return body
}

export function resolveOpenAiApiKey(options = {}) {
  if (options.apiKey) return options.apiKey
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  const base = resolveOpenAiEndpoint(options).toLowerCase()
  if (base.includes("deepseek.com") && process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  return undefined
}

function extractTextFromResponsesJson(parsed) {
  if (typeof parsed?.output_text === "string" && parsed.output_text) return parsed.output_text
  const texts = []
  for (const item of parsed?.output ?? []) {
    if (item?.type !== "message") continue
    for (const content of item.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") texts.push(content.text)
    }
  }
  if (texts.length > 0) return texts.join("")
  const chatContent = parsed?.choices?.[0]?.message?.content
  if (typeof chatContent === "string" && chatContent) return chatContent
  throw new Error("No assistant text found in provider output")
}

export function buildCodexExecInvocation({
  codexBin = DEFAULT_CODEX_BIN,
  projectPath,
  outputPath,
  model,
  profile,
  profileV2,
  sandbox = "read-only",
  approval = "never",
}) {
  const args = []
  if (model) args.push("-m", model)
  if (profile) args.push("-p", profile)
  if (profileV2) args.push("--profile-v2", profileV2)
  args.push(
    "-s",
    sandbox,
    "-a",
    approval,
    "exec",
    "--skip-git-repo-check",
    "-C",
    projectPath,
    "--output-last-message",
    outputPath,
    "-",
  )
  return { command: codexBin, args }
}

async function runProcessWithStdin(command, args, stdin, options = {}) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_CODEX_TIMEOUT_MS)
  const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 16
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`))
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (stdout.length > maxBuffer) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill("SIGTERM")
        reject(new Error(`Command stdout exceeded ${maxBuffer} bytes: ${command}`))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (stderr.length > maxBuffer) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill("SIGTERM")
        reject(new Error(`Command stderr exceeded ${maxBuffer} bytes: ${command}`))
      }
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Command failed (${signal ?? code}): ${command} ${args.join(" ")}\n${stderr || stdout}`))
      }
    })
    child.stdin.end(stdin)
  })
}

async function requestCodexExecText({
  stage,
  prompt,
  instructions,
  model,
  prepared,
  outputPath,
  codexBin,
  codexProfile,
  codexProfileV2,
  codexTimeoutMs,
}) {
  await ensureDirectory(path.dirname(outputPath))
  const fullPrompt = [
    instructions,
    "",
    "Important execution constraint: do not edit or write files. Return only the requested final answer content.",
    "",
    prompt,
  ]
    .filter(Boolean)
    .join("\n")
  const { command, args } = buildCodexExecInvocation({
    codexBin: codexBin ?? process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN,
    projectPath: prepared.projectPath,
    outputPath,
    model,
    profile: codexProfile,
    profileV2: codexProfileV2,
  })
  await runProcessWithStdin(command, args, fullPrompt, {
    cwd: prepared.projectPath,
    timeoutMs: codexTimeoutMs,
  })
  const text = await readIfExists(outputPath)
  if (!text.trim()) throw new Error(`Codex provider returned empty output for stage ${stage}`)
  return text
}

export async function apiRunIngest(options) {
  const provider = options.provider ?? "openai"
  const apiKey = resolveOpenAiApiKey(options)
  const model = options.model ?? (provider === "openai" ? process.env.OPENAI_MODEL : process.env.CODEX_MODEL)
  if (!options.requestText && provider === "openai" && !apiKey) {
    throw new Error("Missing OpenAI-compatible API key. Pass --api-key or set OPENAI_API_KEY / DEEPSEEK_API_KEY, or use --provider codex.")
  }
  if (!options.requestText && provider === "openai" && !model) {
    throw new Error("Missing model. Pass --model or set OPENAI_MODEL.")
  }
  if (!["openai", "codex"].includes(provider) && !options.requestText) {
    throw new Error(`Unsupported provider: ${provider}`)
  }

  const prepared = await prepareIngest({ ...options, noReport: false })
  const codexOutputsDir = path.join(prepared.reportDir, "codex-outputs")
  let codexCallCounter = 0

  const requestText = async ({ stage, prompt, instructions }) => {
    if (options.requestText) {
      return options.requestText({
        stage,
        prompt,
        instructions,
        model,
        provider,
        prepared,
      })
    }
    if (provider === "codex") {
      codexCallCounter += 1
      const outputPath = path.join(codexOutputsDir, `${String(codexCallCounter).padStart(3, "0")}-${stage}.md`)
      return requestCodexExecText({
        stage,
        prompt,
        instructions,
        model,
        prepared,
        outputPath,
        codexBin: options.codexBin,
        codexProfile: options.codexProfile,
        codexProfileV2: options.codexProfileV2,
        codexTimeoutMs: options.codexTimeoutMs,
      })
    }
    return requestOpenAiProviderText({
      apiKey,
      endpoint: options.endpoint,
      apiMode: options.apiMode,
      model,
      prompt,
      instructions,
      reasoningEffort: options.reasoningEffort ?? "medium",
    })
  }

  const sourceBaseName = path.basename(prepared.sourcePath).replace(/\.[^.]+$/, "")
  const nowTs = prepared.createdAt

  const analysisPrompt = buildAnalysisStagePrompt(prepared)
  const analysis = await requestText({
    stage: "analysis",
    prompt: analysisPrompt,
    instructions: "You are an application-grade trading wiki ingest analyst. Return Markdown analysis only.",
  })
  const analysisPath = path.join(prepared.reportDir, "analysis.md")
  await fs.writeFile(analysisPath, analysis, "utf8")

  const planPrompt = buildPlanStagePrompt({ prepared, analysis, sourceBaseName })
  const planRaw = await requestText({
    stage: "plan",
    prompt: planPrompt,
    instructions: "You are an application-grade trading wiki ingest planner. Return only the requested JSON fenced block.",
  })
  const parsedPlan = parsePlanFromModelText(planRaw)
  const plan = await normalizeIngestPlan(prepared.projectPath, parsedPlan, sourceBaseName)
  const planMarkdownPath = path.join(prepared.reportDir, "plan.md")
  const planJsonPath = path.join(prepared.reportDir, "plan.json")
  await fs.writeFile(planMarkdownPath, planRaw, "utf8")
  await writeJson(planJsonPath, plan)
  const planBudget = assessIngestPlanBudget(plan, options)
  const planBudgetPath = path.join(prepared.reportDir, "plan-budget.json")
  await writeJson(planBudgetPath, planBudget)

  const filesDir = path.join(prepared.reportDir, "files")
  await ensureDirectory(filesDir)
  const items = planItemsInGenerationOrder(plan, sourceBaseName)
  const pageConcurrency = parsePositiveInteger(options.pageConcurrency, 1)
  const pageWrites = await mapWithConcurrency(items, pageConcurrency, async (item, i) => {
    const existingContent = item.action === "update" ? await readIfExists(path.join(prepared.projectPath, item.path)) : ""
    const prompt = buildPageFilePrompt({
      prepared,
      item,
      existingContent,
      analysis,
      sourceBaseName,
      nowTs,
    })
    const raw = await requestText({
      stage: "file",
      prompt,
      instructions: "You are an application-grade trading wiki page writer. Return exactly one FILE block.",
    })
    const blocks = parseFileBlocks(raw)
    const block = blocks.find((candidate) => candidate.path === item.path) ?? blocks[0]
    if (!block) throw new Error(`Stage 3 returned no FILE block for ${item.path}`)
    if (block.path !== item.path) {
      throw new Error(`Stage 3 returned FILE path ${block.path}, expected ${item.path}`)
    }
    const artifactName = `${String(i + 1).padStart(3, "0")}-${item.path.replace(/[^\p{L}\p{N}._-]+/gu, "_")}`
    await fs.writeFile(path.join(filesDir, artifactName), raw, "utf8")
    return {
      action: item.action,
      path: item.path,
      content: normalizeWikiPageContent(sanitizeTextControlCharacters(block.content), {
        now: nowTs,
        relativePath: item.path,
      }),
    }
  })

  const housekeeping = buildProgrammaticHousekeepingWrites({
    prepared,
    pageWrites,
    sourceBaseName,
    nowTs,
  })
  await fs.writeFile(path.join(filesDir, "999-housekeeping.md"), housekeeping.artifact, "utf8")
  const housekeepingWrites = housekeeping.writes

  const manifest = {
    ...prepared.manifestTemplate,
    generatedBy: `codex-ingest api-run staged (${provider})`,
    provider,
    stages: {
      analysis: projectRelative(prepared.projectPath, analysisPath),
      plan: projectRelative(prepared.projectPath, planJsonPath),
      planBudget: projectRelative(prepared.projectPath, planBudgetPath),
      files: projectRelative(prepared.projectPath, filesDir),
    },
    planBudget,
    plan,
    factWrites: plan.factWrites ?? [],
    writes: [...pageWrites, ...housekeepingWrites],
  }
  const manifestPath = path.join(prepared.reportDir, "changes.json")
  await writeJson(manifestPath, manifest)
  const dryRunReport = await applyManifest({ manifestPath, write: false })
  return { ...prepared, analysisPath, planMarkdownPath, planJsonPath, planBudgetPath, filesDir, planBudget, plan, manifestPath, modelText: analysis, dryRunReport }
}

export async function finalizeStagedIngest(options) {
  const reportDir = normalizePath(options.reportDir)
  const manifestTemplatePath = path.join(reportDir, "changes.template.json")
  const manifestTemplate = JSON.parse(await fs.readFile(manifestTemplatePath, "utf8"))
  const projectPath = resolveProjectPath({ projectPath: options.projectPath ?? manifestTemplate.projectPath })
  const sourcePath = normalizePath(manifestTemplate.sourcePath)
  const sourceBaseName = path.basename(sourcePath).replace(/\.[^.]+$/, "")
  const provider = options.provider ?? "codex"
  const apiKey = resolveOpenAiApiKey(options)
  const model = options.model ?? (provider === "openai" ? process.env.OPENAI_MODEL : process.env.CODEX_MODEL)

  if (!["openai", "codex"].includes(provider)) throw new Error(`Unsupported provider: ${provider}`)
  if (provider === "openai" && !apiKey) throw new Error("Missing OpenAI-compatible API key. Pass --api-key or set OPENAI_API_KEY / DEEPSEEK_API_KEY, or use --provider codex.")
  if (provider === "openai" && !model) throw new Error("Missing model. Pass --model or set OPENAI_MODEL.")

  const createdAt = manifestTemplate.createdAt ?? nowLocalTimestamp()
  const dailyLogPath = dailyLogPathFromTimestamp(createdAt)
  const fullSourceContent = await fs.readFile(sourcePath, "utf8")
  const prepared = {
    projectPath,
    sourcePath,
    sourceRelativePath: manifestTemplate.sourceRelativePath,
    sourceHash: manifestTemplate.sourceHash,
    createdAt,
    sourceContent: compactSourceContentForPrompt(fullSourceContent, sourcePath, manifestTemplate.sourceHash),
    schema: await readIfExists(path.join(projectPath, "schema.md")),
    purpose: await readIfExists(path.join(projectPath, "purpose.md")),
    index: await readIfExists(path.join(projectPath, "wiki/index.md")),
    overview: await readIfExists(path.join(projectPath, "wiki/overview.md")),
    log: await readIfExists(path.join(projectPath, "wiki/log.md")),
    dailyLogPath,
    dailyLog: await readIfExists(path.join(projectPath, dailyLogPath)),
    manifestTemplate: { ...manifestTemplate, projectPath, sourcePath },
  }

  const analysisPath = path.join(reportDir, "analysis.md")
  const planJsonPath = path.join(reportDir, "plan.json")
  const filesDir = path.join(reportDir, "files")
  const codexOutputsDir = path.join(reportDir, "codex-outputs")
  const analysis = await fs.readFile(analysisPath, "utf8")
  const plan = JSON.parse(await fs.readFile(planJsonPath, "utf8"))

  const blocksByPath = new Map()
  const fileArtifacts = (await listFilesRecursive(filesDir, { extensions: new Set([".md"]) })).filter(
    (filePath) => path.basename(filePath) !== "999-housekeeping.md",
  )
  for (const filePath of fileArtifacts.sort()) {
    const raw = await fs.readFile(filePath, "utf8")
    for (const block of parseFileBlocks(raw)) {
      if (!blocksByPath.has(block.path)) blocksByPath.set(block.path, block)
    }
  }

  const items = planItemsInGenerationOrder(plan, sourceBaseName)
  const pageWrites = items.map((item) => {
    const block = blocksByPath.get(item.path)
    if (!block) throw new Error(`Missing generated FILE block for ${item.path}`)
    return {
      action: item.action,
      path: item.path,
      content: normalizeWikiPageContent(sanitizeTextControlCharacters(block.content), {
        now: prepared.createdAt,
        relativePath: item.path,
      }),
    }
  })

  const housekeepingPath = path.join(filesDir, "999-housekeeping.md")
  const housekeeping = buildProgrammaticHousekeepingWrites({
    prepared,
    pageWrites,
    sourceBaseName,
    nowTs: prepared.createdAt,
  })
  await fs.writeFile(housekeepingPath, housekeeping.artifact, "utf8")
  const housekeepingWrites = housekeeping.writes

  const manifest = {
    ...prepared.manifestTemplate,
    generatedBy: `codex-ingest finalize staged (${provider})`,
    provider,
    stages: {
      analysis: projectRelative(projectPath, analysisPath),
      plan: projectRelative(projectPath, planJsonPath),
      files: projectRelative(projectPath, filesDir),
    },
    plan,
    factWrites: plan.factWrites ?? [],
    writes: [...pageWrites, ...housekeepingWrites],
  }
  const manifestPath = path.join(reportDir, "changes.json")
  await writeJson(manifestPath, manifest)
  const dryRunReport = await applyManifest({ manifestPath, write: false })
  return { reportDir, filesDir, plan, manifestPath, dryRunReport }
}

async function requestChatCompletionsText({ apiKey, endpoint, model, prompt, instructions, reasoningEffort }) {
  const body = buildChatCompletionsBody({
    model,
    prompt,
    instructions,
    reasoningEffort,
    endpoint,
  })
  const response = await fetch(buildOpenAiChatCompletionsUrl(endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Chat Completions API failed: HTTP ${response.status} ${await response.text()}`)
  }
  const parsed = await response.json()
  return extractTextFromResponsesJson(parsed)
}

async function requestResponsesText({ apiKey, endpoint, model, prompt, instructions, reasoningEffort }) {
  const body = buildResponsesBody({
    model,
    prompt,
    instructions,
    reasoningEffort,
  })

  const response = await fetch(buildOpenAiResponsesUrl(endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Responses API failed: HTTP ${response.status} ${await response.text()}`)
  }
  const parsed = await response.json()
  return extractTextFromResponsesJson(parsed)
}

export async function requestOpenAiProviderText({ apiKey, endpoint, apiMode, model, prompt, instructions, reasoningEffort }) {
  const safePrompt = sanitizeTextControlCharacters(prompt)
  const safeInstructions = sanitizeTextControlCharacters(instructions)
  const mode = resolveOpenAiApiMode({ endpoint, apiMode })
  if (mode === "chat") {
    return requestChatCompletionsText({ apiKey, endpoint, model, prompt: safePrompt, instructions: safeInstructions, reasoningEffort })
  }
  return requestResponsesText({ apiKey, endpoint, model, prompt: safePrompt, instructions: safeInstructions, reasoningEffort })
}
