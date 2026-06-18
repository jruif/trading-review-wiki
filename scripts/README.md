# Trading Review Wiki 文件整理脚本

> 一键将散落在 wiki 根目录的 `.md` 文件，按 frontmatter `type` 自动归类到对应分类目录。

---

## 什么时候需要用这个脚本？

### 场景 1：LLM 生成文件放错了位置
在使用 **提取到 Wiki** 功能时，如果 LLM 没有正确理解目录结构，可能会把文件直接生成在 `wiki/` 根目录，而不是 `wiki/股票/`、`wiki/策略/` 等分类目录下。这个脚本可以批量修复。

### 场景 2：从旧版本迁移
v0.5.8 及之前版本存在目录路由问题，LLM 生成的文件可能：
- 全部堆在 wiki 根目录
- `type` 用了英文值（如 `entity`、`concept`）
- 文件名没有放入对应中文目录

运行此脚本即可自动整理。

### 场景 3：手动创建的文件需要归类
如果你在 wiki 根目录手动创建了一些 `.md` 文件，但忘了放到分类目录，也可以用这个脚本批量整理。

---

## 前置要求

- [Node.js](https://nodejs.org/) 16+（大多数电脑已安装）

---

## 快速开始

### 1. 下载脚本

从 GitHub 下载 `reorganize-wiki.cjs`：

```bash
# 方式一：直接下载 raw 文件
curl -O https://raw.githubusercontent.com/ymj8903668-droid/trading-review-wiki/main/scripts/reorganize-wiki.cjs

# 方式二：克隆仓库后使用
git clone https://github.com/ymj8903668-droid/trading-review-wiki.git
cd trading-review-wiki/scripts
```

### 2. 预览（强烈建议先预览）

```bash
# <wiki-root> 为项目下的 wiki/ 目录绝对或相对路径
node reorganize-wiki.cjs ./wiki --dry-run
```

`--dry-run` 只显示将要执行的操作，**不会实际移动任何文件**。

### 3. 正式执行

```bash
node reorganize-wiki.cjs ./wiki
```

---

## 命令参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `<wiki-root>` | 必填，`wiki/` 目录路径 | `./wiki` |
| `--dry-run` | 预览模式，只显示不执行 | `--dry-run` |
| `--map <type>=<dir>` | 自定义 type→目录映射（可多次使用） | `--map entity=概念` |
| `--help` | 显示帮助信息 | `--help` |

---

## 完整示例

```bash
# 基本用法（在项目根目录执行）
node reorganize-wiki.cjs ./wiki

# 预览模式
node reorganize-wiki.cjs ./wiki --dry-run

# 指定 wiki 根目录（绝对路径）
node reorganize-wiki.cjs /path/to/project/wiki

# 通过环境变量传入项目根，再拼 wiki 子目录
node reorganize-wiki.cjs "$TRADING_WIKI_PROJECT/wiki"

# 扩展 type → 目录映射
node reorganize-wiki.cjs ./wiki --map entity=概念 --map report=sources

# 查看帮助
node reorganize-wiki.cjs --help
```

---

## 内置映射规则

脚本内置了常见的 type → directory 映射：

| frontmatter `type` | 目标目录 |
|--------------------|----------|
| `股票` / `个股档案` | `wiki/股票/` |
| `策略` | `wiki/策略/` |
| `模式` / `核心模式` | `wiki/模式/` |
| `概念` / `概念/主题` | `wiki/概念/` |
| `错误` | `wiki/错误/` |
| `市场环境` | `wiki/市场环境/` |
| `进化` | `wiki/进化/` |
| `总结` | `wiki/总结/` |
| `source` | `wiki/sources/` |

如果脚本遇到未识别的 type，会提示跳过，并建议你使用 `--map` 参数或编辑脚本中的 `DEFAULT_TYPE_MAP` 来扩展。

---

## 脚本会做什么

1. **扫描** wiki 根目录下的所有 `.md` 文件（排除 `index.md`、`log.md` 等系统文件）
2. **读取** 每个文件的 frontmatter，获取 `type` 字段
3. **移动** 文件到对应的分类目录（自动创建缺失的目录）
4. **跳过** 目标目录已有同名文件的情况（不覆盖）
5. **更新引用** 扫描所有 wiki 文件，将旧 wikilink `[[文件名]]` 更新为 `[[目录/文件名]]`

---

## 注意事项

- **运行前备份**：虽然脚本不会删除文件，但移动操作不可逆，建议先备份 wiki 文件夹
- **目标已存在**：如果目标目录已有同名文件，脚本会自动跳过（不会覆盖）
- **无 type 的文件**：如果文件没有 frontmatter `type`，脚本会提示跳过，需要你手动处理
- **系统文件保护**：`index.md`、`log.md`、`overview.md`、`schema.md`、`purpose.md` 保留在根目录
- **关闭应用后再运行**：确保 Trading Review Wiki 应用已关闭，避免文件冲突

---

## 常见问题

**Q: 脚本运行后文件树没有变化？**
> 关闭并重新打开 Trading Review Wiki 应用即可刷新文件树。

**Q: 有些文件提示"未知 type"怎么办？**
> 使用 `--map` 参数临时添加映射：
> ```bash
> node reorganize-wiki.cjs ./wiki --map custom-type=目标目录
> ```

**Q: 可以用在其他 Wiki 项目上吗？**
> 可以。只要你的 Wiki 使用 Markdown + YAML frontmatter 格式，并且 `type` 字段决定分类目录，这个脚本就适用。你可以在脚本中修改 `DEFAULT_TYPE_MAP` 来适配自己的分类体系。

---

## License

与本项目一致，MIT License。
