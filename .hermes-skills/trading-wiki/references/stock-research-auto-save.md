# 个股/题材调研自动入库流程

完成个股或题材调研后，优先走 **raw/ → ingest → apply**；仅在流水线反复失败时，才降级写入 `wiki/sources/`。

## 推荐路径（标准流水线）

```bash
CLI="bash ${HERMES_SKILL_DIR}/scripts/tw-cli.sh"
PROJECT="${TRADING_WIKI_PROJECT}"
SOURCE="${PROJECT}/raw/研报新闻/逸豪新材-301176-个股调研.md"

# 1. 调研 Markdown 先落 raw/（CLI 不改写 raw）
# 2. staging
${CLI} ingest "${SOURCE}"
# 3. 用户确认 changes.json / wiki-change-review.md 后
${CLI} apply /path/to/changes.json --write
```

## 命名规范

- 个股：`股票名-代码-个股调研.md`（如 `逸豪新材-301176-个股调研.md`）
- 题材：`题材名-题材调研.md`（如 `电子材料产业链-题材调研.md`）

## Frontmatter 模板

### 个股

```yaml
---
schema_version: 1
title: 股票名(代码)个股调研
type: 股票
code: SZ301176
summary: 一句话核心结论（50-160 字）
created: 2026-06-17 00:00:00
updated: 2026-06-17 00:00:00
confidence: 高
status: 活跃
tags: [个股调研, 方向标签, 板块标签]
related:
  - "[[股票/股票名]]"
---
```

### 题材

```yaml
---
schema_version: 1
title: 题材名调研
type: 概念
summary: 一句话核心结论（50-160 字）
created: 2026-06-17 00:00:00
updated: 2026-06-17 00:00:00
confidence: 高
status: 活跃
tags: [题材调研, 方向标签]
related:
  - "[[概念/相关概念]]"
---
```

## 正文结构

1. **核心结论**（3–5 句）
2. **基本面表格**（市值/股本/PE/主营业务）
3. **催化剂/逻辑链**
4. **资金面/股东动向**
5. **风险矩阵**
6. **交易含义**（与交易体系、模式的关联）

## 降级直写路径（仅 ingest 反复失败时）

```bash
TARGET="${TRADING_WIKI_PROJECT}/wiki/sources/逸豪新材-301176-个股调研.md"
# 写入带 frontmatter 的完整 Markdown；禁止改写 raw/**
```

`wiki/sources/` 可被 RAG 检索，但不会自动产生 factWrites、wikilink 编译与 index/overview 更新。
