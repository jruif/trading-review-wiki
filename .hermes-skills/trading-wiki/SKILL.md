---
name: trading-wiki
description: 查询与写入 Trading Review Wiki 交易复盘知识库（多源 RAG、资料摄入、时序事实、brain 记忆、盘前盘后自动化）
version: 1.1.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [trading, wiki, rag, ingest, deepseek, 交易复盘, 知识库]
    category: research
    requires_toolsets: [terminal]
required_environment_variables:
  - name: TRADING_WIKI_PROJECT
    prompt: "Wiki 工作区绝对路径（含 wiki/ 与 raw/ 的目录）"
    required_for: "所有知识库命令；直接运行 npm run codex:ingest 时亦必填（或通过 --project 传入）"
  - name: DEEPSEEK_API_KEY
    prompt: "DeepSeek API Key（platform.deepseek.com）"
    required_for: "LLM 问答与摄入（也可改用 OPENAI_API_KEY）"
  - name: OPENAI_API_BASE
    default: "https://api.deepseek.com"
    required_for: "DeepSeek Chat Completions 端点"
  - name: OPENAI_MODEL
    default: "deepseek-v4-flash"
    required_for: "LLM 模型名"
---

# Trading Review Wiki

通过本仓库 CLI（`codex:ingest`）操作本地交易复盘知识库：**只读问答**、**资料 staging 入库**、**Temporal Facts v1**、**brain 纠错闭环**、**盘前/盘后自动化**。

## 安装到 Hermes

在 shell profile 或 `~/.hermes/config.yaml` 对应环境中加入：

```bash
export HERMES_OPTIONAL_SKILLS_DIR="/Users/jruif/agent-work/trading-review-wiki/.hermes-skills"
```

安装或更新 skill：

```bash
cd /Users/jruif/agent-work/trading-review-wiki
npm run skill:install:hermes
```

重启 Hermes 后：

```text
/skills search trading-wiki
/skills inspect trading-wiki
```

## 环境变量

Hermes 子进程必须 **inherit** 下列变量，不要清空。

### 必填

| 变量 | 用途 |
|---|---|
| `TRADING_WIKI_PROJECT` | Wiki 工作区根（含 `wiki/`、`raw/`）。CLI 无内置默认路径 |

### LLM

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | — | API 凭据 |
| `OPENAI_API_BASE` | `https://api.deepseek.com` | Chat Completions 端点 |
| `OPENAI_MODEL` | `deepseek-v4-flash` | 模型名 |
| `OPENAI_API_MODE` | `auto` | `auto` / `chat` / `responses` |
| `TRADING_WIKI_PROVIDER` | `openai` | `openai` 或 `codex` |
| `TRADING_WIKI_REASONING_EFFORT` | `low` | ingest 建议 `low`，避免超时 |
| `TRADING_WIKI_PAGE_CONCURRENCY` | `3` | ingest 并行生成页数 |

### 可选

| 变量 | 用途 |
|---|---|
| `TRADING_WIKI_REPO` | CLI 仓库路径；`skill:install` 写入 `scripts/env.sh` |
| `PG_SHIHAO_*` / `PG_SHIHAO_CONFIG_PATH` | stock-price 问答、gangtise 导出（见仓库 `scripts/init-cn-stock-db.sh`） |

最小示例：

```bash
export TRADING_WIKI_PROJECT="/path/to/your-wiki-project"
export DEEPSEEK_API_KEY="sk-..."
export OPENAI_API_BASE="https://api.deepseek.com"
export OPENAI_MODEL="deepseek-v4-flash"
```

## 统一入口

```bash
${HERMES_SKILL_DIR}/scripts/tw-cli.sh <command> [args...]
```

## 何时使用

| 用户意图 | 命令 |
|---|---|
| 可读答案 | `tw-cli.sh ask "<问题>"` |
| JSON 证据（推荐机器解析） | `tw-cli.sh ask-json "<问题>" [--sources ...]` |
| 完整检索上下文 | `tw-cli.sh ask-context "<问题>"` |
| 含历史反证 | `ask-json` + `--include-invalidated` |
| 检索质量回归 | `tw-cli.sh raw ask eval --query "..." --expect-paths ...` |
| 预扫描源文件 | `tw-cli.sh raw prepare --source /path/to/file.md` |
| LLM staging（api-run） | `tw-cli.sh ingest /path/to/raw/file.md` |
| 续跑 housekeeping | `tw-cli.sh finalize <run-id>` |
| 写入 wiki | `tw-cli.sh apply <changes.json> --write` |
| 跳过非法页写入 | `tw-cli.sh apply ... --write --skip-invalid` |
| brain 记录纠错 | `tw-cli.sh brain-remember correction "<文本>"` |
| brain 状态 | `tw-cli.sh brain-status` |
| brain 验证关闭 | `tw-cli.sh raw brain resolve --id <id> --result success` |
| 盘前/盘后 | `tw-cli.sh daily-loop premarket\|postclose --write` |
| 公司研究 | `tw-cli.sh company-research "600519" --deep` |
| 行情验证 dry-run | `tw-cli.sh raw market-validate --prediction "..." --stock "..."` |
| Temporal Facts 审计 | `tw-cli.sh temporal-facts-audit --write` |
| hygiene 清理旧 report | `hygiene-audit` → `hygiene-plan` → `hygiene-apply --write` |
| 透传 codex:ingest | `tw-cli.sh raw <subcommand> [args...]` |

个股调研自动入库见 `references/stock-research-auto-save.md`。

## 硬性边界

### Directory Boundaries

| 路径 | 角色 | 写入规则 |
|---|---|---|
| `raw/**` | 原始资料，**不可变** | CLI **永不改写**；新资料放 `raw/` 后由 ingest **只读** |
| `wiki/**` | 正式知识页 | 仅 `apply --write` |
| `data/facts/**` | Temporal Facts v1 | manifest `factWrites` → `temporal_edges.jsonl` |
| `data/brain/**` | 纠错/验证记忆 | `brain remember/resolve`、`daily-loop --write` |
| `.llm-wiki/**` | staging/report/eval | CLI 创建；`hygiene` 可清理旧 report |
| `wiki/sources/` | **终极降级** | 仅 ingest→apply 反复失败时直写；可被 RAG 检索但无编译 |

### 核心规则

1. **`ask*` 只读**，不改 `wiki/**`、`raw/**`。
2. **禁止**用 `echo`/`sed`/`write_file` 直接改 `wiki/**`、`raw/**`。
3. 正式 wiki 写入 **只能** `apply --write`。
4. `apply --write` 前必须读 `wiki-change-review.md` 并 **征得用户确认**。
5. 新资料：`raw/` → `prepare`（可选）→ `ingest`（api-run）→ `finalize`（可选）→ `apply`。
6. SQL 凭据只从本机 env / `PG_SHIHAO_CONFIG_PATH` 读取，密码不打印、不落盘。

## 标准工作流

### A. 问答（带证据）

```bash
CLI="bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh"
${CLI} ask-json "<问题>" --sources wiki,raw,graph,facts
${CLI} ask "<问题>"
```

关注 `sourceRouting.selectedSources`、`counts`、`retrievalWarnings`。证据不足时 **不要编造**。

### B. 资料入库（prepare → api-run → finalize → apply）

```bash
CLI="bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh"
PROJECT="${TRADING_WIKI_PROJECT}"
SOURCE="${PROJECT}/raw/每日复盘/2026-06-17-复盘.md"

# 0. 源文件必须在 raw/（手动 cp，CLI 不改写 raw）

# 1. 预扫描（可选）
${CLI} raw prepare --source "${SOURCE}" --project "${PROJECT}"

# 2. staging（api-run，dry-run）
${CLI} ingest "${SOURCE}"

# 3. housekeeping 失败时续跑
${CLI} finalize "${PROJECT}/.llm-wiki/codex-ingest/<run-id>"
```

产物目录 `.llm-wiki/codex-ingest/<run-id>/`：

| 文件 | 用途 |
|---|---|
| `changes.json` | manifest（writes + factWrites） |
| `wiki-change-review.md` | **给用户审阅** |
| `dry-run-apply.md` | dry-run 报告 |
| `plan-budget.json` | 计划规模软告警 |

```bash
# 4. 用户确认后写入
${CLI} apply /path/to/changes.json --write
${CLI} apply /path/to/changes.json --write --skip-invalid   # 跳过 schema 非法页
```

**apply 前检查：** `fatalIssues == 0`（或已 `--skip-invalid`）、未写 raw、source hash 稳定、`wiki-change-review.md` 已审阅。

### C. brain 闭环

```bash
CLI="bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh"
${CLI} brain-remember correction "高开接盘必须先看承接"
${CLI} brain-status
${CLI} raw brain resolve --id <brain-id> --result success --note "后续验证有效"
```

类型：`correction` | `thread` | `preference` | `guardrail`。

### D. Temporal Facts v1

```bash
CLI="bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh"
${CLI} temporal-facts-audit --write
${CLI} ask-json "某产业链仍有效的订单信号" --sources wiki,raw,graph,facts
${CLI} ask-json "哪些旧订单被证伪？" --sources wiki,raw,graph,facts --include-invalidated
```

- `apply --write` 写 `factWrites` → `data/facts/temporal_edges.jsonl`
- 默认 ask 只看 active facts；`--include-invalidated` 看 superseded/invalidated
- deterministic fact id，重复 apply 不重复追加

## 常见 `--sources`

| 组合 | 场景 |
|---|---|
| `wiki,raw,graph` | 叙事 + 图谱 |
| `wiki,raw,graph,facts` | + 时序事实 |
| `wiki,raw,graph,stock-price` | + 量价 |
| `wiki,raw,graph,facts,brain` | + brain 记忆 |

## 失败处理

| 现象 | 处理 |
|---|---|
| `Missing wiki project path` | 设 `TRADING_WIKI_PROJECT` |
| ingest 超时 / 无输出 | `TRADING_WIKI_REASONING_EFFORT=low`、`PAGE_CONCURRENCY=3`；源从 `raw/` 摄入 |
| `Missing OpenAI-compatible API key` | 设 `DEEPSEEK_API_KEY` |
| `No assistant text found` | 重试；拆小文件 |
| `Fatal schema validation failed` | `--skip-invalid`；股票页补 `code` |
| ingest→apply 反复失败 | 见 `references/cli-known-issues.md` |

## 回答格式

保留 CLI 六段（若存在）：结论 → 证据链 → 分歧/反证 → 后续验证 → 交易含义 → 引用来源。

## 进阶

```bash
bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh raw ask eval --query "..." --expect-paths wiki/概念/x.md
```

完整 CLI 见仓库 `docs/CLI外部接入与使用指南.md`。
