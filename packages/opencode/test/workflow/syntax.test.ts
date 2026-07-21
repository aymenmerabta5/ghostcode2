import { describe, expect, test } from "bun:test"
import { Syntax } from "../../src/workflow/syntax"

describe("workflow syntax validation - general", () => {
  test("detects invalid JS expression inside template literal", () => {
    const source = `
export default {
  meta: { name: "test", description: "test", phases: ["a"] },
  async run(args, ctx) {
    const version = "1.0"
    return {
      deps: {
        "some-lib": \`^\${version or latest}\`,
      }
    }
  }
}
`
    const result = Syntax.validateSyntax(source, "example-workflow.ts")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const msg = Syntax.formatInvalidError("example-workflow.ts", result)
      expect(msg).toContain("example-workflow.ts")
      expect(msg).toContain("unescaped")
      expect(msg).toContain("\\${")
      expect(msg).toContain("bun --check")
      expect(result.errors.some((e) => e.message.includes("}") || e.message.includes("expected"))).toBe(true)
    }
  })

  test("detects syntax error in agent prompt with invalid expression", () => {
    const source = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run(args, ctx) {
    ctx.agent({
      prompt: \`Install lib ^\${ver or latest} and config ^\${cfg.value}\`
    })
  }
}
`
    const result = Syntax.validateSyntax(source, "test.ts")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0)
      const formatted = Syntax.formatInvalidError("test.ts", result)
      expect(formatted.toLowerCase()).toContain("backtick")
      expect(formatted).toContain("Workflow syntax error")
    }
  })

  test("valid workflow with escaped template braces passes", () => {
    const source = `
export default {
  meta: { name: "test", description: "test", phases: ["a"] },
  async run(args, ctx) {
    const ver = "1.0"
    ctx.agent({
      prompt: \`Deps: lib ^\${ver} or latest and config ^\\\${cfg.value}\`
    })
  }
}
`
    const result = Syntax.validateSyntax(source, "good.ts")
    expect(result.ok).toBe(true)
  })

  test("valid workflow with intentional interpolations passes", () => {
    const source = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run(args, ctx) {
    const nodeVer = "20"
    const depth = 3
    const finding = { id: "abc" }
    ctx.agent({
      prompt: \`Node \${nodeVer}, depth \${depth}, finding \${finding.id}\`
    })
  }
}
`
    const result = Syntax.validateSyntax(source, "ok.ts")
    expect(result.ok).toBe(true)
  })

  test("enhanceImportError translates cache-module error into syntax error", () => {
    const badSource = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run(args, ctx) {
    const ver = "1.0"
    return { dep: \`^\${ver or latest}\` }
  }
}
`
    const cacheErr = "Cannot find module '/home/user/project/.opencode/workflows/.cache-abc123-def456.ts' from 'B/~BUN/root/chunk.js'"
    const enhanced = Syntax.enhanceImportError(cacheErr, badSource, "my-workflow.ts")

    expect(enhanced).toContain("Workflow syntax error")
    expect(enhanced).toContain("my-workflow.ts")
    expect(enhanced).toContain("unescaped")
    expect(enhanced).toContain("Original import error (misleading)")
    expect(enhanced).toContain("Tip: The engine copies your workflow")
  })

  test("enhanceImportError for valid file still explains cache error", () => {
    const goodSource = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run() { return { ok: true } }
}
`
    const cacheErr = "Cannot find module '/tmp/project/.opencode/workflows/.cache-xyz.ts' from 'B/~BUN/root/chunk.js'"
    const enhanced = Syntax.enhanceImportError(cacheErr, goodSource, "good.ts")
    expect(enhanced).toContain("Cannot find module")
    expect(enhanced).toContain("bun --check")
    expect(enhanced).toContain("WINDOWS FILE LOCK")
    expect(enhanced).toContain("AGENT AUTO-FIX")
    expect(enhanced).toContain("Clean orphan")
    expect(enhanced).toContain("unescaped")
  })

  test("looksLikeCacheModuleError detection - general paths", () => {
    expect(Syntax.looksLikeCacheModuleError("Cannot find module '/home/user/.opencode/workflows/.cache-123.ts' from 'chunk.js'")).toBe(true)
    expect(Syntax.looksLikeCacheModuleError("Cannot find module '.cache-abc.ts'")).toBe(true)
    expect(Syntax.looksLikeCacheModuleError("Cannot find module 'C:\\Users\\test\\.opencode\\workflows\\.cache\\abc.ts' from 'chunk.js'")).toBe(true)
    expect(Syntax.looksLikeCacheModuleError("Cannot find module '/tmp/project/.opencode/workflows/.cache/xyz.ts'")).toBe(true)
    expect(Syntax.looksLikeCacheModuleError("SyntaxError: Expected }")).toBe(false)
    expect(Syntax.looksLikeCacheModuleError("ReferenceError: something is not defined")).toBe(false)
  })

  test("formatInvalidError includes actionable fixes", () => {
    const source = `export default { meta: { name: "x" }, async run() { const a = \`\${b or c}\` } }`
    const res = Syntax.validateSyntax(source, "x.ts")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const formatted = Syntax.formatInvalidError("x.ts", res)
      // Must contain agent auto-fix guidance
      expect(formatted).toContain("AGENT AUTO-FIX")
      expect(formatted).toContain("escape all accidental")
      expect(formatted).toContain("bun --check")
      expect(formatted).toContain("single quote")
      expect(formatted).toContain("BAD:")
      expect(formatted).toContain("GOOD:")
      expect(formatted).toContain("evaluated by the workflow file at load time")
      expect(formatted).toContain("Clean orphan")
    }
  })

  test("syntax check does not false-positive on normal code", () => {
    const sources = [
      `export default { meta: { name: "a", phases: ["x"] }, async run(args, ctx) { return { a: 1 } } }`,
      `export const meta = { name: "b", phases: ["y"] }; export async function run(args, ctx) { ctx.log("hi") }`,
      `export default { meta: { name: "c" }, run: async (args, ctx) => { await ctx.agent({ prompt: "hello" }) } }`,
      `export default { meta: { name: "d", phases: ["a", "b"] }, async run(args, ctx) { const files = ["a.ts"]; return { files } } }`,
    ]
    for (const src of sources) {
      const result = Syntax.validateSyntax(src, "valid.ts")
      expect(result.ok).toBe(true)
    }
  })

  test("multiple syntax errors are all reported", () => {
    const source = `
export default {
  meta: { name: "t", phases: ["a"] },
  async run() {
    const a = \`\${x or y}\`
    const b = \`\${p or q}\`
    const c = \`\${m or n}\`
    const d = \`\${i or j}\`
    const e = \`\${k or l}\`
    const f = \`\${o or p}\`
  }
}
`
    const res = Syntax.validateSyntax(source, "multi.ts")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThan(5)
      const formatted = Syntax.formatInvalidError("multi.ts", res)
      expect(formatted).toContain("more errors")
    }
  })

  test("empty and minimal workflows pass validation", () => {
    const minimal = `export default { meta: { name: "minimal", phases: ["a"] }, async run() { return {} } }`
    expect(Syntax.validateSyntax(minimal, "minimal.ts").ok).toBe(true)

    const withGlobal = `export const meta = { name: "test", phases: ["a"] }; export async function run(args) { return { ok: true } }`
    expect(Syntax.validateSyntax(withGlobal, "global.ts").ok).toBe(true)
  })
})

describe("workflow runtime escaping - general pattern", () => {
  test("syntactically valid but referencing undefined var - should be caught at runtime", () => {
    const source = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run(args, ctx) {
    const prompt = \`config ^\${cfg.value}\`
    return { prompt }
  }
}
`
    const syntaxRes = Syntax.validateSyntax(source, "runtime.ts")
    expect(syntaxRes.ok).toBe(true)

    expect(() => {
      eval("cfg.value")
    }).toThrow()
  })

  test("escaped version does not throw and preserves literal", () => {
    const source = `
export default {
  meta: { name: "test", phases: ["a"] },
  async run(args, ctx) {
    const prompt = \`config ^\\\${cfg.value}\`
    return { prompt }
  }
}
`
    const res = Syntax.validateSyntax(source, "escaped.ts")
    expect(res.ok).toBe(true)

    const prompt = `config ^\${cfg.value}`
    expect(prompt).toBe("config ^${cfg.value}")
    expect(prompt).toContain("${cfg.value}")
  })

  test("various escaped patterns are valid", () => {
    const patterns = [
      `export default { meta: { name: "a" }, async run() { const p = \`\\\${x}\`; return {} } }`,
      `export default { meta: { name: "b" }, async run() { const p = 'literal \${x}'; return {} } }`,
      `export default { meta: { name: "c" }, async run() { const ver = "1"; const p = \`v\${ver} literal \\\${y}\`; return {} } }`,
    ]
    for (const src of patterns) {
      expect(Syntax.validateSyntax(src, "escaped.ts").ok).toBe(true)
    }
  })
})

describe("workflow.txt documentation - general", () => {
  test("workflow.txt contains v2 required sections exactly once", async () => {
    const { default: path } = await import("path")
    const txt = await Bun.file(path.join(import.meta.dir, "../../src/tool/workflow.txt")).text()

    // New v2 doc must contain each major section heading exactly once, in proper place
    const requiredHeadings = [
      "QUALITY-FIRST POLICY",
      "TEMPLATE-LITERAL TRAP",
      "CONTEXT API",
      "HARD RULES",
      "CHECKLIST BEFORE",
      "TROUBLESHOOTING",
      "RESUME",
      "WHAT A WORKFLOW IS",
      "WHEN TO USE",
      "FILE FORMAT",
      "TOOL ACTIONS",
    ]

    for (const heading of requiredHeadings) {
      const count = (txt.match(new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length
      expect(count).toBe(1)
    }

    // Ensure no legacy compat appendix exists (each rule exactly once)
    expect(txt).not.toContain("LEGACY COMPAT SECTION")
    expect(txt).not.toContain("CRITICAL: Template Literal")

    // Ensure new doc still documents interpolation escaping
    expect(txt).toContain("\\${")
    expect(txt).toContain("bun --check")
    expect(txt).toContain("${args.dir}")

    // Ensure quality-first policy is present and prominent
    expect(txt).toContain("Verification is MANDATORY")
    expect(txt).toContain("effort")
  })

  test("workflow.txt documents v2 patterns and context API", async () => {
    const { default: path } = await import("path")
    const txt = await Bun.file(path.join(import.meta.dir, "../../src/tool/workflow.txt")).text()

    // Context API must document new v2 methods
    expect(txt).toContain("setPhase")
    expect(txt).toContain("getPhase")
    expect(txt).toContain("state")
    expect(txt).toContain("agent")
    expect(txt).toContain("parallel")
    expect(txt).toContain("workflow")
    expect(txt).toContain("tool")
    expect(txt).toContain("shell")

    // Must mention InvalidPhaseError and determinism lint
    expect(txt).toContain("InvalidPhaseError")
    expect(txt).toContain("Determinism")
  })

  test("workflow.txt contains troubleshooting and cache handling", async () => {
    const { default: path } = await import("path")
    const txt = await Bun.file(path.join(import.meta.dir, "../../src/tool/workflow.txt")).text()

    expect(txt).toContain("Cannot find module")
    expect(txt).toContain(".cache-")
    expect(txt).toContain("syntax error")
    // Check that doc explains retry behavior
    expect(txt.toLowerCase()).toContain("retries")
  })
})

describe("security hardening - general", () => {
  test("enhanceImportError redacts absolute cache paths", () => {
    const goodSource = `export default { meta: { name: "x" }, async run() { return {} } }`
    const msgWithPath =
      "Cannot find module '/home/user/projects/my-app/.opencode/workflows/.cache-abc123-def456.ts' from 'B/~BUN/root/chunk.js'"
    const enhanced = Syntax.enhanceImportError(msgWithPath, goodSource, "good.ts")
    expect(enhanced).not.toContain("/home/user/projects/my-app")
    expect(enhanced).not.toContain("abc123-def456")
    expect(enhanced).toContain(".cache-*.ts")
  })

  test("enhanceImportError redacts Windows cache paths", () => {
    const goodSource = `export default { meta: { name: "x" }, async run() { return {} } }`
    const winPath = "Cannot find module 'C:\\Users\\Alice\\project\\.opencode\\workflows\\.cache\\xyz789.ts' from 'chunk.js'"
    const enhanced = Syntax.enhanceImportError(winPath, goodSource, "good.ts")
    expect(enhanced).not.toContain("C:\\Users\\Alice")
    expect(enhanced).not.toContain("xyz789")
  })

  test("extractSnippet sanitizes ANSI escape codes", () => {
    const errors = Syntax.getSyntaxErrors(`const a = \`\${b or c}\` // \x1b[31mtest`, "test.ts")
    expect(Array.isArray(errors)).toBe(true)
    if (errors.length > 0) {
      for (const e of errors) {
        expect(e.snippet).not.toContain("\x1b")
      }
    }
  })

  test("formatInvalidError quotes path for shell safety", () => {
    const source = `export default { meta: { name: "x" }, async run() { const a = \`\${b or c}\` } }`
    const res = Syntax.validateSyntax(source, "my workflow with spaces.ts")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const formatted = Syntax.formatInvalidError("my workflow with spaces.ts", res)
      expect(formatted).toContain(`"my workflow with spaces.ts"`)
    }
  })

  test("formatInvalidError does not suggest bun --check for synthetic paths", () => {
    const source = `export default { meta: { name: "x" }, async run() { const a = \`\${b or c}\` } }`
    const res = Syntax.validateSyntax(source, "builtin:deep-research")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const formatted = Syntax.formatInvalidError("builtin:deep-research", res)
      expect(formatted).not.toContain("bun --check")
    }
  })

  test("validateSyntax handles various file extensions and paths generically", () => {
    const src = `export default { meta: { name: "test" }, async run() { return {} } }`
    const paths = [
      "workflow.ts",
      "my-workflow.js",
      ".opencode/workflows/test.ts",
      "/tmp/test.ts",
      "builtin:test",
      "inline",
    ]
    for (const p of paths) {
      const res = Syntax.validateSyntax(src, p)
      expect(res.ok).toBe(true)
    }
  })
})

describe("workflow must not run on syntax error - general guarantee", () => {
  test("all invalid patterns are rejected by validateSyntax", () => {
    const invalidPatterns = [
      `export default { meta: { name: "x" }, async run() { const a = \`\${x or y}\` } }`,
      `export default { meta: { name: "x" }, async run() { const a = \`\${a or b} and \${c or d}\` } }`,
      `export default { meta: { name: "x" }, async run() { return { v: \`\${foo or bar}\` } } }`,
      `export default { meta: { name: "x" }, async run() { ctx.agent({ prompt: \`x \${y or z}\` }) } }`,
    ]
    for (const pattern of invalidPatterns) {
      const res = Syntax.validateSyntax(pattern, "test.ts")
      expect(res.ok).toBe(false)
    }
  })

  test("valid patterns with proper escaping always pass", () => {
    const validPatterns = [
      `export default { meta: { name: "x" }, async run() { const v = "1"; const a = \`\${v} or latest\`; return {} } }`,
      `export default { meta: { name: "x" }, async run() { const a = \`\\\${escaped}\`; return {} } }`,
      `export default { meta: { name: "x" }, async run() { const a = 'literal \${notInterpolated}'; return {} } }`,
      `export default { meta: { name: "x" }, async run(args, ctx) { const f = "file.ts"; await ctx.agent({ prompt: \`Audit \${f}\` }) } }`,
    ]
    for (const pattern of validPatterns) {
      const res = Syntax.validateSyntax(pattern, "test.ts")
      expect(res.ok).toBe(true)
    }
  })
})
