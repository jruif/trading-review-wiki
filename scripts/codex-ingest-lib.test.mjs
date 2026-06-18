import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  METHODOLOGY_CONTEXT_PATHS,
  METHODOLOGY_CONTEXT_TOTAL_CHAR_SOFT_LIMIT,
  METHODOLOGY_PAGE_CHAR_SOFT_LIMIT,
  PAGE_BODY_LINE_SOFT_LIMIT,
  RETRIEVAL_MODES,
  TEMPORAL_FACT_INDEX_RELATIVE_PATH,
  TEMPORAL_FACTS_RELATIVE_PATH,
  apiRunIngest,
  applyManifest,
  buildMethodologyContext,
  buildAskRetrievalContext,
  buildCodexExecInvocation,
  buildStockDailySqlQuery,
  compactSourceContentForPrompt,
  exportTrainingSamples,
  extractSourceTokens,
  getBrainStatus,
  marketValidatePrediction,
  normalizeIngestPlan,
  parseStockDailyIntent,
  parseFileBlocks,
  prepareIngest,
  rememberBrainMemory,
  resolveBrainMemory,
  runAskEval,
  runCompanyResearch,
  runDailyLoop,
  runHygiene,
  runSelfTraining,
  runTemporalFactsAudit,
  searchCandidatePages,
  selectAskSources,
  tokenizeQuery,
  validateWikiContent,
  buildChatCompletionsBody,
  buildOpenAiChatCompletionsUrl,
  buildOpenAiResponsesUrl,
  normalizeOpenAiEndpointBase,
  resolveOpenAiApiMode,
  resolveOpenAiApiKey,
  requestOpenAiProviderText,
  sanitizeTextControlCharacters,
  coerceWikiPageFrontmatter,
  normalizeWikiPageContent,
  normalizeWikiTimestamp,
  parseModelJson,
  validateFrontmatter,
  applyManifest,
} from "./codex-ingest-lib.mjs"

let tmpRoot

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
}

async function read(filePath) {
  return fs.readFile(filePath, "utf8")
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "")
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function validFrontmatter(title, type = "概念", extra = "") {
  return `---
schema_version: 1
title: ${title}
aliases: []
type: ${type}
summary: 这是一个用于测试的页面摘要，长度足够覆盖检索召回和 schema 校验要求，不直接复用正文内容。
tags:
  - 测试
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
${extra}---
`
}

function timestampDaysAgo(days) {
  const date = new Date(Date.now() - days * 86400000)
  const pad = (value) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function makeProject() {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ingest-"))
  await write(path.join(project, "schema.md"), "# schema\n\n使用 [[目录/页面名]] 链接。")
  await write(path.join(project, "purpose.md"), "# purpose\n\n交易复盘。")
  await write(
    path.join(project, "wiki/index.md"),
    `${validFrontmatter("index", "总结")}# index\n\n- [[概念/算电协同]] — 算力与电力联动`,
  )
  await write(path.join(project, "wiki/overview.md"), `${validFrontmatter("overview", "总结")}# overview\n`)
  await write(path.join(project, "wiki/log.md"), "# log\n")
  await write(
    path.join(project, "wiki/概念/算电协同.md"),
    `---
schema_version: 1
title: 算电协同
aliases:
  - AI服务器电源
type: 概念
summary: 这是一个用于测试的算电协同页面摘要，覆盖 AI 服务器电源、电力容量和算力扩张之间的联动关系。
tags:
  - AI电源
  - 算力
related:
  - "[[概念/电力运营商重估]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 算电协同

AI 服务器电源需求、数据中心供电和电力运营商重估共同构成观察框架。
`,
  )
  await write(
    path.join(project, "wiki/概念/电力运营商重估.md"),
    `${validFrontmatter("电力运营商重估")}# 电力运营商重估\n\n负荷增长带来估值变化。\n`,
  )
  await write(
    path.join(project, "raw/研报新闻/2026-05-28-AI服务器电源.md"),
    "# AI服务器电源涨价\n\n本轮 AI 服务器电源和数据中心供电瓶颈强化了算电协同逻辑。",
  )
  await write(
    path.join(project, "data/facts/cases.jsonl"),
    `${JSON.stringify({ id: "case-1", title: "高开接盘案例", error: "高开接盘", lesson: "高开无承接时不要追涨" })}\n`,
  )
  await write(
    path.join(project, ".llm-wiki/stock-codes.json"),
    `${JSON.stringify({ synced_at: "2026-05-30 13:38:51", count: 2, mapping: { 利通电子: "SH603629", 三孚新科: "SH688359" } }, null, 2)}\n`,
  )
  return project
}

beforeEach(async () => {
  tmpRoot = await makeProject()
})

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe("codex ingest prepare", () => {
  it("compacts gangtise meeting clues while preserving late records", () => {
    const records = Array.from({ length: 140 }, (_, i) => {
      const n = i + 1
      return [
        `### ${n}. 记录 ${60000 + n}`,
        "",
        `- 发布时间: 2026-06-01 21:${String(n % 60).padStart(2, "0")}:00（北京时间）`,
        `- 记录 ID: ${60000 + n}`,
        `- 主题/标的: 主题${n}, ${n === 140 ? "尾部AI液冷" : "普通线索"}`,
        "- detail_topic: 无",
        "",
        "#### content",
        "",
        `<p><strong>核心：</strong>${"长正文".repeat(120)}${n === 140 ? " 尾部CDU冷板价值量验证" : ""}</p>`,
      ].join("\n")
    })
    const source = [
      "---",
      "source: cn_alternative_db.public.gangtise_meeting_clues",
      "record_count: 140",
      "---",
      "",
      "# 2026-06-01 投研线索汇总",
      "",
      "## 今日概览",
      "",
      "- 记录数: 140",
      "",
      "## 主题索引",
      "",
      "- AI",
      "",
      "## 明细",
      "",
      ...records,
    ].join("\n")
    const compacted = compactSourceContentForPrompt(source, "/tmp/meeting-clues.md", "hash", 20000)
    expect(compacted.length).toBeLessThanOrEqual(20080)
    expect(compacted).toContain("保留记录数：140")
    expect(compacted).toContain("### 140. 记录 60140")
    expect(compacted).toContain("尾部AI液冷")
    expect(compacted).toContain("尾部CDU冷板价值量验证")
  })

  it("writes reports without changing raw or wiki content", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const wikiBefore = await read(path.join(tmpRoot, "wiki/概念/算电协同.md"))
    const rawBefore = await read(source)

    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath: source,
      reportId: "test-report",
    })

    expect(result.reportDir).toBe(path.join(tmpRoot, ".llm-wiki/codex-ingest/test-report"))
    expect(result.candidates.wikiCandidates[0].path).toBe("wiki/概念/算电协同.md")
    expect(await read(path.join(tmpRoot, "wiki/概念/算电协同.md"))).toBe(wikiBefore)
    expect(await read(source)).toBe(rawBefore)
    await expect(fs.access(path.join(result.reportDir, "context.md"))).resolves.toBeUndefined()
    await expect(fs.access(path.join(result.reportDir, "changes.template.json"))).resolves.toBeUndefined()
  })

  it("adds a compact methodology pre-read pack without full-text prompt bloat", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    await write(
      path.join(tmpRoot, "wiki/策略/四层嵌套决策体系.md"),
      `${validFrontmatter("四层嵌套决策体系", "策略")}# 四层嵌套决策体系

## L1 市场结构
- L1 判断主线和非主线，先确认市场阶段。

## L4 执行控制
- L4 只处理执行触发、仓位、退出和明日验证清单。

${Array.from({ length: 260 }, (_, i) => `- 普通长段 ${i} ${"背景文字".repeat(18)}`).join("\n")}

- TAIL_SHOULD_BE_TRUNCATED ${"尾部不应进入预读包".repeat(80)}
`,
    )
    await write(
      path.join(tmpRoot, "wiki/策略/L4执行控制层.md"),
      `${validFrontmatter("L4执行控制层", "策略")}# L4执行控制层

- 执行必须绑定验证窗口、证伪条件和退出规则。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/策略/WKID四步法.md"),
      `\`\`\`yaml
---
schema_version: 1
title: WKID四步法
aliases: []
type: 策略
summary: ""
tags:
  - WKID
related:
  - "[[策略/四层嵌套决策体系]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---
\`\`\`
# WKID四步法

## Step 1: W — Wikilink提取与规范化
- W 步骤用于提取股票、催化剂、市场状态、策略名称和错误类型。

## Step 2: K — Keyword归属映射
- K 步骤把关键词映射到 L1-L4，避免孤立页面脱离四层嵌套决策体系。
`,
    )

    const direct = await buildMethodologyContext(tmpRoot, {
      paths: METHODOLOGY_CONTEXT_PATHS,
      perPageChars: METHODOLOGY_PAGE_CHAR_SOFT_LIMIT,
      totalChars: METHODOLOGY_CONTEXT_TOTAL_CHAR_SOFT_LIMIT,
    })
    expect(direct.paths).toContain("wiki/策略/四层嵌套决策体系.md")
    expect(direct.markdown).toContain("Methodology Pre-read Pack")
    expect(direct.markdown).toContain("L4 执行控制")
    expect(direct.markdown).toContain("Keyword归属映射")
    expect(direct.markdown).not.toContain("TAIL_SHOULD_BE_TRUNCATED")
    expect(direct.markdown.length).toBeLessThanOrEqual(METHODOLOGY_CONTEXT_TOTAL_CHAR_SOFT_LIMIT + 80)

    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath: source,
      reportId: "methodology-pack",
    })
    expect(result.methodologyContext.markdown).toContain("Methodology Pre-read Pack")
    expect(result.methodologyContext.stage3Rules).toContain("Methodology Guardrails")
    expect(await read(path.join(result.reportDir, "context.md"))).toContain("Methodology Pre-read Pack")
    const saved = JSON.parse(await read(path.join(result.reportDir, "methodology-context.json")))
    expect(saved.paths).toContain("wiki/策略/L4执行控制层.md")
  })

  it("non-vector search uses aliases, tags, related and body text", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const sourceContent = await read(source)
    const candidates = await searchCandidatePages(tmpRoot, source, sourceContent, { topWiki: 5 })

    expect(candidates.retrievalMode).toBe(RETRIEVAL_MODES.INGEST)
    const paths = candidates.wikiCandidates.map((item) => item.path)
    expect(paths[0]).toBe("wiki/概念/算电协同.md")
    expect(paths).toContain("wiki/概念/电力运营商重估.md")
    expect(candidates.tokens).toContain("ai")
  })

  it("ingest source tokens keep topic words and drop metadata noise", async () => {
    const sourcePath = path.join(tmpRoot, "raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-05/0056-复盘-机器人-126491.md")
    const source = `---
title: "机器人 2026-06-05 复盘"
theme_id: 126491
theme_date: "2026-06-05"
type: "复盘"
type_code: 1
name: "机器人"
code: "880134.GT"
source_db: "cn_alternative_db.public.gangtise_themes"
source_field: "full_content"
content_sha256: "9fee053924294ea6c88e3a41965ccd8d326612184fddaa13f2462f0d0c7c2e40"
hot_status: "热门"
---
# 机器人 2026-06-05 复盘

## 原文
- <strong>黄仁勋表态“机器人+AI制造”</strong>：Physical AI 与具身智能进入工业场景。
- 特斯拉 Optimus V3 量产、PPA、SOP、谐波减速器、丝杠和订单节点需要跟踪。
`
    const tokens = extractSourceTokens(source, sourcePath, 40)

    expect(tokens).toContain("机器人")
    expect(tokens).toContain("具身智能")
    expect(tokens).toContain("physical")
    expect(tokens).toContain("ai")
    expect(tokens).toContain("ppa")
    expect(tokens).not.toContain("0")
    expect(tokens).not.toContain("t")
    expect(tokens).not.toContain(":")
    expect(tokens).not.toContain("theme_id")
    expect(tokens).not.toContain("2026")
    expect(tokens).not.toContain("复盘")
  })

  it("ingest candidate ranking stays topic-focused for noisy OpenClaw robot sources", async () => {
    const sourcePath = path.join(tmpRoot, "raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-05/0056-复盘-机器人-126491.md")
    const source = `---
title: "机器人 2026-06-05 复盘"
theme_id: 126491
theme_date: "2026-06-05"
type: "复盘"
name: "机器人"
source_db: "cn_alternative_db.public.gangtise_themes"
source_field: "full_content"
---
# 机器人 2026-06-05 复盘

## 元数据
- theme_id：126491
- theme_date：2026-06-05
- type：复盘
- code：880134.GT

## 原文
- 黄仁勋表态机器人和 Physical AI 进入工业制造。
- 特斯拉 Optimus V3 量产、PPA、SOP、谐波减速器、丝杠和订单节点需要跟踪。
`
    await write(sourcePath, source)
    await write(
      path.join(tmpRoot, "wiki/概念/物理AI与具身智能.md"),
      `---
schema_version: 1
title: 物理AI与具身智能
aliases:
  - Physical AI
type: 概念
summary: 物理AI与具身智能页沉淀机器人方向的量产、客户、订单、出货和交易验证节点。
tags:
  - 机器人
  - 具身智能
related:
  - "[[概念/机器人产业链]]"
sources:
  - raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-05/0056-复盘-机器人-126491.md
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 物理AI与具身智能

机器人进入订单、量产、客户和出货验证阶段，关注 PPA、SOP、谐波减速器和丝杠。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/泛AI服务器链.md"),
      `${validFrontmatter("泛AI服务器链", "概念")}# 泛AI服务器链

AI 服务器、PCB、光模块和算力链在 2026 年反复出现。${"AI 2026 今日 复盘 逻辑 验证 ".repeat(80)}
`,
    )

    const candidates = await searchCandidatePages(tmpRoot, sourcePath, source, { topWiki: 5 })
    expect(candidates.retrievalMode).toBe("ingest")
    const paths = candidates.wikiCandidates.map((item) => item.path)
    const specificIndex = paths.indexOf("wiki/概念/物理AI与具身智能.md")
    const broadIndex = paths.indexOf("wiki/概念/泛AI服务器链.md")
    expect(specificIndex).toBe(0)
    if (broadIndex !== -1) expect(broadIndex).toBeGreaterThan(specificIndex)
    expect(candidates.tokens).not.toContain("0")
    expect(candidates.tokens).not.toContain("theme_id")
    expect(candidates.segments).toEqual([])
  })

  it("segments multi-topic WeChat sentiment and keeps theme candidates distinct", async () => {
    const sourcePath = path.join(tmpRoot, "raw/微信聊天/2026-06-06.md")
    const source = `---
---

## 2026-06-06 00:00:00 舆情更新
## 2026-06-06 00:00 舆情摘要

### 同步与窗口
- core-sync 成功，核心群成功 11 个。

### 市场情绪
- 外围科技风险压制，但低位科技主线仍有分化机会。

### 重点板块/标的
1. 商业航天/SpaceX IPO 映射｜热度：高｜命中群：2026资讯、周期有道｜原文数：7
   - SpaceX 750 亿美元 IPO 超额认购，商业航天、卫星互联网和太空算力映射继续发酵。
   - 待验证：SpaceX IPO 实际定价、交易时间、国内商业航天产业链是否有订单兑现。
   - 共同需要参考跨主题风险管理，避免海外龙头利好映射 A 股追高。

2. 数据中心光纤/MPO/中天科技｜热度：高｜命中群：2026资讯｜原文数：2
   - 中天科技中标国内互联网企业数据中心 MPO 光纤跳线及配件约 15.18 亿元。
   - A1/D 纤、MPO 光纤、数据中心耗材、Scale-Up、DCI 和光互联需求被集中强调。
   - 共同需要参考跨主题风险管理，避免把单条中标小作文直接当作全行业确认。

3. 美股科技回撤/外围科技风险｜热度：中高｜命中群：2026资讯｜原文数：4
   - 纳指、英伟达、台积电、博通、美光、AMD、英特尔同步下跌，影响 A 股科技风险偏好。
   - A 股高位算力、CPO 和 AIDC 休整，低位科技接力仍需下个交易日验证。
   - 共同需要参考跨主题风险管理和当前市场阶段判断。

### 风险与待验证
- 本轮 SpaceX IPO、MPO 光纤中标和美股科技风险均来自群聊文本或转发纪要，未接外部行情源校验。
`
    await write(sourcePath, source)
    await write(
      path.join(tmpRoot, "wiki/概念/商业航天产业链.md"),
      `---
schema_version: 1
title: 商业航天产业链
aliases:
  - SpaceX IPO
  - 卫星互联网
type: 概念
summary: 商业航天产业链页跟踪 SpaceX IPO、卫星互联网、太空算力和国内商业航天映射。
tags:
  - 商业航天
  - SpaceX
  - IPO催化
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 商业航天产业链

SpaceX IPO、卫星互联网、太空算力和商业航天国内映射需要订单与政策验证。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/SpaceX IPO催化.md"),
      `---
schema_version: 1
title: SpaceX IPO催化
aliases:
  - SpaceX上市
  - SpaceX IPO
type: 概念
summary: SpaceX IPO催化页跟踪上市时间、估值、定价结构和 A 股商业航天映射风险。
tags:
  - SpaceX
  - IPO催化
  - 商业航天
related:
  - "[[概念/商业航天产业链]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# SpaceX IPO催化

SpaceX IPO 交易时间、估值和映射需要二次核验。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/数据中心光纤MPO.md"),
      `---
schema_version: 1
title: 数据中心光纤MPO
aliases:
  - MPO光纤跳线
  - 数据中心光纤
  - 中天科技MPO
type: 概念
summary: 数据中心光纤MPO页跟踪 A1/D纤、MPO跳线、数据中心耗材、Scale-Up 和光互联需求。
tags:
  - 光纤
  - MPO
  - 数据中心
  - 光互联
related:
  - "[[概念/光互联Scale-Up-十年大周期]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 数据中心光纤MPO

中天科技、亨通光电、MPO 光纤跳线和数据中心光纤紧缺需要中标份额、单价与交付验证。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/光互联Scale-Up-十年大周期.md"),
      `---
schema_version: 1
title: 光互联Scale-Up-十年大周期
aliases:
  - Scale-Up
  - 数据中心光互联
  - MPO光纤
type: 概念
summary: 光互联Scale-Up页跟踪 AI 数据中心互联、MPO 光纤、DCI 和 Scale-Up 网络需求。
tags:
  - 光互联
  - Scale-Up
  - MPO
related:
  - "[[概念/数据中心光纤MPO]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 光互联Scale-Up-十年大周期

Scale-Up、DCI、MPO 光纤和数据中心光互联是 AI 基础设施互联分支。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/模式/当前市场阶段判断.md"),
      `---
schema_version: 1
title: 当前市场阶段判断
aliases:
  - 科技风险偏好
  - 风格切换
type: 模式
summary: 当前市场阶段判断页跟踪指数、成交、主线承接、风格切换和风险偏好变化。
tags:
  - 市场阶段
  - 风格切换
  - 科技风险
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 当前市场阶段判断

美股科技回撤、A 股高位算力休整和低位科技接力需要区分。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/模式/跨主题风险管理.md"),
      `---
schema_version: 1
title: 跨主题风险管理
aliases:
  - SpaceX IPO
  - MPO光纤
  - 美股科技回撤
type: 模式
summary: 跨主题风险管理页用于约束多主题舆情中高热转发、群聊小作文和事实强度之间的错配。
tags:
  - 风险管理
  - 群聊舆情
  - 事实强度
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 跨主题风险管理

SpaceX IPO、MPO 光纤和美股科技回撤都需要避免把群聊热度升级为事实强度。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/总结/2026-06-02-日复盘.md"),
      `${validFrontmatter("2026 06 02 日复盘", "总结")}# 2026 06 02 日复盘\n\n${"商业航天 SpaceX 数据中心 光纤 MPO 科技 风险 ".repeat(120)}\n`,
    )

    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath,
      reportId: "wechat-segments",
    })
    const segments = result.candidates.segments
    expect(segments.length).toBeGreaterThanOrEqual(3)
    expect(segments.map((item) => item.title)).toEqual([
      "商业航天/SpaceX IPO 映射",
      "数据中心光纤/MPO/中天科技",
      "美股科技回撤/外围科技风险",
    ])

    const spaceSegment = segments.find((item) => item.title.includes("商业航天"))
    const fiberSegment = segments.find((item) => item.title.includes("数据中心光纤"))
    const riskSegment = segments.find((item) => item.title.includes("美股科技"))
    expect(spaceSegment.wikiCandidates.map((item) => item.path)).toContain("wiki/概念/商业航天产业链.md")
    expect(spaceSegment.wikiCandidates[0].type).not.toBe("总结")
    expect(fiberSegment.wikiCandidates.map((item) => item.path)).toContain("wiki/概念/数据中心光纤MPO.md")
    expect(fiberSegment.wikiCandidates[0].path).not.toMatch(/SpaceX|商业航天/)
    expect(fiberSegment.wikiCandidates[0].type).not.toBe("总结")
    expect(riskSegment.wikiCandidates.map((item) => item.path)).toContain("wiki/模式/当前市场阶段判断.md")

    const globalPaths = result.candidates.wikiCandidates.map((item) => item.path)
    expect(new Set(globalPaths).size).toBe(globalPaths.length)
    const crossTheme = result.candidates.wikiCandidates.find((item) => item.path === "wiki/模式/跨主题风险管理.md")
    expect(crossTheme?.matchedSegments?.length).toBeGreaterThanOrEqual(2)
    const summaryIndex = globalPaths.indexOf("wiki/总结/2026-06-02-日复盘.md")
    const conceptIndex = globalPaths.indexOf("wiki/概念/商业航天产业链.md")
    expect(summaryIndex === -1 || summaryIndex).toBeGreaterThan(conceptIndex)

    const saved = JSON.parse(await read(path.join(result.reportDir, "candidate-pages.json")))
    expect(saved.segments.length).toBe(3)
    expect(await read(path.join(result.reportDir, "context.md"))).toContain("Segment Candidate Groups")
    expect(await read(path.join(result.reportDir, "dry-run.md"))).toContain("Segment Candidate Groups")
  })

  it("falls back to whole-document retrieval when WeChat segmentation is unavailable", async () => {
    const sourcePath = path.join(tmpRoot, "raw/微信聊天/2026-06-06-no-segments.md")
    const source = "# 2026-06-06 舆情摘要\n\nAI服务器电源、数据中心供电和算电协同继续被讨论，但没有重点板块编号。"
    await write(sourcePath, source)

    const candidates = await searchCandidatePages(tmpRoot, sourcePath, source, { topWiki: 5 })
    expect(candidates.segments).toEqual([])
    expect(candidates.wikiCandidates[0].path).toBe("wiki/概念/算电协同.md")
  })

  it("segments obvious long multi-topic sources without focus headings", async () => {
    const sourcePath = path.join(tmpRoot, "raw/研报新闻/2026-06-06-多主题长文.md")
    const source = [
      "# 多主题长文",
      "",
      `1. AI服务器电源｜热度：高｜原文数：3\n   - AI服务器电源、数据中心供电、算电协同和算力扩张被反复讨论。\n   ${"AI服务器电源 数据中心供电 算电协同 ".repeat(1300)}`,
      "",
      `2. 电力运营商重估｜热度：中｜原文数：2\n   - 电力负荷、容量电价、运营商重估和算力用电弹性进入讨论。\n   ${"电力运营商重估 电力负荷 容量电价 ".repeat(1300)}`,
    ].join("\n")
    await write(sourcePath, source)

    const candidates = await searchCandidatePages(tmpRoot, sourcePath, source, { topWiki: 8, maxSegments: 2 })
    expect(candidates.segments.map((item) => item.title)).toEqual(["AI服务器电源", "电力运营商重估"])
    expect(candidates.segments[0].wikiCandidates.map((item) => item.path)).toContain("wiki/概念/算电协同.md")
    expect(candidates.segments[1].wikiCandidates.map((item) => item.path)).toContain("wiki/概念/电力运营商重估.md")
  })

  it("prepares temporal fact context with entity candidates and related old facts", async () => {
    await write(
      path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH),
      `${JSON.stringify({
        id: "tf-old-msap",
        type: "temporal_fact",
        status: "active",
        subject: "三孚新科",
        predicate: "HAS_ORDER",
        object: "mSAP电镀设备订单",
        claim: "三孚新科 mSAP 电镀设备订单已经落地。",
        validAt: "2026-05-28",
      })}\n`,
    )
    const sourcePath = path.join(tmpRoot, "raw/研报新闻/2026-06-06-三孚新科澄清.md")
    await write(sourcePath, "# 三孚新科澄清\n\n三孚新科 688359.SH mSAP 电镀设备订单尚未确认，旧订单结论需要回查。")

    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath,
      reportId: "temporal-context",
    })

    expect(result.temporalFactContext.entityCandidates.map((item) => item.entityKey)).toContain("stock:SH688359")
    expect(result.temporalFactContext.relatedFacts.map((item) => item.id)).toContain("tf-old-msap")
    expect(result.contextMarkdown).toContain("Temporal Fact Context")
    expect(result.contextMarkdown).toContain("tf-old-msap")
    const saved = JSON.parse(await read(path.join(result.reportDir, "candidate-pages.json")))
    expect(saved.temporalFactContext.relatedFacts.map((item) => item.id)).toContain("tf-old-msap")
  })

  it("adds segment-level temporal fact seeds for long multi-topic sources", async () => {
    await write(
      path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH),
      `${JSON.stringify({
        id: "tf-sanf-msap",
        type: "temporal_fact",
        status: "active",
        subject: "三孚新科",
        predicate: "HAS_ORDER",
        object: "mSAP电镀设备订单",
        claim: "三孚新科 mSAP 电镀设备订单已经落地。",
        validAt: "2026-05-28",
      })}\n`,
    )
    const sourcePath = path.join(tmpRoot, "raw/微信聊天/2026-06-06-temporal-segments.md")
    const source = [
      "# 2026-06-06 多主题舆情",
      "",
      "### 重点板块/标的",
      "",
      "1. 三孚新科/mSAP订单澄清｜热度：高｜原文数：3",
      "   - 三孚新科 688359.SH mSAP 电镀设备订单尚未确认，可能需要推翻旧订单事实。",
      "   - 需要回看旧 fact id 后再 supersedes。",
      "",
      "2. 电力运营商重估｜热度：中｜原文数：2",
      "   - 电力负荷、容量电价、运营商重估继续发酵。",
      "",
      "### 风险与待验证",
      "- 订单事实强度待公告验证。",
    ].join("\n")
    await write(sourcePath, source)

    const result = await prepareIngest({
      projectPath: tmpRoot,
      sourcePath,
      reportId: "temporal-segments",
    })

    const sanfSegment = result.temporalFactContext.segmentFactSeeds.find((item) => item.title.includes("三孚新科"))
    expect(sanfSegment.entityCandidates.map((item) => item.entityKey)).toContain("stock:SH688359")
    expect(sanfSegment.relatedFacts.map((item) => item.id)).toContain("tf-sanf-msap")
    expect(result.contextMarkdown).toContain("Segment Fact Seeds")
  })

  it("audits existing wiki for temporal predicate and concept alias candidates", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/三孚新科.md"),
      `---
schema_version: 1
title: 三孚新科
aliases:
  - 688359
  - 688359.SH
code: SH688359
type: 股票
summary: 三孚新科跟踪 mSAP 类载板设备、客户验证、订单落地、产能扩张和涨价风险。
tags:
  - mSAP
  - 类载板
related:
  - "[[概念/mSAP类载板]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 三孚新科

## 订单与客户验证
三孚新科的 mSAP 设备订单、客户验证、产能扩张、涨价弹性和澄清风险都需要进入 temporal facts 审计。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/mSAP类载板.md"),
      `---
schema_version: 1
title: mSAP类载板
aliases:
  - mSAP
  - 类载板
  - 载板
type: 概念
summary: mSAP 类载板跟踪 ABF、IC substrate、设备订单、产能瓶颈、客户验证和供给约束。
tags:
  - ABF
  - IC substrate
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# mSAP类载板

mSAP 类载板涉及 ABF、IC substrate、设备订单、产能瓶颈、客户验证和供给约束。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/华为τ定律与LogicFolding.md"),
      `---
schema_version: 1
title: 华为τ定律与LogicFolding
aliases:
  - LogicFolding
  - 华为τ定律
type: 概念
summary: 华为τ定律与 LogicFolding 属于先进封装与逻辑折叠技术路径。
tags:
  - 先进封装
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 华为τ定律与LogicFolding

LogicFolding 和华为τ定律需要作为人工裁决样例。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/逻辑折叠.md"),
      `---
schema_version: 1
title: 逻辑折叠
aliases:
  - LogicFolding
type: 概念
summary: 逻辑折叠是先进封装路径中的一个表达。
tags:
  - 先进封装
related: []
sources: []
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 逻辑折叠

LogicFolding 可能和华为τ定律页面冲突。
`,
    )

    const result = await runTemporalFactsAudit({
      projectPath: tmpRoot,
      reportId: "audit-test",
      write: true,
      topN: 20,
    })

    expect(result.counts.wikiFiles).toBeGreaterThan(0)
    expect(result.predicateCandidates.map((item) => item.suggestedPredicate)).toEqual(expect.arrayContaining(["HAS_ORDER", "CUSTOMER_VALIDATED", "HAS_CAPACITY", "PRICE_VALIDATED", "HAS_RISK", "HAS_VALIDATION_SIGNAL"]))
    const orderPredicate = result.predicateCandidates.find((item) => item.term === "订单")
    expect(orderPredicate.candidatePredicates).toEqual(expect.arrayContaining(["HAS_ORDER_RUMOR", "HAS_CONFIRMED_ORDER"]))
    const stockAlias = result.aliasCandidates.find((item) => item.entityKey === "stock:SH688359")
    expect(stockAlias.aliases.map((item) => item.alias)).toEqual(expect.arrayContaining(["688359", "688359.SH"]))
    expect(stockAlias.aliases.map((item) => item.alias)).not.toEqual(expect.arrayContaining(["mSAP", "类载板"]))
    const conceptAlias = result.aliasCandidates.find((item) => item.path === "wiki/概念/mSAP类载板.md")
    expect(conceptAlias.aliases.map((item) => item.alias)).toEqual(expect.arrayContaining(["mSAP", "类载板"]))
    expect(conceptAlias.aliases.map((item) => item.alias)).not.toContain("ABF")
    expect(result.tagCandidates.map((item) => item.tag)).toEqual(expect.arrayContaining(["mSAP", "类载板", "ABF", "ICsubstrate"]))
    expect(result.tagCandidates.find((item) => item.tag === "mSAP").classification).toBe("promote_concept")
    expect(result.tagCandidates.find((item) => item.tag === "先进封装").classification).toBe("promote_concept")
    expect(result.abbreviationCandidates.map((item) => item.abbreviation)).toEqual(expect.arrayContaining(["mSAP", "ABF"]))
    expect(result.abbreviationCandidates.find((item) => item.abbreviation === "ABF").classification).toBe("alias_whitelist")
    const logicConflict = result.aliasConflicts.find((item) => item.alias === "LogicFolding")
    expect(logicConflict.ruling.target).toBe("华为τ定律与LogicFolding")
    expect(result.curatedAliasRulings.find((item) => item.alias === "LogicFolding").matchedConflict).toBe(true)
    expect(result.conceptHierarchyRules.map((item) => item.root)).toEqual(expect.arrayContaining(["先进封装"]))
    expect(result.outputs).toEqual({
      json: ".llm-wiki/temporal-facts/audit-test.json",
      markdown: ".llm-wiki/temporal-facts/audit-test.md",
    })
    expect(await read(path.join(tmpRoot, result.outputs.markdown))).toContain("Temporal Facts Audit")
    expect(await read(path.join(tmpRoot, result.outputs.markdown))).toContain("Tag Candidates")
    expect(await read(path.join(tmpRoot, result.outputs.markdown))).toContain("Curated Alias Rulings")
    expect(JSON.parse(await read(path.join(tmpRoot, result.outputs.json))).counts.aliasCandidates).toBeGreaterThan(0)
  })

  it("keeps ask and ingest retrieval modes explicit", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const sourceContent = await read(source)
    const candidates = await searchCandidatePages(tmpRoot, source, sourceContent, { topWiki: 5 })
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "AI服务器电源 最近一周",
      topWiki: 3,
      topRaw: 3,
    })

    expect(candidates.retrievalMode).toBe("ingest")
    expect(candidates.wikiCandidates.every((item) => item.retrievalMode === "ingest")).toBe(true)
    expect(context.retrievalMode).toBe("ask")
    expect(context.wikiResults.every((item) => item.retrievalMode === "ask")).toBe(true)
  })

  it("ask retrieval reads frontmatter freshness and decays stale topic pages", async () => {
    const freshTs = timestampDaysAgo(3)
    const staleTs = timestampDaysAgo(420)
    const page = (title, timestamp) => `---
schema_version: 1
title: ${title}
aliases:
  - 机器人订单进展
type: 概念
summary: 机器人订单进展页跟踪执行器、客户、出货、量产和供应商导入验证节点。
tags:
  - 机器人
  - 订单
related: []
sources: []
created: ${timestamp}
updated: ${timestamp}
last_reviewed: ${timestamp}
confidence: 中
status: 活跃
---

# ${title}

机器人订单进展、执行器客户、出货、量产和供应商导入验证节点。
`

    await write(path.join(tmpRoot, "wiki/概念/机器人订单进展-新.md"), page("机器人订单进展", freshTs))
    await write(path.join(tmpRoot, "wiki/概念/机器人订单进展-旧.md"), page("机器人订单进展", staleTs))

    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "最新机器人订单进展 执行器客户出货和量产验证",
      sources: "wiki",
      topWiki: 8,
    })

    const paths = context.wikiResults.map((item) => item.path)
    const fresh = context.wikiResults.find((item) => item.path === "wiki/概念/机器人订单进展-新.md")
    const stale = context.wikiResults.find((item) => item.path === "wiki/概念/机器人订单进展-旧.md")
    expect(paths.indexOf("wiki/概念/机器人订单进展-新.md")).toBeLessThan(paths.indexOf("wiki/概念/机器人订单进展-旧.md"))
    expect(fresh.frontmatterUpdated).toBe(freshTs)
    expect(fresh.freshnessScore).toBeGreaterThan(0)
    expect(stale.frontmatterUpdated).toBe(staleTs)
    expect(stale.staleDays).toBeGreaterThan(365)
    expect(stale.freshnessScore).toBeLessThan(0)
  })

	  it("tokenizeQuery keeps Chinese bigrams and full phrase tokens", () => {
	    const tokens = tokenizeQuery("最近一个月 AI服务器电源 机器人方向")
	    expect(tokens).toContain("服务")
	    expect(tokens).toContain("服务器")
	    expect(tokens).toContain("电源")
	    expect(tokens).toContain("机器人")
	    expect(tokens).toContain("ai服务器电源")
	  })

	  it("ask retrieval ranks concrete pages and expands graph neighbors", async () => {
	    await write(
	      path.join(tmpRoot, "wiki/log.md"),
	      `# log\n\n${"AI服务器电源 算电协同 最近一周 ".repeat(120)}`,
	    )
	    const context = await buildAskRetrievalContext({
	      projectPath: tmpRoot,
	      query: "AI服务器电源 最近一周",
	      topWiki: 1,
	      topRaw: 3,
	      graphNeighbors: 3,
	    })

	    expect(context.wikiResults[0].path).toBe("wiki/概念/算电协同.md")
	    expect(context.wikiResults.map((item) => item.path)).not.toContain("wiki/log.md")
	    expect(context.rawResults.map((item) => item.path)).toContain("raw/研报新闻/2026-05-28-AI服务器电源.md")
	    expect(context.graphExpansions.map((item) => item.path)).toContain("wiki/概念/电力运营商重估.md")
	    expect(context.graphExpansions.find((item) => item.path === "wiki/概念/电力运营商重估.md").reasons[0]).toContain("linked from")
	    expect(context.prompt).toContain("结论、证据链、分歧/反证、后续验证、交易含义、引用来源")
	  })

  it("ask retrieval prefers concrete raw evidence over broad chat heat for physical AI questions", async () => {
    await write(
      path.join(tmpRoot, "wiki/概念/物理AI与具身智能.md"),
      `---
schema_version: 1
title: 物理AI与具身智能
aliases:
  - 物理AI
  - 具身智能
type: 概念
summary: 物理AI与具身智能页通过表头沉淀机器人方向的量产、客户、订单、出货和交易验证节点。
tags:
  - 物理AI
  - 具身智能
  - 机器人
related:
  - "[[概念/机器人产业链]]"
sources:
  - raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-04/0060-复盘-机器人-126380.md
created: 2026-05-11 14:23:07
updated: 2026-05-11 14:23:07
last_reviewed: 2026-05-11 14:23:07
confidence: 中
status: 活跃
---

# 物理AI与具身智能

本页把机器人从主题热度压到客户、订单、出货和量产兑现验证。
`,
    )
    await write(
      path.join(tmpRoot, "raw/微信聊天/2026-06-05.md"),
      "# 微信聊天\n\n最近一个月物理AI投资方向，交易验证、证据、标的、机器人热度、电子通信资金扩散都有讨论，但缺少客户、订单、出货节点。",
    )
    await write(
      path.join(tmpRoot, "raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-04/0060-复盘-机器人-126380.md"),
      "# 复盘-机器人\n\n具身智能和割草机器人进入订单验证阶段，客户包括九号、石头，关注出货、量产、客户节点和供应商导入。",
    )

    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "最近一个月物理AI/具身智能/机器人方向，A股投资应该优先看哪些产业链环节和标的？请区分已有知识库反复验证的证据、仍偏叙事的环节，以及交易上要验证的量价/订单/客户节点。",
      sources: "raw",
      topRaw: 3,
    })

    expect(context.rawResults[0].path).toBe("raw/openclaw数据/产业链复盘/gangtise_themes/2026-06-04/0060-复盘-机器人-126380.md")
    expect(context.rawResults[0].structuredSourceMatch).toContain("wiki/概念/物理AI与具身智能.md")
    expect(context.rawResults.map((item) => item.path)).toContain("raw/微信聊天/2026-06-05.md")
  })

  it("ask eval scores recall, evidence coverage, raw noise, and structured fields", async () => {
    const result = await runAskEval({
      projectPath: tmpRoot,
      query: "AI服务器电源 最近一周",
      sources: "wiki,raw,graph",
      topWiki: 5,
      topRaw: 5,
      graphNeighbors: 3,
      expectedPaths: "wiki/概念/算电协同.md,raw/研报新闻/2026-05-28-AI服务器电源.md,wiki/概念/电力运营商重估.md",
    })

    expect(result.retrievalMode).toBe("ask")
    expect(result.aggregate.overall).toBeGreaterThan(0)
    expect(result.cases[0].metrics.recall).toBe(100)
    expect(result.cases[0].metrics.evidenceCoverage).toBeGreaterThan(0)
    expect(result.cases[0].metrics.structureFieldCoverage).toBeGreaterThan(0)
    expect(result.cases[0].topHits.map((item) => item.path)).toContain("wiki/概念/算电协同.md")
  })

  it("routes ask sources with rule fallback and keeps stock SQL available when columns are provided", async () => {
    const routing = await selectAskSources({
      projectPath: tmpRoot,
      query: "SZ000001 最近20个交易日涨跌幅和成交量",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "pct_chg", "volume"],
    })

    expect(routing.route.mode).toBe("rules")
    expect(routing.selectedSources.map((source) => source.id)).toContain("stock_daily_sql")
    expect(routing.selectedSources.find((source) => source.id === "stock_daily_sql").columns).toMatchObject({
      ticker: "ticker",
      date: "date",
    })
  })

  it("searches facts jsonl as a native source", async () => {
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "高开接盘 案例",
      sources: "facts",
    })

    expect(context.selectedSources.map((source) => source.id)).toEqual(["facts_jsonl"])
    expect(context.factsResults[0].path).toContain("facts:data/facts/cases.jsonl:1")
    expect(context.factsResults[0].excerpt).toContain("高开接盘")
    expect(context.prompt).toContain("Facts JSONL Hits")
  })

  it("keeps invalidated temporal facts out of normal facts evidence by default", async () => {
    await write(
      path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH),
      [
        JSON.stringify({
          id: "tf-active-msap",
          type: "temporal_fact",
          status: "active",
          subject: "三孚新科",
          predicate: "HAS_ORDER",
          object: "mSAP电镀设备订单",
          claim: "三孚新科 mSAP 订单仍是当前待验证事实。",
          validAt: "2026-05-28",
        }),
        JSON.stringify({
          id: "tf-invalid-msap",
          type: "temporal_fact",
          status: "invalidated",
          subject: "三孚新科",
          predicate: "HAS_ORDER",
          object: "旧mSAP订单传闻",
          claim: "三孚新科 mSAP 旧订单传闻已被证伪。",
          validAt: "2026-05-20",
          invalidatedAt: "2026-05-29",
        }),
      ].join("\n") + "\n",
    )

    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "三孚新科 mSAP 订单",
      sources: "facts",
    })

    expect(context.factsResults.map((item) => item.value.id)).toContain("tf-active-msap")
    expect(context.factsResults.map((item) => item.value.id)).not.toContain("tf-invalid-msap")
    expect(context.invalidatedFactsResults).toHaveLength(0)

    const auditContext = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "三孚新科 mSAP 订单",
      sources: "facts",
      includeInvalidated: true,
    })
    expect(auditContext.factsResults.map((item) => item.value.id)).not.toContain("tf-invalid-msap")
    expect(auditContext.invalidatedFactsResults.map((item) => item.value.id)).toContain("tf-invalid-msap")
    expect(auditContext.invalidatedFactsResults[0].ref).toMatch(/^FH/)
  })

  it("searches brain memory as a long-term correction source", async () => {
    await write(
      path.join(tmpRoot, "data/brain/corrections.jsonl"),
      `${JSON.stringify({ id: "corr-1", type: "correction", title: "高开接盘卫语句", text: "高开接盘必须看承接，不允许把热度当作买点", tags: ["高开接盘", "L4"] })}\n`,
    )
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "高开接盘 最近错误",
      sources: "brain",
    })

    expect(context.selectedSources.map((source) => source.id)).toEqual(["brain_memory"])
    expect(context.brainResults[0].path).toContain("brain:data/brain/corrections.jsonl:1")
    expect(context.brainResults[0].excerpt).toContain("不允许把热度当作买点")
    expect(context.prompt).toContain("Brain Memory Hits")
  })

  it("prefers .llm-wiki graph json and preserves edge types in expansion reasons", async () => {
    await write(
      path.join(tmpRoot, ".llm-wiki/graph.json"),
      JSON.stringify(
        {
          nodes: [
            { id: "概念/算电协同", label: "算电协同", type: "概念", path: "wiki/概念/算电协同.md" },
            { id: "概念/电力运营商重估", label: "电力运营商重估", type: "概念", path: "wiki/概念/电力运营商重估.md" },
          ],
          edges: [{ source: "概念/算电协同", target: "概念/电力运营商重估", type: "graph-json-link" }],
        },
        null,
        2,
      ),
    )
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "AI服务器电源 最近一周",
      topWiki: 1,
      topRaw: 0,
      graphNeighbors: 3,
      sources: "wiki,graph",
    })

    const expansion = context.graphExpansions.find((item) => item.path === "wiki/概念/电力运营商重估.md")
    expect(expansion.reasons[0]).toContain("graph-json-link")
  })

  it("merges stale graph json with current frontmatter related edges", async () => {
    await write(
      path.join(tmpRoot, ".llm-wiki/graph.json"),
      JSON.stringify(
        {
          nodes: [
            { id: "概念/算电协同", label: "算电协同", type: "概念", path: "wiki/概念/算电协同.md" },
            { id: "概念/电力运营商重估", label: "电力运营商重估", type: "概念", path: "wiki/概念/电力运营商重估.md" },
          ],
          edges: [],
        },
        null,
        2,
      ),
    )
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "AI服务器电源 最近一周",
      topWiki: 1,
      topRaw: 0,
      graphNeighbors: 3,
      sources: "wiki,graph",
    })

    const expansion = context.graphExpansions.find((item) => item.path === "wiki/概念/电力运营商重估.md")
    expect(expansion).toBeTruthy()
    expect(expansion.reasons.join(" ")).toContain("wikilink")
  })

  it("supports bounded two-hop graph expansion for industry-chain queries", async () => {
    await write(
      path.join(tmpRoot, "wiki/概念/算电协同.md"),
      `---
schema_version: 1
title: 算电协同
aliases:
  - AI服务器电源
type: 概念
summary: 算电协同页跟踪 AI 服务器电源、数据中心供电和产业链受益方向。
tags:
  - AI电源
  - 算力
related:
  - "[[概念/电力运营商重估]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-06-08 14:23:07
last_reviewed: 2026-06-08 14:23:07
confidence: 中
status: 活跃
---

# 算电协同

${"AI服务器电源 产业链 受益方向 数据中心供电 ".repeat(80)}
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/电力运营商重估.md"),
      `---
schema_version: 1
title: 电力运营商重估
aliases: []
type: 概念
summary: 电力运营商重估页跟踪算力供电、电力负荷、运营商估值和下游扩展关系。
tags:
  - 电力
related:
  - "[[概念/机器人执行器]]"
sources: []
created: 2026-05-11 14:23:07
updated: 2026-06-08 14:23:07
last_reviewed: 2026-06-08 14:23:07
confidence: 中
status: 活跃
---

# 电力运营商重估

负荷增长带来估值变化。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/机器人执行器.md"),
      `${validFrontmatter("机器人执行器")}# 机器人执行器\n\n机器人执行器属于二跳扩展线索，需要后续证据验证。\n`,
    )

    const oneHop = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "AI服务器电源 产业链 机器人受益方向",
      sources: "wiki,graph",
      topWiki: 1,
      topRaw: 0,
      graphNeighbors: 5,
      graphDepth: 1,
    })
    expect(oneHop.graphExpansions.map((item) => item.path)).not.toContain("wiki/概念/机器人执行器.md")

    const autoDepth = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "AI服务器电源 产业链 机器人受益方向",
      sources: "wiki,graph",
      topWiki: 1,
      topRaw: 0,
      graphNeighbors: 5,
    })
    const expansion = autoDepth.graphExpansions.find((item) => item.path === "wiki/概念/机器人执行器.md")
    expect(expansion).toBeTruthy()
    expect(expansion.hop).toBe(2)
    expect(expansion.pathTrace).toEqual([
      "wiki/概念/算电协同.md",
      "wiki/概念/电力运营商重估.md",
      "wiki/概念/机器人执行器.md",
    ])
    expect(expansion.reasons.join(" ")).toContain("hop 2")
    expect(autoDepth.nativeQueries.find((item) => item.sourceId === "wiki_graph").summary).toContain("graph_depth=2")
  })

  it("builds parameterized stock daily SQL from parsed stock intent", async () => {
    const intent = parseStockDailyIntent("SZ000001 最近20个交易日涨跌幅和成交量")
    const nativeQuery = buildStockDailySqlQuery(
      intent,
      {
        columns: {
          ready: true,
          ticker: "ticker",
          date: "date",
          open: "open",
          high: "high",
          low: "low",
          close: "close",
          pctChange: "pct_chg",
          volume: "volume",
          all: ["ticker", "date", "open", "high", "low", "close", "pct_chg", "volume"],
        },
      },
      { sqlLimit: 200 },
    )

    expect(intent.tickerCandidates).toContain("SZ000001")
    expect(intent.tickerCandidates).toContain("000001.SZ")
    expect(nativeQuery.sql).toContain("where \"ticker\" = any($1::text[])")
    expect(nativeQuery.params[0]).toEqual(expect.arrayContaining(["SZ000001", "000001.SZ"]))
    expect(nativeQuery.params[1]).toBe(20)
    expect(nativeQuery.summary).not.toContain("password")
  })

  it("executes stock daily source through a read-only native executor hook", async () => {
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "利通电子 最近20个交易日是否走强，涨跌幅和成交量怎么样",
      sources: "stock-price",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "pct_chg", "volume"],
      stockDailyExecutor: async ({ nativeQuery }) => {
        expect(nativeQuery.params[0]).toEqual(expect.arrayContaining(["SH603629", "603629.SH"]))
        return {
          rows: [
            { ticker: "SH603629", date: "2026-05-27", open: 10, high: 10.2, low: 9.8, close: 10, pct_chg: 0.5, volume: 10000 },
            { ticker: "SH603629", date: "2026-05-28", open: 10.2, high: 10.8, low: 10.1, close: 10.6, pct_chg: 6, volume: 13000 },
          ],
        }
      },
    })

    expect(context.selectedSources.map((source) => source.id)).toEqual(["stock_daily_sql"])
    expect(context.stockDaily.status).toBe("ok")
    expect(context.stockDailyResults[0].path).toBe("sql:cn_stock_price_daily_wind#SH603629/2026-05-27")
    expect(context.stockDailyResults[1].path).toBe("sql:cn_stock_price_daily_wind#SH603629/2026-05-28")
    expect(context.stockDailyResults[1].excerpt).toContain("pct_chg=6")
    expect(context.marketValidation).toMatchObject({
      sourceId: "stock_daily_sql",
      status: "ready",
      verdict: "验证通过",
      stockCode: "SH603629",
      periodReturnPct: 6,
      lastVolumeVsAvg: 1.13,
    })
    expect(context.prompt).toContain("Market Validation")
    expect(context.prompt).toContain("Stock Daily SQL Hits")
  })

  it("redacts stock SQL password from source registry diagnostics", async () => {
    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "SZ000001 最近20个交易日涨跌幅",
      sources: "stock-price",
      pgPassword: "super-secret-test-password",
      stockDailyColumns: ["ticker", "date", "close"],
      stockDailyExecutor: async () => ({ rows: [] }),
    })

    const serialized = JSON.stringify({
      selectedSources: context.selectedSources,
      nativeQueries: context.nativeQueries,
      retrievalWarnings: context.retrievalWarnings,
      marketValidation: context.marketValidation,
    })
    expect(serialized).toContain("[redacted]")
    expect(serialized).not.toContain("super-secret-test-password")
  })

  it("loads stock SQL credentials from PG_SHIHAO_CONFIG_PATH without leaking the password", async () => {
    const configPath = path.join(tmpRoot, "pg-shihao-config.json")
    await write(
      configPath,
      JSON.stringify({
        host: "db.local",
        port: 5432,
        user: "reader",
        password: "file-secret-test-password",
        database: "non_stock_db",
        schema: "non_stock_schema",
        table: "non_stock_table",
      }),
    )

    const previous = process.env.PG_SHIHAO_CONFIG_PATH
    const previousPassword = process.env.PG_SHIHAO_PASSWORD
    process.env.PG_SHIHAO_CONFIG_PATH = configPath
    delete process.env.PG_SHIHAO_PASSWORD
    try {
      const context = await buildAskRetrievalContext({
        projectPath: tmpRoot,
        query: "SZ000001 最近20个交易日涨跌幅",
        sources: "stock-price",
        stockDailyColumns: ["ticker", "date", "close"],
        stockDailyExecutor: async () => ({ rows: [] }),
      })

      const serialized = JSON.stringify({
        selectedSources: context.selectedSources,
        nativeQueries: context.nativeQueries,
        retrievalWarnings: context.retrievalWarnings,
        marketValidation: context.marketValidation,
      })
      expect(serialized).toContain("[redacted]")
      expect(serialized).toContain("non_stock_db")
      expect(serialized).toContain("non_stock_schema")
      expect(serialized).toContain("non_stock_table")
      expect(serialized).not.toContain("file-secret-test-password")
    } finally {
      if (previous === undefined) delete process.env.PG_SHIHAO_CONFIG_PATH
      else process.env.PG_SHIHAO_CONFIG_PATH = previous
      if (previousPassword === undefined) delete process.env.PG_SHIHAO_PASSWORD
      else process.env.PG_SHIHAO_PASSWORD = previousPassword
    }
  })

  it("does not synthesize public stock SQL connection defaults when local config is missing", async () => {
    const saved = {
      PG_SHIHAO_CONFIG_PATH: process.env.PG_SHIHAO_CONFIG_PATH,
      PG_SHIHAO_HOST: process.env.PG_SHIHAO_HOST,
      PG_SHIHAO_PORT: process.env.PG_SHIHAO_PORT,
      PG_SHIHAO_USER: process.env.PG_SHIHAO_USER,
      PG_SHIHAO_PASSWORD: process.env.PG_SHIHAO_PASSWORD,
      PG_SHIHAO_DATABASE: process.env.PG_SHIHAO_DATABASE,
      PG_SHIHAO_SCHEMA: process.env.PG_SHIHAO_SCHEMA,
      PG_SHIHAO_STOCK_DAILY_TABLE: process.env.PG_SHIHAO_STOCK_DAILY_TABLE,
    }
    for (const key of Object.keys(saved)) delete process.env[key]
    try {
      const context = await buildAskRetrievalContext({
        projectPath: tmpRoot,
        query: "SZ000001 最近20个交易日涨跌幅",
        sources: "stock-price",
      })

      const serialized = JSON.stringify({
        selectedSources: context.selectedSources,
        nativeQueries: context.nativeQueries,
        retrievalWarnings: context.retrievalWarnings,
        sourceRegistry: context.sourceRegistry,
        marketValidation: context.marketValidation,
      })
      expect(serialized).toContain("PG_SHIHAO_HOST")
      expect(serialized).toContain("PG_SHIHAO_PORT")
      const stockSource = context.selectedSources.find((source) => source.id === "stock_daily_sql")
      expect(stockSource.config.host).toBeUndefined()
      expect(stockSource.config.port).toBeUndefined()
      expect(stockSource.config.user).toBeUndefined()
      expect(stockSource.config.database).toBe("cn_stock_db")
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
	})

describe("MPA brain memory and validation", () => {
  it("remembers, reports, and resolves brain memory explicitly", async () => {
    const remembered = await rememberBrainMemory({
      projectPath: tmpRoot,
      type: "correction",
      text: "高开接盘必须先看承接",
      title: "高开接盘纠错",
      tags: "高开接盘,L4",
    })
    expect(remembered.relativePath).toBe("data/brain/corrections.jsonl")
    expect(remembered.record.id).toContain("brain_correction_")

    const status = await getBrainStatus({ projectPath: tmpRoot })
    expect(status.total).toBe(1)
    expect(status.byType.correction).toBe(1)

    const resolved = await resolveBrainMemory({
      projectPath: tmpRoot,
      id: remembered.record.id,
      result: "failure",
      note: "盘面反向验证",
    })
    expect(resolved.relativePath).toBe("data/brain/self_training_events.jsonl")
    expect(resolved.record).toMatchObject({
      eventType: "manual-resolution",
      targetId: remembered.record.id,
      result: "failure",
      verdict: "验证失败",
    })
  })

  it("market-validates a prediction with stock SQL and writes only when requested", async () => {
    const dryRun = await marketValidatePrediction({
      projectPath: tmpRoot,
      prediction: "利通电子看多，应该走强",
      stock: "利通电子",
      window: "20d",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume"],
      stockDailyExecutor: async () => ({
        rows: [
          { ticker: "SH603629", date: "2026-05-27", open: 10, high: 10.2, low: 9.8, close: 10, volume: 10000 },
          { ticker: "SH603629", date: "2026-05-28", open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 13000 },
        ],
      }),
    })
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.record.verdict).toBe("验证通过")
    await expect(fs.access(path.join(tmpRoot, "data/brain/validations.jsonl"))).rejects.toThrow()

    const written = await marketValidatePrediction({
      projectPath: tmpRoot,
      prediction: "利通电子看多，应该走强",
      stock: "利通电子",
      window: "20d",
      write: true,
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume"],
      stockDailyExecutor: async () => ({
        rows: [
          { ticker: "SH603629", date: "2026-05-27", open: 10, high: 10.2, low: 9.8, close: 10, volume: 10000 },
          { ticker: "SH603629", date: "2026-05-28", open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 13000 },
        ],
      }),
    })
    expect(written.writeResult.relativePath).toBe("data/brain/validations.jsonl")
    expect(await read(path.join(tmpRoot, "data/brain/validations.jsonl"))).toContain("验证通过")
  })

  it("self-train dry-run emits MPA trigger actions without writing events", async () => {
    const validations = [
      { id: "v1", type: "validation", target: "AI服务器电源", result: "success", createdAt: "2026-05-01 10:00:00" },
      { id: "v2", type: "validation", target: "AI服务器电源", result: "success", createdAt: "2026-05-02 10:00:00" },
      { id: "v3", type: "validation", target: "AI服务器电源", result: "success", createdAt: "2026-05-03 10:00:00" },
      { id: "v4", type: "validation", target: "高开接盘模式", targetType: "pattern", result: "success", createdAt: "2026-05-01 10:00:00" },
      { id: "v5", type: "validation", target: "高开接盘模式", targetType: "pattern", result: "success", createdAt: "2026-05-02 10:00:00" },
      { id: "v6", type: "validation", target: "高开接盘模式", targetType: "pattern", result: "success", createdAt: "2026-05-03 10:00:00" },
      { id: "v7", type: "validation", target: "高开接盘模式", targetType: "pattern", result: "success", createdAt: "2026-05-04 10:00:00" },
      { id: "v8", type: "validation", target: "高开接盘模式", targetType: "pattern", result: "success", createdAt: "2026-05-05 10:00:00" },
    ]
    await write(path.join(tmpRoot, "data/brain/validations.jsonl"), `${validations.map((item) => JSON.stringify(item)).join("\n")}\n`)
    await write(
      path.join(tmpRoot, "data/brain/corrections.jsonl"),
      `${JSON.stringify({ id: "c1", type: "correction", errorType: "高开接盘" })}\n${JSON.stringify({ id: "c2", type: "correction", errorType: "高开接盘" })}\n`,
    )

    const result = await runSelfTraining({ projectPath: tmpRoot })
    expect(result.dryRun).toBe(true)
    expect(result.actions.map((action) => action.rule)).toContain("R1-concept-upgrade")
    expect(result.actions.map((action) => action.rule)).toContain("R3-pattern-solidify")
    expect(result.actions.map((action) => action.rule)).toContain("R6-error-guardrail-escalation")
    await expect(fs.access(path.join(tmpRoot, "data/brain/self_training_events.jsonl"))).rejects.toThrow()
  })

  it("exports training samples from brain memory records", async () => {
    await write(
      path.join(tmpRoot, "data/brain/corrections.jsonl"),
      `${JSON.stringify({ id: "corr-1", type: "correction", badAnswer: "高开就追", goodAnswer: "高开必须等承接确认" })}\n`,
    )
    await write(
      path.join(tmpRoot, "data/brain/validations.jsonl"),
      `${JSON.stringify({ id: "val-1", type: "validation", prediction: "利通电子看多", verdict: "验证通过", reason: "20日区间上涨" })}\n`,
    )

    const sft = await exportTrainingSamples({ projectPath: tmpRoot, kind: "sft" })
    expect(sft.count).toBe(2)
    expect(sft.relativePath).toMatch(/^\.llm-wiki\/exports\/training\/sft-\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(await read(sft.outputPath)).toContain("高开必须等承接确认")

    const preference = await exportTrainingSamples({ projectPath: tmpRoot, kind: "preference" })
    expect(preference.count).toBe(1)
    expect(await read(preference.outputPath)).toContain("accepted")
  })

  it("daily-loop show-context generates stock questions and does not write reports", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/利通电子.md"),
      `${validFrontmatter("利通电子", "股票", "code: SH603629\n")}
# 利通电子

AI服务器电源、PCB材料和算电协同供货商观察。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/股票/风华高科.md"),
      `${validFrontmatter("风华高科", "股票", "code: SZ000636\n")}
# 风华高科

MLCC、被动元件、AI服务器价值量提升。
`,
    )
    await write(
      path.join(tmpRoot, "raw/微信聊天/2026-06-03.md"),
      "AI硬件热门：PCB材料、MLCC、电源管理、HVDC、光模块上游继续发酵。",
    )

    const result = await runDailyLoop({
      projectPath: tmpRoot,
      mode: "premarket",
      questionCount: 6,
      showContext: true,
      answer: false,
      dailyLoopQuestionPlanner: async () => ({
        questions: [
          {
            questionType: "expected_difference",
            themeId: "passive-components",
            branch: "MLCC/被动元件链",
            question: "最近一个月，AI硬件里的MLCC/被动元件链是否属于知识库反复出现但股价还没充分反映的补涨方向？请结合原始材料、图谱关系和近20日量价排序。",
            expectedMove: "bullish",
            stockCodes: ["SZ000636"],
            reason: "MLCC在近期原始材料中反复出现，且需要结合量价验证。",
          },
        ],
      }),
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume", "amount", "turnover", "pct_cng"],
      stockDailyExecutor: async ({ nativeQuery }) => ({
        rows: nativeQuery.params[0].includes("SH603629")
          ? [
              { ticker: "SH603629", date: "2026-05-27", open: 10, high: 11, low: 9, close: 10, volume: 100, amount: 1000, turnover: 2, pct_cng: 0 },
              { ticker: "SH603629", date: "2026-05-28", open: 10, high: 12, low: 10, close: 11, volume: 150, amount: 1800, turnover: 3, pct_cng: 10 },
              { ticker: "SZ000636", date: "2026-05-27", open: 20, high: 22, low: 19, close: 20, volume: 100, amount: 2000, turnover: 2, pct_cng: 0 },
              { ticker: "SZ000636", date: "2026-05-28", open: 20, high: 25, low: 20, close: 24, volume: 300, amount: 7000, turnover: 6, pct_cng: 20 },
            ]
          : [],
      }),
      externalMarketFetcher: async ({ code }) => {
        const symbol = code.startsWith("SH") ? `sh${code.slice(2)}` : `sz${code.slice(2)}`
        return {
          code: 0,
          data: {
            [symbol]: {
              qfqday:
                code === "SH603629"
                  ? [
                      ["2026-05-28", "10", "11", "12", "10", "150"],
                      ["2026-05-29", "11", "12", "13", "11", "200"],
                    ]
                  : [
                      ["2026-05-28", "20", "24", "25", "20", "300"],
                      ["2026-05-29", "24", "25", "26", "23", "320"],
                    ],
            },
          },
        }
      },
    })

    expect(result.dryRun).toBe(true)
    expect(result.counts.questions).toBeGreaterThanOrEqual(6)
    expect(result.questionPlanner.status).toBe("llm")
    expect(result.questions.every((question) => question.stocks.some((stock) => stock.code))).toBe(true)
    expect(result.questions.map((question) => question.question).join("\n")).toContain("近20日量价")
    expect(result.questions.map((question) => question.question).join("\n")).not.toContain("SH603629")
    expect(result.questions.flatMap((question) => question.stocks).map((stock) => stock.code)).toContain("SH603629")
    expect(result.marketValidation.externalStatus).toBe("ok")
    expect(result.questions.flatMap((question) => question.stocks).some((stock) => stock.metric?.marketValidation?.status === "sql_stale")).toBe(true)
    expect(result.sql.nativeQuery.summary).not.toContain("password")
    await expect(fs.access(path.join(tmpRoot, ".llm-wiki/daily-research"))).rejects.toThrow()
    await expect(fs.access(path.join(tmpRoot, "data/brain/predictions.jsonl"))).rejects.toThrow()
  })

  it("daily-loop write stores predictions, reports, feedback, and pending validations only outside wiki", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/利通电子.md"),
      `${validFrontmatter("利通电子", "股票", "code: SH603629\n")}
# 利通电子

AI服务器电源、PCB材料和算电协同供货商观察。
`,
    )
    await write(
      path.join(tmpRoot, "wiki/股票/风华高科.md"),
      `${validFrontmatter("风华高科", "股票", "code: SZ000636\n")}
# 风华高科

MLCC、被动元件、AI服务器价值量提升。
`,
    )
    await write(
      path.join(tmpRoot, "raw/微信聊天/2026-06-03.md"),
      "AI硬件热门：PCB材料、MLCC、电源管理、HVDC、光模块上游继续发酵。",
    )
    await write(
      path.join(tmpRoot, "data/brain/predictions.jsonl"),
      `${JSON.stringify({
        id: "pred-old",
        type: "prediction",
        kind: "daily-discovery",
        branch: "AI服务器电源",
        question: "利通电子看多",
        expectedMove: "bullish",
        status: "pending",
        stocks: [{ name: "利通电子", code: "SH603629", branch: "AI服务器电源" }],
        validationWindows: [1],
        createdAt: "2026-05-27 08:30:00",
      })}\n`,
    )

    const result = await runDailyLoop({
      projectPath: tmpRoot,
      mode: "postclose",
      questionCount: 8,
      write: true,
      useLlmQuestionPlanner: false,
      marketValidate: "off",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume", "amount", "turnover", "pct_cng"],
      stockDailyExecutor: async () => ({
        rows: [
          { ticker: "SH603629", date: "2026-05-27", open: 10, high: 11, low: 9, close: 10, volume: 100, amount: 1000, turnover: 2, pct_cng: 0 },
          { ticker: "SH603629", date: "2026-05-28", open: 10, high: 12, low: 10, close: 11, volume: 150, amount: 1800, turnover: 3, pct_cng: 10 },
          { ticker: "SZ000636", date: "2026-05-27", open: 20, high: 22, low: 19, close: 20, volume: 100, amount: 2000, turnover: 2, pct_cng: 0 },
          { ticker: "SZ000636", date: "2026-05-28", open: 20, high: 25, low: 20, close: 24, volume: 300, amount: 7000, turnover: 6, pct_cng: 20 },
        ],
      }),
      dailyLoopAnswerer: async ({ question }) => `结论：${question.branch} 继续观察。\n引用来源：测试。`,
    })

    expect(result.dryRun).toBe(false)
    expect(result.reportRelativePath).toMatch(/^\.llm-wiki\/daily-research\/\d{4}-\d{2}-\d{2}-postclose\.md$/)
    expect(result.feedbackRelativePath).toMatch(/^\.llm-wiki\/wiki-feedback\/\d{4}-\d{2}-\d{2}\.md$/)
    expect(await read(path.join(tmpRoot, "data/brain/predictions.jsonl"))).toContain("daily-discovery")
    expect(await read(path.join(tmpRoot, "data/brain/validations.jsonl"))).toContain("pred-old")
    expect(await read(result.reportPath)).toContain("Daily Research postclose")
    expect(await read(result.feedbackPath)).toContain("review queue only")
    await expect(fs.access(path.join(tmpRoot, "wiki/查询"))).rejects.toThrow()
  })

  it("validates pending predictions from the first trading day after the answer and tracks later-window revisions", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/利通电子.md"),
      `${validFrontmatter("利通电子", "股票", "code: SH603629\n")}
# 利通电子

AI服务器电源、PCB材料和算电协同供货商观察。
`,
    )
    await write(path.join(tmpRoot, "raw/微信聊天/2026-06-03.md"), "AI硬件热门：电源管理继续发酵。")
    await write(
      path.join(tmpRoot, "data/brain/predictions.jsonl"),
      `${JSON.stringify({
        id: "pred-after-close",
        type: "prediction",
        kind: "daily-discovery",
        branch: "AI服务器电源",
        question: "利通电子看多，应该走强",
        expectedMove: "bullish",
        status: "pending",
        stocks: [{ name: "利通电子", code: "SH603629", branch: "AI服务器电源" }],
        validationWindows: [1, 3],
        createdAt: "2026-05-27 18:30:00",
      })}\n`,
    )

    const rows = [
      { ticker: "SH603629", date: "2026-05-27", open: 10, high: 12, low: 10, close: 11, volume: 100, amount: 1100, turnover: 2, pct_cng: 10 },
      { ticker: "SH603629", date: "2026-05-28", open: 11, high: 11, low: 9, close: 9, volume: 100, amount: 900, turnover: 2, pct_cng: -18.18 },
      { ticker: "SH603629", date: "2026-05-29", open: 9, high: 12, low: 9, close: 12, volume: 160, amount: 1800, turnover: 3, pct_cng: 33.33 },
      { ticker: "SH603629", date: "2026-06-01", open: 12, high: 13, low: 12, close: 13, volume: 180, amount: 2300, turnover: 4, pct_cng: 8.33 },
    ]

    const result = await runDailyLoop({
      projectPath: tmpRoot,
      mode: "postclose",
      validatePendingOnly: true,
      showContext: true,
      answer: false,
      marketValidate: "off",
      validationWindows: "1,3",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume", "amount", "turnover", "pct_cng"],
      stockDailyExecutor: async ({ nativeQuery }) => {
        const start = nativeQuery.params[2]
        const filtered = rows
          .filter((row) => row.ticker === "SH603629")
          .filter((row) => (nativeQuery.validationAnchorExclusive ? row.date > start : row.date >= start))
          .slice(0, nativeQuery.limit)
        return { rows: filtered }
      },
    })

    const oldValidations = result.validations.filter((item) => item.predictionId === "pred-after-close")
    expect(result.counts.questions).toBe(0)
    expect(result.counts.predictions).toBe(0)
    expect(oldValidations).toHaveLength(2)
    const oneDay = oldValidations.find((item) => item.windowDays === 1)
    const threeDay = oldValidations.find((item) => item.windowDays === 3)
    expect(oneDay.marketValidation.firstDate).toBe("2026-05-28")
    expect(oneDay.verdict).toBe("验证失败")
    expect(threeDay.marketValidation.firstDate).toBe("2026-05-28")
    expect(threeDay.marketValidation.lastDate).toBe("2026-06-01")
    expect(threeDay.verdict).toBe("验证通过")
    expect(threeDay.horizonTrackKey).toBe("pred-after-close:SH603629")
    expect(threeDay.priorWindowDays).toEqual([1])
    expect(threeDay.validationAnchor.rule).toBe("first_trading_day_after_prediction")
  })

  it("does not write longer horizon validations before enough post-prediction trading days exist", async () => {
    await write(
      path.join(tmpRoot, "data/brain/predictions.jsonl"),
      `${JSON.stringify({
        id: "pred-not-due",
        type: "prediction",
        kind: "daily-discovery",
        branch: "AI服务器电源",
        question: "利通电子看多，应该走强",
        expectedMove: "bullish",
        status: "pending",
        stocks: [{ name: "利通电子", code: "SH603629", branch: "AI服务器电源" }],
        validationWindows: [1, 3],
        createdAt: "2026-05-27 18:30:00",
      })}\n`,
    )

    const result = await runDailyLoop({
      projectPath: tmpRoot,
      mode: "postclose",
      validatePendingOnly: true,
      validationWindows: "1,3",
      stockDailyColumns: ["ticker", "date", "open", "high", "low", "close", "volume", "amount", "turnover", "pct_cng"],
      stockDailyExecutor: async ({ nativeQuery }) => ({
        rows: [{ ticker: "SH603629", date: "2026-05-28", open: 10, high: 11, low: 10, close: 11, volume: 100, amount: 1100, turnover: 2, pct_cng: 10 }].slice(0, nativeQuery.limit),
      }),
    })

    expect(result.validations.map((item) => item.windowDays)).toEqual([1])
    expect(result.validations[0].verdict).toBe("验证通过")
  })

  it("treats conflicting validation horizons as review evidence instead of independent downgrade votes", async () => {
    const validations = [
      {
        id: "v1d",
        type: "validation",
        kind: "market-validation",
        predictionId: "pred-1",
        stockCode: "SH603629",
        windowDays: 1,
        target: "AI服务器电源",
        result: "success",
        verdict: "验证通过",
        horizonTrackKey: "pred-1:SH603629",
        validationStartDate: "2026-05-28",
        validationEndDate: "2026-05-28",
        createdAt: "2026-05-28 16:00:00",
      },
      {
        id: "v3d",
        type: "validation",
        kind: "market-validation",
        predictionId: "pred-1",
        stockCode: "SH603629",
        windowDays: 3,
        target: "AI服务器电源",
        result: "failure",
        verdict: "验证失败",
        horizonTrackKey: "pred-1:SH603629",
        validationStartDate: "2026-05-28",
        validationEndDate: "2026-06-01",
        createdAt: "2026-06-01 16:00:00",
      },
    ]
    await write(path.join(tmpRoot, "data/brain/validations.jsonl"), `${validations.map((item) => JSON.stringify(item)).join("\n")}\n`)

    const result = await runSelfTraining({ projectPath: tmpRoot })
    expect(result.actions.map((action) => action.rule)).toContain("R4-cognitive-conflict")
    expect(result.actions.map((action) => action.rule)).not.toContain("R2-concept-downgrade")
    const conflict = result.actions.find((action) => action.rule === "R4-cognitive-conflict")
    expect(conflict.target).toBe("AI服务器电源")
    expect(conflict.affectedIds).toEqual(["v3d_horizon_conflict"])
  })
})

describe("codex ingest apply", () => {
  it("dry-run does not write wiki files", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const sourceHash = (await prepareIngest({ projectPath: tmpRoot, sourcePath: source, noReport: true })).sourceHash
    const indexPath = path.join(tmpRoot, "wiki/index.md")
    const before = await read(indexPath)
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/test-manifest/changes.json")

    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        sourcePath: source,
        sourceHash,
        writes: [
          {
            action: "update",
            path: "wiki/index.md",
            content: `${before}\n- [[概念/AI服务器电源涨价]] — 新增观察`,
          },
        ],
      }),
    )

    const report = await applyManifest({ manifestPath })
    expect(report.dryRun).toBe(true)
    expect(report.diffs[0].path).toBe("wiki/index.md")
    expect(await read(indexPath)).toBe(before)
  })

  it("dry-run previews temporal fact writes without appending jsonl", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-dry-run/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "HAS_ORDER",
            object: "mSAP电镀设备订单",
            claim: "三孚新科已有 mSAP 电镀设备订单事实待验证。",
            status: "active",
            validAt: "2026-05-28",
            sourcePath: "raw/研报新闻/2026-05-28-AI服务器电源.md",
            wikiPath: "wiki/股票/三孚新科.md",
          },
        ],
      }),
    )

    const report = await applyManifest({ manifestPath })
    expect(report.dryRun).toBe(true)
    expect(report.plannedFactWrites).toHaveLength(1)
    expect(report.plannedFactWrites[0]).toMatchObject({
      path: TEMPORAL_FACTS_RELATIVE_PATH,
      status: "active",
      subject: "三孚新科",
      predicate: "HAS_ORDER",
    })
    expect(report.factsWritten).toEqual([])
    await expect(fs.access(path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH))).rejects.toThrow()
  })

  it("write mode appends temporal facts to the dedicated jsonl file", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-write/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "HAS_ORDER",
            object: "mSAP电镀设备订单",
            claim: "三孚新科已有 mSAP 电镀设备订单事实待验证。",
            status: "active",
            validAt: "2026-05-28",
            sourcePath: "raw/研报新闻/2026-05-28-AI服务器电源.md",
            wikiPath: "wiki/股票/三孚新科.md",
          },
        ],
      }),
    )

    const report = await applyManifest({ manifestPath, write: true })
    const records = await readJsonl(path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH))
    expect(report.factsWritten).toEqual([report.plannedFactWrites[0].id])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: report.factsWritten[0],
      type: "temporal_fact",
      status: "active",
      entityKey: "stock:SH688359",
      canonicalSubject: "三孚新科",
      stockCode: "SH688359",
      subject: "三孚新科",
      predicate: "HAS_ORDER",
    })
    const index = JSON.parse(await read(path.join(tmpRoot, TEMPORAL_FACT_INDEX_RELATIVE_PATH)))
    expect(report.factIndex).toMatchObject({
      path: TEMPORAL_FACT_INDEX_RELATIVE_PATH,
      counts: { totalFacts: 1, activeFacts: 1, inactiveFacts: 0, entities: 1 },
    })
    expect(index.entities["stock:SH688359"].activeFactIds).toEqual([report.factsWritten[0]])
  })

  it("does not append duplicate temporal facts on rerun", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-rerun/changes.json")
    const manifest = {
      $schema: "codex-ingest-manifest-v1",
      projectPath: tmpRoot,
      writes: [],
      factWrites: [
        {
          path: TEMPORAL_FACTS_RELATIVE_PATH,
          subject: "三孚新科",
          predicate: "HAS_ORDER",
          object: "mSAP电镀设备订单",
          claim: "三孚新科已有 mSAP 电镀设备订单事实待验证。",
          status: "active",
          validAt: "2026-05-28",
          sourcePath: "raw/研报新闻/2026-05-28-AI服务器电源.md",
          wikiPath: "wiki/股票/三孚新科.md",
        },
      ],
    }
    await write(manifestPath, JSON.stringify(manifest))

    const first = await applyManifest({ manifestPath, write: true })
    const second = await applyManifest({ manifestPath, write: true })
    const records = await readJsonl(path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH))
    expect(first.factsWritten).toHaveLength(1)
    expect(second.factsWritten).toEqual([])
    expect(second.duplicateFacts).toHaveLength(1)
    expect(records).toHaveLength(1)
  })

  it("marks older temporal facts as superseded when a later source contradicts them", async () => {
    const firstManifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-contradiction-1/changes.json")
    await write(
      firstManifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "HAS_ORDER",
            object: "mSAP电镀设备订单",
            claim: "三孚新科 mSAP 电镀设备订单已经落地。",
            status: "active",
            validAt: "2026-05-28",
            sourcePath: "raw/研报新闻/2026-05-28-AI服务器电源.md",
          },
        ],
      }),
    )
    await applyManifest({ manifestPath: firstManifestPath, write: true })
    const [oldFact] = await readJsonl(path.join(tmpRoot, TEMPORAL_FACTS_RELATIVE_PATH))

    const secondManifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-contradiction-2/changes.json")
    await write(
      secondManifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "CONTRADICTS",
            object: "mSAP电镀设备订单",
            claim: "后续来源显示三孚新科 mSAP 电镀设备订单未被确认，旧订单结论需要撤下。",
            status: "active",
            validAt: "2026-05-29",
            sourcePath: "raw/研报新闻/2026-05-29-三孚新科澄清.md",
            supersedes: [oldFact.id],
          },
        ],
      }),
    )

    const dryRun = await applyManifest({ manifestPath: secondManifestPath })
    expect(dryRun.supersededFacts).toEqual([
      expect.objectContaining({ id: oldFact.id, found: true, line: 1 }),
    ])
    const writeReport = await applyManifest({ manifestPath: secondManifestPath, write: true })
    expect(writeReport.factsWritten).toHaveLength(1)

    const context = await buildAskRetrievalContext({
      projectPath: tmpRoot,
      query: "三孚新科 mSAP 电镀设备订单",
      sources: "facts",
      includeInvalidated: true,
    })
    expect(context.factsResults.map((item) => item.value.id)).toContain(writeReport.factsWritten[0])
    expect(context.factsResults.map((item) => item.value.id)).not.toContain(oldFact.id)
    const superseded = context.invalidatedFactsResults.find((item) => item.value.id === oldFact.id)
    expect(superseded).toMatchObject({ temporalStatus: "superseded" })
  })

  it("reports temporal fact validation warnings and rejects unknown predicates on write", async () => {
    const weakManifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-validation-warning/changes.json")
    await write(
      weakManifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "HAS_ORDER",
            object: "mSAP电镀设备订单",
            claim: "微信群传闻三孚新科有 mSAP 订单，仍待公告验证。",
            status: "active",
            evidenceLevel: "D",
            sourceKind: "social_chat",
            sourcePath: "raw/微信聊天/2026-05-28.md",
          },
        ],
      }),
    )
    const weakReport = await applyManifest({ manifestPath: weakManifestPath })
    expect(weakReport.fatalFactIssues).toEqual([])
    expect(weakReport.factValidation.map((issue) => issue.field)).toEqual(expect.arrayContaining(["validAt", "evidenceLevel", "sourceKind"]))

    const badManifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-validation-fatal/changes.json")
    await write(
      badManifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: TEMPORAL_FACTS_RELATIVE_PATH,
            subject: "三孚新科",
            predicate: "ORDER_STATUS",
            object: "mSAP电镀设备订单",
            claim: "未知 predicate 应被拒绝。",
            status: "active",
            validAt: "2026-05-28",
          },
        ],
      }),
    )
    const badDryRun = await applyManifest({ manifestPath: badManifestPath })
    expect(badDryRun.fatalFactIssues).toHaveLength(1)
    expect(badDryRun.fatalFactIssues[0]).toMatchObject({ field: "predicate" })
    await expect(applyManifest({ manifestPath: badManifestPath, write: true })).rejects.toThrow(/Unknown temporal fact predicate/)
  })

  it("refuses temporal fact writes outside the dedicated jsonl file", async () => {
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/facts-bad-path/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        writes: [],
        factWrites: [
          {
            path: "data/facts/cases.jsonl",
            subject: "三孚新科",
            predicate: "HAS_ORDER",
            object: "mSAP电镀设备订单",
            claim: "错误路径不应写入。",
          },
        ],
      }),
    )

    await expect(applyManifest({ manifestPath, write: true })).rejects.toThrow(/temporal_edges\.jsonl/)
  })

  it("write mode creates pages, appends log, and preserves raw source", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const rawBefore = await read(source)
    const prepared = await prepareIngest({ projectPath: tmpRoot, sourcePath: source, noReport: true })
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/write-manifest/changes.json")
    const newPage = `${validFrontmatter("AI服务器电源涨价")}
# AI服务器电源涨价

## 概念定义
AI 服务器电源涨价反映算力扩张下的供电瓶颈。

## 相关页面
- [[概念/算电协同]]
`

    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        sourcePath: source,
        sourceHash: prepared.sourceHash,
        writes: [
          { action: "create", path: "wiki/概念/AI服务器电源涨价.md", content: newPage },
          { action: "append", path: "wiki/logs/log-2026-05-28.md", content: "## [2026-05-28] ingest | AI服务器电源\n- 新增 [[概念/AI服务器电源涨价]]" },
        ],
      }),
    )

    const report = await applyManifest({ manifestPath, write: true })
    expect(report.written).toEqual(["wiki/概念/AI服务器电源涨价.md", "wiki/logs/log-2026-05-28.md"])
    expect(await read(source)).toBe(rawBefore)
    expect(await read(path.join(tmpRoot, "wiki/概念/AI服务器电源涨价.md"))).toContain("[[概念/算电协同]]")
    expect(await read(path.join(tmpRoot, "wiki/logs/log-2026-05-28.md"))).toContain("AI服务器电源")
  })

  it("create collision fails instead of writing a suffixed filename", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const prepared = await prepareIngest({ projectPath: tmpRoot, sourcePath: source, noReport: true })
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/collision/changes.json")
    const page = `${validFrontmatter("算电协同")}
# 算电协同

## 相关页面
- [[概念/算电协同]]
`

    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        sourcePath: source,
        sourceHash: prepared.sourceHash,
        writes: [
          { action: "create", path: "wiki/概念/算电协同.md", content: page },
          { action: "append", path: "wiki/logs/log-2026-05-28.md", content: "- 新增 [[概念/算电协同]]" },
        ],
      }),
    )

    await expect(applyManifest({ manifestPath, write: true })).rejects.toThrow(/Create target already exists/)
  })

  it("refuses writes to the legacy root log", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const prepared = await prepareIngest({ projectPath: tmpRoot, sourcePath: source, noReport: true })
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/legacy-log/changes.json")
    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        sourcePath: source,
        sourceHash: prepared.sourceHash,
        writes: [{ action: "append", path: "wiki/log.md", content: "- legacy" }],
      }),
    )

    await expect(applyManifest({ manifestPath, write: true })).rejects.toThrow(/legacy wiki\/log\.md/)
  })

  it("marks large housekeeping shrinkage fatal", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const prepared = await prepareIngest({ projectPath: tmpRoot, sourcePath: source, noReport: true })
    const manifestPath = path.join(tmpRoot, ".llm-wiki/codex-ingest/shrink/changes.json")
    await write(path.join(tmpRoot, "wiki/index.md"), `${validFrontmatter("index", "总结")}${Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")}`)
    await write(
      manifestPath,
      JSON.stringify({
        $schema: "codex-ingest-manifest-v1",
        projectPath: tmpRoot,
        sourcePath: source,
        sourceHash: prepared.sourceHash,
        writes: [{ action: "update", path: "wiki/index.md", content: `${validFrontmatter("index", "总结")}# tiny\n` }],
      }),
    )

    const report = await applyManifest({ manifestPath, write: false })
    expect(report.fatalIssues[0]).toMatchObject({ path: "wiki/index.md", field: "preserve_existing_content" })
    await expect(applyManifest({ manifestPath, write: true })).rejects.toThrow(/preserve_existing_content/)
  })
})

describe("codex ingest staged api-run", () => {
  it("builds a safe non-interactive Codex exec invocation", () => {
    const invocation = buildCodexExecInvocation({
      codexBin: "/Applications/Codex.app/Contents/Resources/codex",
      projectPath: tmpRoot,
      outputPath: path.join(tmpRoot, ".llm-wiki/out.md"),
      model: "gpt-5-codex",
      profile: "default",
    })

    expect(invocation.command).toBe("/Applications/Codex.app/Contents/Resources/codex")
    expect(invocation.args).toEqual([
      "-m",
      "gpt-5-codex",
      "-p",
      "default",
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--skip-git-repo-check",
      "-C",
      tmpRoot,
      "--output-last-message",
      path.join(tmpRoot, ".llm-wiki/out.md"),
      "-",
    ])
  })

  it("normalizes plan create/update entries based on real files", async () => {
    const plan = await normalizeIngestPlan(
      tmpRoot,
      {
        create: [{ path: "wiki/概念/算电协同.md", type: "概念", title: "算电协同", why: "已有页应更新" }],
        update: [{ path: "wiki/概念/新AIDC概念.md", why: "不存在页应新建" }],
      },
      "2026-05-28-AI服务器电源",
    )

    expect(plan.update.map((item) => item.path)).toContain("wiki/概念/算电协同.md")
    expect(plan.create.map((item) => item.path)).toContain("wiki/概念/新AIDC概念.md")
    expect(plan.create[0].path).toBe("wiki/sources/2026-05-28-AI服务器电源.md")
  })

  it("creates staged artifacts, manifest, source archive, updated page, and housekeeping dry-run", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const calls = []
    const page = (title, type = "概念", body = `# ${title}\n\n## 概念定义\n测试内容。`) => `${validFrontmatter(title, type)}${body}\n`

    const result = await apiRunIngest({
      projectPath: tmpRoot,
      sourcePath: source,
      reportId: "staged",
      requestText: async ({ stage, prompt }) => {
        calls.push(stage)
        if (stage === "analysis") {
          return [
            "# 2026-05-28 AI服务器电源核心结论",
            "",
            "## 建议更新已有页面",
            "- [[概念/算电协同]]",
            "",
            "## 建议新建页面",
            "- [[概念/新AIDC概念]]",
          ].join("\n")
        }
        if (stage === "plan") {
          return [
            "```json",
            JSON.stringify({
              create: [{ path: "wiki/概念/新AIDC概念.md", type: "概念", title: "新AIDC概念", why: "新概念" }],
              update: [{ path: "wiki/概念/算电协同.md", why: "追加 AI 服务器电源 evidence" }],
            }),
            "```",
          ].join("\n")
        }
        if (stage === "file" && prompt.includes("wiki/sources/2026-05-28-AI服务器电源.md")) {
          return `---FILE: wiki/sources/2026-05-28-AI服务器电源.md---\n${page("2026-05-28-AI服务器电源", "源文档", "# 2026-05-28 AI服务器电源源文档\n\n清洗后的证据归档。")}\n---END FILE---`
        }
        if (stage === "file" && prompt.includes("wiki/概念/算电协同.md")) {
          return `---FILE: wiki/概念/算电协同.md---\n${page("算电协同", "概念", "# 算电协同\n\nAI 服务器电源需求、数据中心供电和电力运营商重估共同构成观察框架。\n\n## 2026-05-28 新增验证\n本次 source 追加 AI 服务器电源 evidence。")}\n---END FILE---`
        }
        if (stage === "file" && prompt.includes("wiki/概念/新AIDC概念.md")) {
          return `---FILE: wiki/概念/新AIDC概念.md---\n${page("新AIDC概念", "概念", "# 新AIDC概念\n\n## 概念定义\nAIDC 新证据页。")}\n---END FILE---`
        }
        throw new Error(`unexpected stage ${stage}`)
      },
    })

    expect(calls).toEqual(["analysis", "plan", "file", "file", "file"])
    expect(await read(result.analysisPath)).toContain("核心结论")
    expect(JSON.parse(await read(result.planJsonPath)).create.map((item) => item.path)).toContain("wiki/概念/新AIDC概念.md")
    const manifest = JSON.parse(await read(result.manifestPath))
    const logPath = `wiki/logs/log-${result.createdAt.slice(0, 10)}.md`
    expect(manifest.writes.map((item) => item.path)).toEqual([
      "wiki/sources/2026-05-28-AI服务器电源.md",
      "wiki/概念/算电协同.md",
      "wiki/概念/新AIDC概念.md",
      "wiki/index.md",
      "wiki/overview.md",
      logPath,
    ])
    expect(result.dryRunReport.dryRun).toBe(true)
    await expect(fs.access(path.join(result.filesDir, "999-housekeeping.md"))).resolves.toBeUndefined()
    expect(await read(path.join(result.filesDir, "999-housekeeping.md"))).toContain(`---FILE: ${logPath}---`)
    expect(manifest.writes.find((item) => item.path === "wiki/index.md")?.content).toContain("[[概念/新AIDC概念]]")
    expect(manifest.writes.find((item) => item.path === "wiki/overview.md")?.content).toContain("## Recent Ingests")
    await expect(fs.access(path.join(tmpRoot, "wiki/概念/新AIDC概念.md"))).rejects.toThrow()
  })

  it("records soft plan-budget warnings without stopping broad ingests", async () => {
    const source = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const calls = []
    const pageFor = (filePath) => {
      const title = path.basename(filePath, ".md")
      const type = filePath.startsWith("wiki/sources/") ? "源文档" : "概念"
      return `---FILE: ${filePath}---\n${validFrontmatter(title, type)}# ${title}\n\n## 摄入记录\n这是用于测试预算提示的页面内容，证明宽计划不会被页数保护直接中止。\n---END FILE---`
    }

    const result = await apiRunIngest({
      projectPath: tmpRoot,
      sourcePath: source,
      reportId: "budget-stop",
      maxPlanItems: 2,
      requestText: async ({ stage, prompt }) => {
        calls.push(stage)
        if (stage === "analysis") return "# analysis\n\n建议更新多个页面。"
        if (stage === "plan") {
          return [
            "```json",
            JSON.stringify({
              create: [{ path: "wiki/概念/新AIDC概念.md", type: "概念", title: "新AIDC概念", why: "新建" }],
              update: [
                { path: "wiki/概念/算电协同.md", why: "更新" },
                { path: "wiki/概念/AI应用板块.md", why: "更新" },
              ],
            }),
            "```",
          ].join("\n")
        }
        const filePath = prompt.match(/---FILE:\s*(wiki\/[^\n]+?)---/)?.[1]
        if (stage === "file" && filePath) return pageFor(filePath)
        throw new Error(`unexpected stage ${stage}`)
      },
    })

    expect(calls).toEqual(["analysis", "plan", "file", "file", "file", "file"])
    expect(result.planBudget.warnings[0]).toContain("exceeds --max-plan-items 2")
    expect(JSON.parse(await read(result.planBudgetPath)).warnings.length).toBeGreaterThan(0)
    await expect(fs.access(path.join(tmpRoot, ".llm-wiki/codex-ingest/budget-stop/plan.json"))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpRoot, ".llm-wiki/codex-ingest/budget-stop/changes.json"))).resolves.toBeUndefined()
    await expect(fs.access(path.join(tmpRoot, ".llm-wiki/codex-ingest/budget-stop/files"))).resolves.toBeUndefined()
  })
})

describe("wiki hygiene", () => {
  it("audits and plans without changing raw or formal wiki pages", async () => {
    const rawPath = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const wikiPath = path.join(tmpRoot, "wiki/概念/算电协同.md")
    const rawBefore = await read(rawPath)
    const wikiBefore = await read(wikiPath)

    const oldReportDir = path.join(tmpRoot, ".llm-wiki/codex-ingest/old-success")
    await write(path.join(oldReportDir, "apply-report.json"), JSON.stringify({ dryRun: false, written: ["wiki/概念/X.md"] }))
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await fs.utimes(oldReportDir, oldDate, oldDate)

    const audit = await runHygiene({ projectPath: tmpRoot, action: "audit", keepDays: 14 })
    expect(audit.dryRun).toBe(true)
    expect(audit.audit.safety.rawWrites).toBe("never")

    const plan = await runHygiene({ projectPath: tmpRoot, action: "plan", keepDays: 14 })
    expect(plan.dryRun).toBe(true)
    expect(plan.plan.actions.map((item) => item.relativePath)).toContain(".llm-wiki/codex-ingest/old-success")

    const applyDryRun = await runHygiene({ projectPath: tmpRoot, action: "apply", keepDays: 14 })
    expect(applyDryRun.dryRun).toBe(true)
    await expect(fs.access(oldReportDir)).resolves.toBeUndefined()

    const applied = await runHygiene({ projectPath: tmpRoot, action: "apply", keepDays: 14, write: true })
    expect(applied.dryRun).toBe(false)
    expect(applied.applied.map((item) => item.relativePath)).toContain(".llm-wiki/codex-ingest/old-success")
    await expect(fs.access(oldReportDir)).rejects.toThrow()
    expect(await read(rawPath)).toBe(rawBefore)
    expect(await read(wikiPath)).toBe(wikiBefore)
  })
})

describe("company research", () => {
  function tushareResponse(fields, items) {
    return { code: 0, msg: null, data: { fields, items } }
  }

  it("writes a separate company research pack without leaking secrets or touching wiki/raw", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/洁美科技.md"),
      `${validFrontmatter("洁美科技", "股票", "code: SZ002859\nindustry: 电子元件\n")}# 洁美科技\n\nMLCC 离型膜和载带业务需要结合公告验证。\n`,
    )
    await write(
      path.join(tmpRoot, "wiki/概念/MLCC.md"),
      `${validFrontmatter("MLCC")}# MLCC\n\n被动元件上游材料和离型膜是潜在约束环节。\n`,
    )
    const wikiBefore = await read(path.join(tmpRoot, "wiki/股票/洁美科技.md"))
    const rawPath = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const rawBefore = await read(rawPath)
    const tushareCalls = []

    const result = await runCompanyResearch({
      projectPath: tmpRoot,
      stock: "002859",
      from: "2026-01-01",
      to: "2026-06-07",
      reportId: "company-research-test",
      tushareToken: "secret-tushare-token",
      tavilyApiKey: "secret-tavily-key",
      cninfoClient: async () => ({
        status: "success",
        requests: [{ key: "洁美科技", url: "https://www.cninfo.com.cn/mock" }],
        announcements: [
          {
            id: "ann-annual",
            secCode: "002859",
            secName: "洁美科技",
            title: "洁美科技：2025年年度报告",
            date: "2026-04-22",
            announcementTime: Date.parse("2026-04-22"),
            adjunctType: "PDF",
            downloadUrl: "https://static.cninfo.com.cn/finalpage/mock-annual.pdf",
            type: "annual_report",
          },
          {
            id: "ann-event",
            secCode: "002859",
            secName: "洁美科技",
            title: "洁美科技：重大资产收购预案",
            date: "2026-06-02",
            announcementTime: Date.parse("2026-06-02"),
            adjunctType: "PDF",
            downloadUrl: "https://static.cninfo.com.cn/finalpage/mock-event.pdf",
            type: "event",
          },
        ],
      }),
      cninfoDownloader: async ({ announcement }) => Buffer.from(`%PDF-1.4\n${announcement.id}\n%%EOF\n`),
      tushareClient: async ({ apiName, params }) => {
        tushareCalls.push({ apiName, params })
        if (apiName === "stock_basic") {
          return tushareResponse(["ts_code", "symbol", "name", "area", "industry", "market", "list_date"], [["002859.SZ", "002859", "洁美科技", "浙江", "电子元件", "主板", "20170407"]])
        }
        if (apiName === "income") {
          return tushareResponse(["ts_code", "end_date", "revenue", "n_income_attr_p"], [["002859.SZ", "20251231", 2101000000, 235000000]])
        }
        if (apiName === "balancesheet") {
          return tushareResponse(["ts_code", "end_date", "total_assets", "total_liab"], [["002859.SZ", "20251231", 7200000000, 2500000000]])
        }
        if (apiName === "cashflow") {
          return tushareResponse(["ts_code", "end_date", "n_cashflow_act"], [["002859.SZ", "20251231", 350000000]])
        }
        if (apiName === "fina_indicator") {
          return tushareResponse(["ts_code", "end_date", "grossprofit_margin", "netprofit_margin", "roe"], [["002859.SZ", "20251231", 32.5, 11.2, 6.8]])
        }
        if (apiName === "daily_basic") {
          return tushareResponse(["ts_code", "trade_date", "close", "pe_ttm", "pb", "total_mv", "circ_mv"], [["002859.SZ", "20260605", 80.4, 148, 6.2, 3470000, 3300000]])
        }
        return tushareResponse(["ts_code", "ann_date"], [])
      },
      tavilyClient: async ({ query }) => ({
        results: [
          { title: `${query} result`, url: "https://example.com/research", content: "MLCC 离型膜 技术能力 对比", score: 0.91 },
        ],
      }),
      stockDailyColumns: ["ticker", "date", "close", "amount", "pct_cng"],
      stockDailyExecutor: async () => ({
        rows: [
          { ticker: "002859.SZ", date: "2026-06-04", close: 78.5, amount: 100000000, pct_cng: 2.1 },
          { ticker: "002859.SZ", date: "2026-06-05", close: 80.4, amount: 130000000, pct_cng: 2.42 },
        ],
        rowCount: 2,
      }),
    })

    expect(result.outputDir).toBe(".llm-wiki/company-research/company-research-test")
    expect(result.writePolicy).toMatchObject({ wroteRaw: false, wroteFormalWiki: false })
    expect(result.providers.tushare).toMatchObject({ configured: true, status: "success" })
    expect(result.providers.tavily).toMatchObject({ configured: true, status: "success" })
    expect(result.providers.cninfo.downloads).toBe(2)
    expect(tushareCalls.find((call) => call.apiName === "income")?.params.start_date).toBe("20210101")

    const report = await read(path.join(tmpRoot, result.outputs.report))
    expect(report).toContain("数据拉取确认表")
    expect(report).toContain("洁美科技")
    expect(report).toContain("基础财务模型只使用 A/B 级证据")

    const ledger = JSON.parse(await read(path.join(tmpRoot, result.outputs.evidenceLedger)))
    expect(ledger.rows.map((row) => row.evidenceLevel)).toEqual(expect.arrayContaining(["A", "B", "C"]))
    expect(ledger.rows.some((row) => row.tool === "cninfo_pdf_download" && row.status === "success")).toBe(true)

    const modelJson = JSON.parse(await read(path.join(tmpRoot, result.outputs.modelJson)))
    expect(modelJson.sheets).toEqual(expect.arrayContaining(["Summary", "Assumptions", "Historical", "Forecast", "Segment Model", "Valuation", "Sensitivity", "Evidence"]))
    const xlsx = await import("xlsx")
    const workbook = xlsx.readFile(path.join(tmpRoot, result.outputs.modelXlsx), { cellFormula: true })
    expect(workbook.SheetNames).toEqual(expect.arrayContaining(["Summary", "Valuation", "Evidence"]))
    expect(workbook.Sheets.Valuation.B2.f).toBe("Forecast!C4*0.85")

    const textOutputs = [
      await read(path.join(tmpRoot, result.outputs.runSummary)),
      await read(path.join(tmpRoot, result.outputs.evidencePack)),
      await read(path.join(tmpRoot, result.outputs.report)),
      await read(path.join(tmpRoot, result.outputs.wikiCandidates)),
    ].join("\n")
    expect(textOutputs).not.toContain("secret-tushare-token")
    expect(textOutputs).not.toContain("secret-tavily-key")
    expect(await read(path.join(tmpRoot, "wiki/股票/洁美科技.md"))).toBe(wikiBefore)
    expect(await read(rawPath)).toBe(rawBefore)
  })

  it("adds deep company research artifacts with manual-needed guardrails", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/洁美科技.md"),
      `${validFrontmatter("洁美科技", "股票", "code: SZ002859\nindustry: 电子元件\n")}# 洁美科技\n\nMLCC 离型膜和载带业务需要结合公告验证。\n`,
    )
    const wikiBefore = await read(path.join(tmpRoot, "wiki/股票/洁美科技.md"))
    const rawPath = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const rawBefore = await read(rawPath)

    const result = await runCompanyResearch({
      projectPath: tmpRoot,
      stock: "002859",
      from: "2026-06-01",
      to: "2026-06-07",
      reportId: "company-research-deep-test",
      deep: true,
      cninfoDownloadLimit: 2,
      tushareToken: "secret-tushare-token",
      tavilyApiKey: "secret-tavily-key",
      cninfoClient: async () => ({
        status: "success",
        requests: [{ key: "洁美科技 年度报告", url: "https://www.cninfo.com.cn/mock" }],
        announcements: [
          {
            id: "ann-annual",
            secCode: "002859",
            secName: "洁美科技",
            title: "洁美科技：2025年年度报告",
            date: "2026-04-21",
            announcementTime: Date.parse("2026-04-21"),
            adjunctType: "PDF",
            downloadUrl: "https://static.cninfo.com.cn/finalpage/mock-annual.pdf",
            type: "annual_report",
          },
          {
            id: "ann-annual-old",
            secCode: "002859",
            secName: "洁美科技",
            title: "洁美科技：2024年年度报告",
            date: "2025-04-21",
            announcementTime: Date.parse("2025-04-21"),
            adjunctType: "PDF",
            downloadUrl: "https://static.cninfo.com.cn/finalpage/mock-annual-old.pdf",
            type: "annual_report",
          },
          {
            id: "ann-semi",
            secCode: "002859",
            secName: "洁美科技",
            title: "洁美科技：2025年半年度报告",
            date: "2025-08-12",
            announcementTime: Date.parse("2025-08-12"),
            adjunctType: "PDF",
            downloadUrl: "https://static.cninfo.com.cn/finalpage/mock-semi.pdf",
            type: "semiannual_report",
          },
        ],
      }),
      cninfoDownloader: async ({ announcement }) => Buffer.from(`%PDF-1.4\n${announcement.id}\n%%EOF\n`),
      tushareClient: async ({ apiName }) => {
        if (apiName === "stock_basic") {
          return tushareResponse(["ts_code", "symbol", "name", "area", "industry", "market", "list_date"], [["002859.SZ", "002859", "洁美科技", "浙江", "电子元件", "主板", "20170407"]])
        }
        if (apiName === "income") {
          return tushareResponse(["ts_code", "end_date", "revenue", "operate_profit", "n_income_attr_p", "rd_exp"], [["002859.SZ", "20260331", 507378438.43, 45664039.34, 47752907.14, 35053018.72]])
        }
        if (apiName === "balancesheet") {
          return tushareResponse(["ts_code", "end_date", "total_assets", "total_liab", "fix_assets", "cip", "inventories", "accounts_receiv", "total_share"], [["002859.SZ", "20260331", 7536877545.94, 4341361207.96, 2899226061.52, 1835995726.9, 640214752.18, 617971443.56, 431226531]])
        }
        if (apiName === "cashflow") {
          return tushareResponse(["ts_code", "end_date", "n_cashflow_act"], [["002859.SZ", "20260331", 25002545.7]])
        }
        if (apiName === "fina_indicator") {
          return tushareResponse(["ts_code", "end_date", "grossprofit_margin", "netprofit_margin", "roe"], [["002859.SZ", "20260331", 32.5851, 8.9547, 1.5156]])
        }
        if (apiName === "daily_basic") {
          return tushareResponse(["ts_code", "trade_date", "close", "pe_ttm", "pb", "total_mv", "circ_mv"], [["002859.SZ", "20260605", 86.56, 159.6216, 12.3474, 3732697.1726, 3513465.2497]])
        }
        return tushareResponse(["ts_code", "ann_date"], [])
      },
      tavilyClient: async ({ query }) => ({
        results: [
          { title: `${query} result`, url: "https://example.com/research", content: "MLCC 离型膜 技术能力 对比", score: 0.91 },
        ],
      }),
      stockDailyColumns: ["ticker", "date", "close", "amount", "pct_cng"],
      stockDailyExecutor: async () => ({
        rows: [
          { ticker: "002859.SZ", date: "2026-06-05", close: 86.56, amount: 130000000, pct_cng: 2.42 },
        ],
        rowCount: 1,
      }),
    })

    expect(result.deep.enabled).toBe(true)
    expect(result.deep.summary.noInventedFigures).toBe(true)
    expect(result.outputs.deepReport).toBe(".llm-wiki/company-research/company-research-deep-test/deep-company-report.md")

    const deepReport = await read(path.join(tmpRoot, result.outputs.deepReport))
    expect(deepReport).toContain("自动重建说明")
    expect(deepReport).toContain("一、业务地图")
    expect(deepReport).toContain("ASP 独立推算")
    expect(deepReport).toContain("子公司盈亏核实")
    expect(deepReport).toContain("三、产能规划与折旧压力")
    expect(deepReport).toContain("五、载带业务")
    expect(deepReport).toContain("六、重大事项/收购期权价值")
    expect(deepReport).toContain("七、三年财务模型（三情景）")
    expect(deepReport).toContain("九、PE/市值敏感性矩阵")
    expect(deepReport).toContain("十一、退出信号体系")
    expect(deepReport).toContain("十二、验证清单")
    expect(deepReport).toContain("manual_needed")

    const documentExtract = JSON.parse(await read(path.join(tmpRoot, result.outputs.documentExtract)))
    expect(documentExtract.summary.manualNeeded).toBe(2)
    expect(documentExtract.documents.map((doc) => doc.title)).toEqual(expect.arrayContaining(["洁美科技：2025年年度报告", "洁美科技：2025年半年度报告"]))
    expect(documentExtract.documents.map((doc) => doc.title)).not.toContain("洁美科技：2024年年度报告")
    const businessBreakdown = JSON.parse(await read(path.join(tmpRoot, result.outputs.businessBreakdown)))
    expect(businessBreakdown.productLines[0].status).toBe("manual_needed")
    expect(businessBreakdown.capex[0].amount).toBe(1835995726.9)
    const qualityAudit = JSON.parse(await read(path.join(tmpRoot, result.outputs.deepQualityAudit)))
    expect(qualityAudit.targetScore).toBe(0.9)
    expect(Array.isArray(qualityAudit.requirements)).toBe(true)
    const financialTemplate = JSON.parse(await read(path.join(tmpRoot, result.outputs.financialModelV2Template)))
    expect(financialTemplate.frameworkKind).toBe("electronic-materials")
    expect(financialTemplate.workbookArchitecture).toEqual(expect.arrayContaining(["Driver Assumptions", "Segment Drivers", "Checks", "Manual Inputs"]))
    expect(financialTemplate.sourceMap.some((row) => row.status === "provider_needed")).toBe(true)
    const financialModelJson = JSON.parse(await read(path.join(tmpRoot, result.outputs.financialModelV2Json)))
    expect(financialModelJson.schema).toBe("company-financial-model-v2")
    expect(financialModelJson.sheets).toEqual(expect.arrayContaining(["Financial Framework", "Historical IS", "Historical BS", "Historical CF", "Segment Drivers", "Working Capital", "Capex D&A", "Forecast", "Valuation v2", "Checks", "Manual Inputs"]))

    const xlsx = await import("xlsx")
    const workbook = xlsx.readFile(path.join(tmpRoot, result.outputs.deepModelXlsx), { cellFormula: true })
    expect(workbook.SheetNames).toEqual(expect.arrayContaining(["Product Lines", "Forecast", "Valuation", "Sensitivity", "Scenario Model", "Corporate Actions", "Valuation Matrix", "Exit Signals", "Validation Checklist", "Evidence"]))
    expect(workbook.Sheets.Valuation.B2.f).toBe("Forecast!C4*0.85")
    const financialWorkbook = xlsx.readFile(path.join(tmpRoot, result.outputs.financialModelV2Xlsx), { cellFormula: true })
    expect(financialWorkbook.SheetNames).toEqual(expect.arrayContaining(["Cover", "Financial Framework", "Driver Assumptions", "Segment Drivers", "Forecast", "Valuation v2", "Checks"]))
    expect(financialWorkbook.Sheets.Forecast.C2.f).toContain("SUM('Segment Drivers'")
    expect(financialWorkbook.Sheets["Valuation v2"].D8.f).toBe('IF(D7>0,D6/D7,"")')
    expect(financialWorkbook.Sheets.Checks.F2.f).toContain("COUNTIF")

    const textOutputs = [
      await read(path.join(tmpRoot, result.outputs.runSummary)),
      await read(path.join(tmpRoot, result.outputs.deepReport)),
      await read(path.join(tmpRoot, result.outputs.documentExtract)),
      await read(path.join(tmpRoot, result.outputs.businessBreakdown)),
      await read(path.join(tmpRoot, result.outputs.financialModelV2Json)),
      await read(path.join(tmpRoot, result.outputs.financialModelV2Template)),
    ].join("\n")
    expect(textOutputs).not.toContain("secret-tushare-token")
    expect(textOutputs).not.toContain("secret-tavily-key")
    expect(await read(path.join(tmpRoot, "wiki/股票/洁美科技.md"))).toBe(wikiBefore)
    expect(await read(rawPath)).toBe(rawBefore)
  })

  it("uses semiconductor driver pack for memory-chip companies instead of the JieMei material template", async () => {
    await write(
      path.join(tmpRoot, "wiki/股票/兆易创新.md"),
      `${validFrontmatter("兆易创新", "股票", "code: SH603986\nindustry: 半导体\n")}# 兆易创新\n\n存储芯片、MCU 和传感器业务需要结合公告和周期数据验证。\n`,
    )
    const wikiBefore = await read(path.join(tmpRoot, "wiki/股票/兆易创新.md"))
    const rawPath = path.join(tmpRoot, "raw/研报新闻/2026-05-28-AI服务器电源.md")
    const rawBefore = await read(rawPath)

    const result = await runCompanyResearch({
      projectPath: tmpRoot,
      stock: "603986",
      from: "2026-06-01",
      to: "2026-06-07",
      reportId: "company-research-deep-semiconductor-test",
      deep: true,
      tushareToken: "secret-tushare-token",
      tavilyApiKey: "secret-tavily-key",
      cninfoClient: async () => ({
        status: "success",
        requests: [{ key: "兆易创新 年度报告", url: "https://www.cninfo.com.cn/mock" }],
        announcements: [],
      }),
      tushareClient: async ({ apiName }) => {
        if (apiName === "stock_basic") {
          return tushareResponse(["ts_code", "symbol", "name", "area", "industry", "market", "list_date"], [["603986.SH", "603986", "兆易创新", "北京", "半导体", "主板", "20160818"]])
        }
        if (apiName === "income") {
          return tushareResponse(["ts_code", "end_date", "revenue", "operate_profit", "n_income_attr_p", "rd_exp"], [["603986.SH", "20260331", 1600000000, 260000000, 210000000, 310000000]])
        }
        if (apiName === "balancesheet") {
          return tushareResponse(["ts_code", "end_date", "total_assets", "total_liab", "fix_assets", "cip", "inventories", "accounts_receiv", "total_share"], [["603986.SH", "20260331", 22000000000, 4600000000, 1900000000, 350000000, 2800000000, 1200000000, 667000000]])
        }
        if (apiName === "cashflow") {
          return tushareResponse(["ts_code", "end_date", "n_cashflow_act", "c_pay_acq_const_fiolta"], [["603986.SH", "20260331", 320000000, 180000000]])
        }
        if (apiName === "fina_indicator") {
          return tushareResponse(["ts_code", "end_date", "grossprofit_margin", "netprofit_margin", "roe"], [["603986.SH", "20260331", 38.5, 13.1, 2.3]])
        }
        if (apiName === "daily_basic") {
          return tushareResponse(["ts_code", "trade_date", "close", "pe_ttm", "pb", "total_mv", "circ_mv"], [["603986.SH", "20260605", 126.8, 62.5, 5.8, 8450000, 8420000]])
        }
        return tushareResponse(["ts_code", "ann_date"], [])
      },
      tavilyClient: async ({ query }) => ({
        results: [
          { title: `${query} result`, url: "https://example.com/memory-cycle", content: "NOR Flash DRAM MCU 库存 周期", score: 0.89 },
        ],
      }),
      stockDailyColumns: ["ticker", "date", "close", "amount", "pct_cng"],
      stockDailyExecutor: async () => ({ rows: [], rowCount: 0 }),
    })

    expect(result.deep.summary.financialModelKind).toBe("semiconductor-memory")
    const template = JSON.parse(await read(path.join(tmpRoot, result.outputs.financialModelV2Template)))
    expect(template.frameworkName).toContain("半导体")
    expect(template.operatingDrivers).toEqual(expect.arrayContaining(["存储价格指数", "库存周转"]))
    expect(JSON.stringify(template)).toContain("DRAM/NOR Flash 价格指数")
    expect(JSON.stringify(template)).not.toContain("离型膜")

    const xlsx = await import("xlsx")
    const financialWorkbook = xlsx.readFile(path.join(tmpRoot, result.outputs.financialModelV2Xlsx), { cellFormula: true })
    expect(financialWorkbook.Sheets["Segment Drivers"].A2.v).toContain("存储芯片")
    expect(financialWorkbook.Sheets["Segment Drivers"].A3.v).toContain("微控制器")
    expect(financialWorkbook.Sheets.Forecast.C2.f).toContain("'Segment Drivers'")
    expect(await read(path.join(tmpRoot, "wiki/股票/兆易创新.md"))).toBe(wikiBefore)
    expect(await read(rawPath)).toBe(rawBefore)
  })
})

describe("wiki body soft line limit", () => {
  function contentWithBodyLines(lineCount) {
    const body = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n")
    return `${validFrontmatter("长页面")}\n${body}\n`
  }

  it("allows 1999 and 2000 body lines without a line-limit warning", () => {
    expect(validateWikiContent("wiki/概念/长页面.md", contentWithBodyLines(PAGE_BODY_LINE_SOFT_LIMIT - 1))).not.toContainEqual(
      expect.objectContaining({ field: "body_lines" }),
    )
    expect(validateWikiContent("wiki/概念/长页面.md", contentWithBodyLines(PAGE_BODY_LINE_SOFT_LIMIT))).not.toContainEqual(
      expect.objectContaining({ field: "body_lines" }),
    )
  })

  it("warns but does not fail above 2000 body lines", () => {
    const issues = validateWikiContent("wiki/概念/长页面.md", contentWithBodyLines(PAGE_BODY_LINE_SOFT_LIMIT + 1))
    expect(issues).toContainEqual(
      expect.objectContaining({
        field: "body_lines",
        fatal: false,
      }),
    )
  })

  it("accepts Hong Kong stock codes", () => {
    const content = `${validFrontmatter("港股样本", "股票", "code: HK09992\nindustry: 潮玩\n")}\n# 港股样本\n`
    expect(validateWikiContent("wiki/股票/港股样本.md", content).filter((issue) => issue.fatal)).toEqual([])
  })

  it("accepts US stock tickers", () => {
    const content = `${validFrontmatter("美股样本", "股票", "code: AAPL\nindustry: 消费电子\n")}\n# 美股样本\n`
    expect(validateWikiContent("wiki/股票/美股样本.md", content).filter((issue) => issue.fatal)).toEqual([])
  })
})

describe("ingest JSON and timestamp normalization", () => {
  it("parseModelJson tolerates literal control characters inside JSON strings", () => {
    const parsed = parseModelJson(String.raw`{"create":[{"path":"wiki/概念/x.md","why":"line1
line2"}],"update":[],"factWrites":[]}`)
    expect(parsed.create[0].why).toContain("line1")
    expect(parsed.create[0].why).toContain("line2")
  })

  it("normalizeWikiTimestamp coerces ISO and YAML Date values", () => {
    expect(normalizeWikiTimestamp("2026-06-15T14:23:07")).toBe("2026-06-15 14:23:07")
    expect(normalizeWikiTimestamp("2026-06-15")).toBe("2026-06-15 00:00:00")
    expect(normalizeWikiTimestamp(new Date("2026-06-15T06:23:07Z"))).toMatch(/^2026-06-15 \d{2}:\d{2}:\d{2}$/)
  })

  it("validateFrontmatter accepts YAML-parsed Date timestamps after normalization", () => {
    const issues = validateFrontmatter({
      schema_version: 1,
      title: "测试页",
      type: "概念",
      summary: "这是一个用于测试 frontmatter 时间戳自动规范化的概念页摘要，长度需要满足 schema 对 summary 字段的最小字符要求。",
      tags: [],
      related: [],
      sources: [],
      created: new Date("2026-06-15T10:00:00"),
      updated: "2026-06-15T14:23:07",
      last_reviewed: "2026-06-15",
      confidence: "中",
      status: "活跃",
    }, "wiki/概念/测试页.md")
    expect(issues.filter((issue) => issue.fatal)).toEqual([])
  })

  it("sanitizeTextControlCharacters removes ASCII control bytes from source text", () => {
    expect(sanitizeTextControlCharacters("a\u0001b\nc")).toBe("ab\nc")
  })

  it("coerceWikiPageFrontmatter fills missing schema fields from path and body", () => {
    const coerced = coerceWikiPageFrontmatter({}, "wiki/模式/消费冷启动模式.md", "# 消费冷启动模式\n\n首段摘要内容。")
    expect(coerced.schema_version).toBe(1)
    expect(coerced.title).toBe("消费冷启动模式")
    expect(coerced.type).toBe("模式")
    expect(coerced.confidence).toBe("中")
    expect(coerced.status).toBe("活跃")
    expect(coerced.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect([...coerced.summary].length).toBeGreaterThanOrEqual(50)
  })

  it("applyManifest --skip-invalid writes valid pages and skips invalid stock pages", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ingest-skip-"))
    const manifestPath = path.join(tmpRoot, "changes.json")
    await fs.mkdir(path.join(tmpRoot, "wiki/模式"), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify({
      projectPath: tmpRoot,
      writes: [
        {
          action: "create",
          path: "wiki/模式/消费冷启动模式.md",
          content: "# 消费冷启动模式\n\n这是一个模式页。",
        },
        {
          action: "create",
          path: "wiki/股票/金钼股份.md",
          content: `---
schema_version: 1
title: 金钼股份
type: 股票
summary: 这是一个仍然缺少合法 code 字段的股票页摘要，用于测试 skip-invalid 行为，长度需要超过 schema 最小限制。
tags: []
related: []
sources: []
created: 2026-04-15
updated: 2026-04-15
last_reviewed: 2026-04-15
confidence: 中
status: 活跃
---

# 金钼股份
`,
        },
      ],
    }, null, 2), "utf8")

    const result = await applyManifest({
      manifestPath,
      projectPath: tmpRoot,
      write: true,
      skipInvalid: true,
    })

    expect(result.written).toContain("wiki/模式/消费冷启动模式.md")
    expect(result.written).not.toContain("wiki/股票/金钼股份.md")
    expect(result.skipped.some((item) => item.path === "wiki/股票/金钼股份.md")).toBe(true)
  })

  it("normalizeWikiPageContent rewrites frontmatter timestamps to schema format", () => {
    const normalized = normalizeWikiPageContent(`---
schema_version: 1
title: 测试页
type: 概念
summary: 这是一个用于测试 frontmatter 时间戳自动规范化的概念页摘要，长度需要满足 schema 对 summary 字段的最小字符要求。
tags: []
related: []
sources: []
created: 2026-06-15T10:00:00
updated: 2026-06-15T14:23:07
last_reviewed: 2026-06-15
confidence: 中
status: 活跃
---

# 测试页
`, { now: "2026-06-15 14:23:07", relativePath: "wiki/概念/测试页.md" })
    expect(normalized).toContain("created: 2026-06-15 10:00:00")
    expect(normalized).toContain("updated: 2026-06-15 14:23:07")
    expect(normalized).toContain("last_reviewed: 2026-06-15 00:00:00")
  })
})

describe("OpenAI provider routing", () => {
  it("auto-selects chat mode for DeepSeek endpoints", () => {
    expect(resolveOpenAiApiMode({ endpoint: "https://api.deepseek.com" })).toBe("chat")
    expect(resolveOpenAiApiMode({ endpoint: "https://api.deepseek.com/v1" })).toBe("chat")
  })

  it("auto-selects responses mode for OpenAI official endpoint", () => {
    expect(resolveOpenAiApiMode({ endpoint: "https://api.openai.com" })).toBe("responses")
  })

  it("honors explicit api mode override", () => {
    expect(resolveOpenAiApiMode({ endpoint: "https://api.openai.com", apiMode: "chat" })).toBe("chat")
    expect(resolveOpenAiApiMode({ endpoint: "https://api.deepseek.com", apiMode: "responses" })).toBe("responses")
  })

  it("normalizes endpoint bases and builds chat/responses URLs", () => {
    expect(normalizeOpenAiEndpointBase("https://api.deepseek.com/v1/chat/completions")).toBe("https://api.deepseek.com")
    expect(buildOpenAiChatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/chat/completions")
    expect(buildOpenAiResponsesUrl("https://api.openai.com")).toBe("https://api.openai.com/v1/responses")
  })

  it("builds DeepSeek chat body with thinking for v4-pro", () => {
    const body = buildChatCompletionsBody({
      model: "deepseek-v4-pro",
      prompt: "hello",
      instructions: "system",
      reasoningEffort: "high",
      endpoint: "https://api.deepseek.com",
    })
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ])
    expect(body.reasoning_effort).toBe("high")
    expect(body.thinking).toEqual({ type: "enabled" })
  })

  it("prefers DEEPSEEK_API_KEY when endpoint is DeepSeek", () => {
    const prevOpenAi = process.env.OPENAI_API_KEY
    const prevDeepSeek = process.env.DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY
    process.env.DEEPSEEK_API_KEY = "ds-test-key"
    try {
      expect(resolveOpenAiApiKey({ endpoint: "https://api.deepseek.com" })).toBe("ds-test-key")
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevOpenAi
      if (prevDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = prevDeepSeek
    }
  })

  it("requestOpenAiProviderText uses chat completions for DeepSeek", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.deepseek.com/chat/completions")
      const body = JSON.parse(String(init.body))
      expect(body.model).toBe("deepseek-v4-flash")
      expect(body.messages[1].content).toBe("ping")
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    try {
      const text = await requestOpenAiProviderText({
        apiKey: "ds-test",
        endpoint: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        prompt: "ping",
        instructions: "test",
      })
      expect(text).toBe("pong")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("FILE block parser", () => {
  it("parses lenient FILE blocks for API fallback", () => {
    const blocks = parseFileBlocks("----FILE: **wiki/概念/X.md**----\nbody\n----END FILE----")
    expect(blocks).toEqual([{ path: "wiki/概念/X.md", content: "body" }])
  })

  it("parses fenced FILE blocks returned by Codex exec", () => {
    const blocks = parseFileBlocks("````FILE wiki/logs/log-2026-05-30.md\n## log\n```yaml\nx: y\n```\n````")
    expect(blocks).toEqual([{ path: "wiki/logs/log-2026-05-30.md", content: "## log\n```yaml\nx: y\n```" }])
  })
})
