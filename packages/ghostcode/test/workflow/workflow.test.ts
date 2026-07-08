import { describe, expect, it } from "bun:test"
import { MetaReader } from "../../src/workflow/meta-reader"
import { SourceLint } from "../../src/workflow/source-lint"
import { TurnBudget } from "../../src/workflow/turn-budget"
import { BUILTIN_WORKFLOWS, builtinPath, inlinePath, isBuiltinPath, isInlinePath } from "../../src/workflow/builtin"
import {
  BudgetExceededError,
  CancelledError,
  InvalidError,
  NotFoundError,
  SaveConflictError,
} from "../../src/workflow/errors"
import { parseStructured } from "../../src/workflow/workflow"

describe("workflow meta-reader", () => {
  it("reads meta from export const meta", () => {
    const source = `
      export const meta = {
        name: "test",
        description: "A test workflow",
        phases: ["one", "two"],
        arguments: { query: { type: "string" } },
      }
      export async function run(args, ctx) { return args }
    `
    const result = MetaReader.read(source, "test.ts")
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.meta.name).toBe("test")
      expect(result.meta.description).toBe("A test workflow")
      expect(result.meta.phases).toEqual([{ title: "one" }, { title: "two" }])
      expect(result.meta.arguments?.query?.type).toBe("string")
    }
  })

  it("reads meta from export default object", () => {
    const source = `
      export default {
        meta: {
          name: "default-obj",
          phases: [{ title: "plan", detail: "Planning phase" }],
        },
        async run(args, ctx) { return null },
      }
    `
    const result = MetaReader.read(source, "test.ts")
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.meta.name).toBe("default-obj")
      expect(result.meta.phases?.[0]).toEqual({ title: "plan", detail: "Planning phase" })
    }
  })

  it("reads meta from workflow() call", () => {
    const source = `
      export default workflow({
        name: "wrapped",
        description: "Wrapped workflow",
        run(args, ctx) { return Promise.resolve(args) },
      })
    `
    const result = MetaReader.read(source, "test.ts")
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.meta.name).toBe("wrapped")
    }
  })

  it("rejects non-literal meta", () => {
    const source = `
      const name = "dynamic"
      export const meta = { name }
      export async function run() {}
    `
    const result = MetaReader.read(source, "test.ts")
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("statically analyzable")
    }
  })

  it("rejects missing meta export", () => {
    const source = `export async function run() { return null }`
    const result = MetaReader.read(source, "test.ts")
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain("Missing meta")
    }
  })

  it("reads builtin deep-research workflow", () => {
    const source = BUILTIN_WORKFLOWS["deep-research"]
    const result = MetaReader.read(source, builtinPath("deep-research"))
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.meta.name).toBe("deep-research")
      expect(result.meta.phases).toHaveLength(4)
      expect(result.meta.arguments?.question?.type).toBe("string")
    }
  })
})

describe("workflow source-lint", () => {
  it("flags node:fs import", () => {
    const source = `import { readFileSync } from "fs"`
    const { findings } = SourceLint.lint(source, "test.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe("node-builtin-import")
  })

  it("flags dynamic import", () => {
    const source = `const mod = await import(someVar)`
    const { findings } = SourceLint.lint(source, "test.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe("dynamic-import")
  })

  it("flags fetch call", () => {
    const source = `const r = await fetch("https://example.com")`
    const { findings } = SourceLint.lint(source, "test.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe("fetch")
  })

  it("flags Bun.spawn", () => {
    const source = `Bun.spawn(["ls"])`
    const { findings } = SourceLint.lint(source, "test.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe("bun-api")
  })

  it("does not flag safe code", () => {
    const source = `
      export const meta = { name: "safe" }
      export async function run(args, ctx) {
        ctx.log("hello")
        return { ok: true }
      }
    `
    const { findings } = SourceLint.lint(source, "test.ts")
    expect(findings).toHaveLength(0)
  })
})

describe("workflow turn-budget", () => {
  it("make creates a pool with limits", () => {
    const pool = TurnBudget.make({ usd: 10, tokens: 1000 })
    expect(pool.usd).toEqual({ total: 10, committed: 0, reserved: 0 })
    expect(pool.tokens).toEqual({ total: 1000, committed: 0, reserved: 0 })
    expect(pool.steps).toBe(0)
  })

  it("reserve returns undefined when budget exhausted", () => {
    const pool = TurnBudget.make({ usd: 1 })
    const r1 = TurnBudget.reserve(pool, 1)
    expect(r1).toBeDefined()
    const r2 = TurnBudget.reserve(pool, 0.1)
    expect(r2).toBeUndefined()
  })

  it("settle commits actual spend and advances average", () => {
    const pool = TurnBudget.make({ usd: 100 })
    const r = TurnBudget.reserve(pool, 5)
    expect(r).toBeDefined()
    TurnBudget.settle(pool, r!, { usd: 3 })
    expect(pool.usd!.committed).toBe(3)
    expect(pool.usd!.reserved).toBe(0)
    expect(pool.steps).toBe(1)
    expect(pool.avgStepUsd).toBe(3)
  })

  it("chargeDirect commits without reservation", () => {
    const pool = TurnBudget.make({ usd: 100, tokens: 5000 })
    TurnBudget.chargeDirect(pool, { usd: 10, tokens: 500 })
    expect(pool.usd!.committed).toBe(10)
    expect(pool.tokens!.committed).toBe(500)
  })

  it("remaining accounts for committed and reserved", () => {
    const pool = TurnBudget.make({ usd: 100 })
    const r = TurnBudget.reserve(pool, 20)
    TurnBudget.settle(pool, r!, { usd: 5 })
    const rem = TurnBudget.remaining(pool)
    expect(rem.usd).toBe(95)
  })
})

describe("workflow builtin", () => {
  it("builtinPath prefixes name", () => {
    expect(builtinPath("test")).toBe("builtin:test")
  })

  it("isBuiltinPath detects prefix", () => {
    expect(isBuiltinPath("builtin:test")).toBe(true)
    expect(isBuiltinPath("test")).toBe(false)
  })

  it("inlinePath prefixes name", () => {
    expect(inlinePath("custom")).toBe("inline:custom")
  })

  it("isInlinePath detects prefix", () => {
    expect(isInlinePath("inline:custom")).toBe(true)
    expect(isInlinePath("custom")).toBe(false)
  })

  it("BUILTIN_WORKFLOWS has deep-research", () => {
    expect(BUILTIN_WORKFLOWS["deep-research"]).toBeDefined()
    expect(BUILTIN_WORKFLOWS["deep-research"]).toContain("deep-research")
  })
})

describe("workflow errors", () => {
  it("NotFoundError has name field", () => {
    const err = new NotFoundError({ name: "missing" })
    expect(err.name).toBe("missing")
    expect(err._tag).toBe("WorkflowNotFoundError")
  })

  it("InvalidError has path and message", () => {
    const err = new InvalidError({ path: "/test.ts", message: "bad" })
    expect(err.path).toBe("/test.ts")
    expect(err.message).toBe("bad")
  })

  it("BudgetExceededError has budget fields", () => {
    const err = new BudgetExceededError({ message: "done", budget: 10, spent: 10, unit: "usd" })
    expect(err.budget).toBe(10)
    expect(err.spent).toBe(10)
    expect(err.unit).toBe("usd")
  })

  it("CancelledError has _tag", () => {
    const err = new CancelledError()
    expect(err._tag).toBe("WorkflowCancelledError")
    expect(err.message).toBe("Workflow cancelled")
  })

  it("SaveConflictError has name and path", () => {
    const err = new SaveConflictError({ name: "test", path: "/test.ts" })
    expect(err.name).toBe("test")
    expect(err.path).toBe("/test.ts")
  })
})

describe("workflow parseStructured", () => {
  it("parses plain JSON", () => {
    const result = parseStructured('{"status":"ok","count":3}')
    expect(result).toEqual({ status: "ok", count: 3 })
  })

  it("parses JSON from a ```json code block", () => {
    const text = '```json\n{"status":"ok","items":[1,2,3]}\n```'
    const result = parseStructured(text)
    expect(result).toEqual({ status: "ok", items: [1, 2, 3] })
  })

  it("parses JSON from a bare ``` code block", () => {
    const text = '```\n{"status":"ok"}\n```'
    const result = parseStructured(text)
    expect(result).toEqual({ status: "ok" })
  })

  it("parses JSON surrounded by explanation text", () => {
    const text = 'Here are the audit results:\n{"status":"ok","issues":[]}\nThat is all.'
    const result = parseStructured(text)
    expect(result).toEqual({ status: "ok", issues: [] })
  })

  it("parses JSON with text before a code block", () => {
    const text = 'Here is the result:\n```json\n{"verdict":"pass"}\n```\nDone.'
    const result = parseStructured(text)
    expect(result).toEqual({ verdict: "pass" })
  })

  it("parses nested JSON objects", () => {
    const text = '{"outer":{"inner":"value","nested":{"deep":true}}}'
    const result = parseStructured(text)
    expect(result).toEqual({ outer: { inner: "value", nested: { deep: true } } })
  })

  it("parses JSON with arrays and numbers", () => {
    const text = '```json\n{"scores":[95,87,72],"average":84.67}\n```'
    const result = parseStructured(text)
    expect(result).toEqual({ scores: [95, 87, 72], average: 84.67 })
  })

  it("parses JSON with null and boolean values", () => {
    const text = '{"active":true,"error":null,"data":false}'
    const result = parseStructured(text)
    expect(result).toEqual({ active: true, error: null, data: false })
  })

  it("parses JSON with whitespace and newlines", () => {
    const text = '{\n  "status": "ok",\n  "count": 3\n}'
    const result = parseStructured(text)
    expect(result).toEqual({ status: "ok", count: 3 })
  })

  it("extracts JSON when mixed with markdown prose", () => {
    const text = [
      "## Audit Report",
      "",
      "The project looks healthy overall.",
      "",
      '```json',
      '{"verdict":"healthy","critical":[],"high":[],"low":["tidy up imports"]}',
      '```',
      "",
      "See above for details.",
    ].join("\n")
    const result = parseStructured(text)
    expect(result).toEqual({
      verdict: "healthy",
      critical: [],
      high: [],
      low: ["tidy up imports"],
    })
  })

  it("throws on text with no JSON", () => {
    expect(() => parseStructured("just plain text, no json here")).toThrow()
  })

  it("throws on empty string", () => {
    expect(() => parseStructured("")).toThrow()
  })

  it("throws on malformed JSON", () => {
    expect(() => parseStructured('{"broken":')).toThrow()
  })
})
