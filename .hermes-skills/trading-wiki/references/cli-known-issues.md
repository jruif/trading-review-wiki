# trading-wiki CLI 已知问题与绕过方案

> 最后对照 CLI 版本：v0.10.5+。部分旧问题已在 CLI 内自动修复；仍失败时按下列顺序排查。

## 已修复（重跑即可）

### 控制字符 → JSON 解析失败

```
Bad control character in string literal in JSON
```

**现状：** `prepare` / `api-run` / `apply` 读源时会 `sanitizeTextControlCharacters`。
**处理：** 重跑 `ingest`；仍失败时用 `tr -d '\000-\010\013-\037'` 清洗源文件后再 ingest。

### apply 时间戳格式

```
[created] must use YYYY-MM-DD HH:mm:ss
```

**现状：** `apply` 写入前会自动把纯日期补全为 `YYYY-MM-DD 00:00:00`。
**处理：** 直接重跑 `apply`；旧 manifest 若仍报错，见 `references/cli-known-issues.md` 历史 workaround。

## 仍常见

### DeepSeek 无响应 / ingest 超时

```
No assistant text found in provider output
Command timed out after ...ms
```

**原因：** LLM 偶发空响应；或 plan 页数多 + 默认串行生成导致总时长超过 shell 超时。

**处理：**

```bash
export TRADING_WIKI_REASONING_EFFORT=low
export TRADING_WIKI_PAGE_CONCURRENCY=3
bash tw-cli.sh ingest /path/to/raw/file.md
```

大文件可拆成多个小源文件分别 ingest。

### Stage 3 缺 FILE block

```
Stage 3 returned no FILE block for wiki/概念/xxx.md
```

**原因：** LLM 输出格式不稳定，某页未返回 `---FILE:` 块。

**处理：**

1. 重跑 `ingest`
2. 若 api-run 已完成大部分页，用 `tw-cli.sh finalize <run-id>` 续跑 housekeeping
3. 仍缺页则对该页单独重跑或人工补 FILE block

### apply schema 校验失败

```
Fatal schema validation failed
```

**原因：** 生成页缺 `title` / `code`（股票页）/ 非法 `related` wikilink 等。

**处理：**

```bash
# 跳过问题页，写入其余合法页
tw-cli.sh apply /path/to/changes.json --write --skip-invalid
```

股票页缺 `code` 需人工补全 manifest 或修正后重跑。

### source hash / Desktop 路径

```
EPERM: operation not permitted, open '/Users/.../Desktop/...'
Source hash changed
```

**原因：** 旧 manifest 的 `sourcePath` 指向不可访问路径；或源文件 ingest 后被修改。

**处理：** 从 `raw/` 重新 ingest；apply 时必要时加 `--allow-source-change`（确认源文件变更符合预期）。

## 终极降级（最后手段）

优先级：**正常流水线 > raw/ 再 ingest > wiki/sources/ 直写**。

| 方式 | 边界 | RAG |
|---|---|---|
| `prepare → ingest → finalize → apply` | 标准路径 | 编译后进 wiki + 多源检索 |
| 放入 `raw/` 后再 `ingest` | raw 不可变，CLI 只读 | 经编译后进入 wiki |
| 直写 `wiki/sources/` | 绕过 manifest/apply | 可被 RAG 索引，但无 factWrites / 交叉引用编译 |

直写 `wiki/sources/` 模板见 `references/stock-research-auto-save.md`。
