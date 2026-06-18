import { describe, it, expect } from "vitest"
import {
  validate,
  cleanSources,
  normalizeTypeAlias,
  normalizeStatusAlias,
  normalizeWikiTimestamp,
  coerceWikiPageFrontmatter,
  inferTypeFromPath,
  nowLocalTimestamp,
  parseFrontmatter,
  serializeFrontmatter,
  canonicalSampleFor,
  SCHEMA_VERSION,
  type WikiFrontmatter,
} from "../schema"
import { mergeUpdateFromLlmOutput } from "../ingest"

function buildValid(overrides: Partial<WikiFrontmatter> = {}): WikiFrontmatter {
  return {
    schema_version: SCHEMA_VERSION,
    title: "示例页面",
    type: "概念",
    summary:
      "示例摘要，覆盖 50 到 120 字之间的字数范围，用于召回与检索；不与正文重复，仅做概括。这是足够长的摘要文本。",
    created: "2026-05-11 14:23:07",
    updated: "2026-05-11 14:23:07",
    last_reviewed: "2026-05-11 14:23:07",
    confidence: "高",
    status: "活跃",
    ...overrides,
  } as WikiFrontmatter
}

describe("validate", () => {
  it("legal frontmatter passes with no fatal violations", () => {
    const v = validate(buildValid())
    expect(v.filter((x) => x.fatal)).toEqual([])
  })

  it("missing title is fatal", () => {
    const v = validate({ ...buildValid(), title: "" })
    expect(v.some((x) => x.field === "title" && x.fatal)).toBe(true)
  })

  it("type outside enum is fatal", () => {
    const v = validate({ ...buildValid(), type: "市场模式" as never })
    expect(v.some((x) => x.field === "type" && x.fatal)).toBe(true)
  })

  it("summary at 49 chars fails, 50 chars passes", () => {
    const at49 = "短摘要".repeat(0) + "x".repeat(49)
    const at50 = "x".repeat(50)
    expect(validate({ ...buildValid(), summary: at49 }).some((x) => x.field === "summary")).toBe(true)
    expect(validate({ ...buildValid(), summary: at50 }).some((x) => x.field === "summary")).toBe(false)
  })

  it("summary at 120 chars passes, 121 chars fails", () => {
    const at120 = "x".repeat(120)
    const at121 = "x".repeat(121)
    expect(validate({ ...buildValid(), summary: at120 }).some((x) => x.field === "summary")).toBe(false)
    expect(validate({ ...buildValid(), summary: at121 }).some((x) => x.field === "summary")).toBe(true)
  })

  it("CJK summary counted by codepoint", () => {
    const cjk60 = "中".repeat(60)
    expect(validate({ ...buildValid(), summary: cjk60 }).some((x) => x.field === "summary")).toBe(false)
  })

  it("timestamp missing seconds is fatal", () => {
    const v = validate({ ...buildValid(), updated: "2026-05-11" })
    expect(v.some((x) => x.field === "updated" && x.fatal)).toBe(true)
  })

  it("stock type without code is fatal", () => {
    const v = validate({
      ...buildValid({ type: "股票" }),
    })
    expect(v.some((x) => x.field === "code" && x.fatal)).toBe(true)
  })

  it("stock type with valid code passes", () => {
    const v = validate({
      ...buildValid({ type: "股票", code: "SZ301580" }),
    })
    expect(v.filter((x) => x.fatal)).toEqual([])
  })

  it("stock type with Hong Kong code passes", () => {
    const v = validate({
      ...buildValid({ type: "股票", code: "HK09992" }),
    })
    expect(v.filter((x) => x.fatal)).toEqual([])
  })

  it("stock type with US ticker passes", () => {
    const v = validate({
      ...buildValid({ type: "股票", code: "AAPL" }),
    })
    expect(v.filter((x) => x.fatal)).toEqual([])
  })

  it("stock code lowercase is fatal", () => {
    const v = validate({
      ...buildValid({ type: "股票", code: "sz301580" }),
    })
    expect(v.some((x) => x.field === "code" && x.fatal)).toBe(true)
  })

  it("related must be wikilink form", () => {
    const v = validate({
      ...buildValid(),
      related: ["概念/X"],
    })
    expect(v.some((x) => x.field === "related" && x.fatal)).toBe(true)
    const ok = validate({ ...buildValid(), related: ["[[概念/X]]"] })
    expect(ok.filter((x) => x.fatal)).toEqual([])
  })

  it("type-specific field on wrong type warns (not fatal)", () => {
    const v = validate({
      ...buildValid({ type: "概念" }),
      code: "SZ301580",
    } as WikiFrontmatter)
    expect(v.some((x) => x.field === "code" && !x.fatal)).toBe(true)
  })

  it("status outside enum is fatal", () => {
    const v = validate({ ...buildValid(), status: "凉了" as never })
    expect(v.some((x) => x.field === "status" && x.fatal)).toBe(true)
  })
})

describe("cleanSources", () => {
  it("strips .md suffix and dedupes", () => {
    expect(cleanSources(["a.md", "a.md", "b.md"])).toEqual(["a", "b"])
  })

  it("drops LLM reply prefix", () => {
    expect(cleanSources(["好的，以下是-2026-05-08.md", "normal.md"])).toEqual(["normal"])
  })

  it("drops wikilink fragments", () => {
    expect(cleanSources(["]]-页面内容.md", "ok.md"])).toEqual(["ok"])
  })

  it("strips trailing -1 / -2 duplicates", () => {
    expect(cleanSources(["foo-1.md", "foo-2.md"])).toEqual(["foo"])
  })

  it("truncates very long names", () => {
    const long = "x".repeat(80)
    const cleaned = cleanSources([long])
    expect(cleaned[0]).toMatch(/\.\.\.$/)
    expect(cleaned[0].length).toBeLessThanOrEqual(43)
  })

  it("keeps non-md extensions like pdf/xlsx", () => {
    expect(cleanSources(["report.pdf", "data.xlsx"])).toEqual(["report.pdf", "data.xlsx"])
  })
})

describe("normalizeTypeAlias", () => {
  it("maps market-mode variants to 模式", () => {
    expect(normalizeTypeAlias("市场模式")).toBe("模式")
    expect(normalizeTypeAlias("进化")).toBe("模式")
    expect(normalizeTypeAlias("预测")).toBe("模式")
  })

  it("maps individual stock dossier to 股票", () => {
    expect(normalizeTypeAlias("个股档案")).toBe("股票")
  })

  it("maps synthesis/analysis variants to 总结", () => {
    expect(normalizeTypeAlias("分析")).toBe("总结")
    expect(normalizeTypeAlias("比较")).toBe("总结")
    expect(normalizeTypeAlias("synthesis")).toBe("总结")
  })

  it("returns null for unknown", () => {
    expect(normalizeTypeAlias("foobar")).toBe(null)
  })
})

describe("normalizeStatusAlias", () => {
  it("maps watching to 观察", () => {
    expect(normalizeStatusAlias("watching")).toBe("观察")
  })

  it("keeps 活跃 as-is", () => {
    expect(normalizeStatusAlias("活跃")).toBe("活跃")
  })
})

describe("inferTypeFromPath", () => {
  it("recognizes 股票 path", () => {
    expect(inferTypeFromPath("wiki/股票/爱迪特.md")).toBe("股票")
  })

  it("normalizes 市场模式 to 模式", () => {
    expect(inferTypeFromPath("wiki/市场模式/2024-牛市.md")).toBe("模式")
  })

  it("falls back to 总结 for unknown", () => {
    expect(inferTypeFromPath("wiki/未知/x.md")).toBe("总结")
  })

  it("handles Windows backslash", () => {
    expect(inferTypeFromPath("wiki\\概念\\AI.md")).toBe("概念")
  })
})

describe("nowLocalTimestamp", () => {
  it("matches the format YYYY-MM-DD HH:mm:ss", () => {
    expect(nowLocalTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe("normalizeWikiTimestamp", () => {
  it("coerces date-only and ISO values", () => {
    expect(normalizeWikiTimestamp("2026-04-15")).toBe("2026-04-15 00:00:00")
    expect(normalizeWikiTimestamp("2026-06-15T14:23:07")).toBe("2026-06-15 14:23:07")
  })
})

describe("coerceWikiPageFrontmatter", () => {
  it("fills missing fields and normalizes timestamps", () => {
    const coerced = coerceWikiPageFrontmatter(
      { created: "2026-04-15", updated: "2026-04-16" },
      "wiki/模式/测试模式.md",
      "# 测试模式\n\n正文段落。",
      { now: "2026-06-15 10:00:00" },
    )
    expect(coerced.schema_version).toBe(1)
    expect(coerced.title).toBe("测试模式")
    expect(coerced.type).toBe("模式")
    expect(coerced.created).toBe("2026-04-15 00:00:00")
    expect(coerced.updated).toBe("2026-04-16 00:00:00")
    expect([...(coerced.summary ?? "")].length).toBeGreaterThanOrEqual(50)
  })

  it("clamps summary longer than 120 chars", () => {
    const coerced = coerceWikiPageFrontmatter(
      {
        schema_version: 1,
        title: "长摘要页",
        type: "概念",
        summary: "中".repeat(150),
        created: "2026-05-11 14:23:07",
        updated: "2026-05-11 14:23:07",
        last_reviewed: "2026-05-11 14:23:07",
        confidence: "中",
        status: "活跃",
      },
      "wiki/概念/长摘要页.md",
      "# 长摘要页",
    )
    expect([...(coerced.summary ?? "")].length).toBeLessThanOrEqual(120)
    expect(validate(coerced as WikiFrontmatter).filter((v) => v.fatal)).toEqual([])
  })

  it("drops invalid related wikilinks instead of failing validation", () => {
    const coerced = coerceWikiPageFrontmatter(
      buildValid({ related: ["bad-link", "[[概念/OK]]"] }),
      "wiki/概念/测试页.md",
      "# 测试页",
    )
    expect(coerced.related).toEqual(["[[概念/OK]]"])
  })
})

describe("mergeUpdateFromLlmOutput", () => {
  it("appends incremental sections and preserves existing body", () => {
    const existing = serializeFrontmatter(buildValid({ title: "旧页", type: "概念" }), "# 旧页\n\n已有段落。")
    const merged = mergeUpdateFromLlmOutput(
      existing,
      "---FILE: wiki/概念/旧页.md---\n## 新证据\n\n补充内容。\n---END FILE---",
      "wiki/概念/旧页.md",
      "2026-06-12-复盘",
      "2026-06-15 12:00:00",
    )
    expect(merged).toContain("已有段落")
    expect(merged).toContain("## 来自 2026-06-12-复盘 的补充")
    expect(merged).toContain("补充内容")
    expect(merged).toContain("2026-06-12-复盘")
  })
})

describe("parseFrontmatter & serializeFrontmatter", () => {
  it("parses canonical YAML", () => {
    const md =
      "---\nschema_version: 1\ntitle: 测试\ntype: 概念\n---\n\n# 正文\n\n内容。"
    const { fm, body, hadYamlWrapper } = parseFrontmatter(md)
    expect(fm.schema_version).toBe(1)
    expect(fm.title).toBe("测试")
    expect(fm.type).toBe("概念")
    expect(body).toContain("# 正文")
    expect(hadYamlWrapper).toBe(false)
  })

  it("parses the ```yaml-wrapped format (v1 default)", () => {
    const md =
      "```yaml\n---\nschema_version: 1\ntitle: 测试\ntype: 概念\n---\n```\n\n# 正文\n\n内容。"
    const { fm, hadYamlWrapper } = parseFrontmatter(md)
    expect(hadYamlWrapper).toBe(true)
    expect(fm.title).toBe("测试")
  })

  it("serialize wraps with ```yaml + --- ... ---``` and round-trip preserves body", () => {
    const fm = {
      schema_version: 1,
      title: "测试",
      type: "概念",
      summary: "x".repeat(60),
      created: "2026-05-11 14:23:07",
      updated: "2026-05-11 14:23:07",
      last_reviewed: "2026-05-11 14:23:07",
      confidence: "高",
      status: "活跃",
    } as WikiFrontmatter
    const body = "# 标题\n\n正文段落。\n"
    const serialized = serializeFrontmatter(fm, body)
    expect(serialized.startsWith("```yaml\n---\n")).toBe(true)
    expect(serialized).toContain("\n---\n```\n")
    expect(serialized.endsWith(body)).toBe(true)
    const reparsed = parseFrontmatter(serialized)
    expect(reparsed.hadYamlWrapper).toBe(true)
    expect(reparsed.body).toBe(body)
    expect(reparsed.fm.title).toBe("测试")
  })
})

describe("canonicalSampleFor", () => {
  it("contains type-specific fields for 股票", () => {
    const sample = canonicalSampleFor("股票")
    expect(sample).toContain("code:")
    expect(sample).toContain("industry:")
  })

  it("contains type-specific fields for 概念", () => {
    const sample = canonicalSampleFor("概念")
    expect(sample).toContain("parent:")
    expect(sample).toContain("momentum:")
  })

  it("does not include 股票 fields on 概念 sample", () => {
    const sample = canonicalSampleFor("概念")
    expect(sample).not.toContain("\ncode:")
    expect(sample).not.toContain("\nindustry:")
  })
})
