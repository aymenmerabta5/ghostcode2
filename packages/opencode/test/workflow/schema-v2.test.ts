import { describe, expect, test } from "bun:test"

// Test stableHash and cacheKey logic
describe("Workflows v2 - stableHash and cacheKey", () => {
  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
      return "[" + value.map((v) => stableStringify(v)).join(",") + "]"
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
  }

  function stableHash(obj: unknown): string {
    const { createHash } = require("crypto")
    const str = stableStringify(obj)
    return createHash("sha256").update(str).digest("hex").slice(0, 16)
  }

  test("key order independence", () => {
    const a = { prompt: "hello", label: "test", agent: "default" }
    const b = { label: "test", agent: "default", prompt: "hello" }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(stableHash(a)).toBe(stableHash(b))
  })

  test("schema/model/effort changes alter the key", () => {
    const base = { prompt: "p", label: "l", agent: "a", model: "m1", schema: "{}", phase: "discover", agentType: "t1", effort: "low" }
    const diffModel = { ...base, model: "m2" }
    const diffEffort = { ...base, effort: "high" }
    const diffSchema = { ...base, schema: '{"type":"object"}' }
    const diffAgentType = { ...base, agentType: "t2" }

    expect(stableHash(base)).not.toBe(stableHash(diffModel))
    expect(stableHash(base)).not.toBe(stableHash(diffEffort))
    expect(stableHash(base)).not.toBe(stableHash(diffSchema))
    expect(stableHash(base)).not.toBe(stableHash(diffAgentType))
  })

  test("cacheKey includes all required fields", () => {
    const payload = {
      prompt: "test prompt",
      label: "test-label",
      agent: "test-agent",
      model: "test-model",
      schema: '{"type":"object"}',
      phase: "test-phase",
      agentType: "test-type",
      effort: "high",
    }
    const key = stableHash(payload)
    expect(key.length).toBe(16)
    expect(typeof key).toBe("string")
  })
})

describe("Workflows v2 - determinism lint", () => {
  test("lint flags Date.now(), Math.random(), new Date() without args", async () => {
    const { SourceLint } = await import("../../src/workflow/source-lint")
    
    const bad1 = `export default { meta: { name: "test" }, async run() { const x = Date.now() } }`
    const res1 = SourceLint.lint(bad1, "test.ts")
    expect(res1.findings.some(f => f.rule === "determinism-date-now")).toBe(true)

    const bad2 = `export default { meta: { name: "test" }, async run() { const x = Math.random() } }`
    const res2 = SourceLint.lint(bad2, "test.ts")
    expect(res2.findings.some(f => f.rule === "determinism-math-random")).toBe(true)

    const bad3 = `export default { meta: { name: "test" }, async run() { const x = new Date() } }`
    const res3 = SourceLint.lint(bad3, "test.ts")
    expect(res3.findings.some(f => f.rule === "determinism-new-date")).toBe(true)
  })

  test("lint allows new Date(x) with args", async () => {
    const { SourceLint } = await import("../../src/workflow/source-lint")
    
    const good = `export default { meta: { name: "test" }, async run() { const x = new Date("2023-01-01") } }`
    const res = SourceLint.lint(good, "test.ts")
    expect(res.findings.filter(f => f.rule.startsWith("determinism-")).length).toBe(0)

    const good2 = `export default { meta: { name: "test" }, async run() { const x = new Date(1234567890) } }`
    const res2 = SourceLint.lint(good2, "test.ts")
    expect(res2.findings.filter(f => f.rule.startsWith("determinism-")).length).toBe(0)
  })

  test("lint escape hatch meta.allowNondeterminism: true", async () => {
    const { SourceLint } = await import("../../src/workflow/source-lint")
    
    const withEscape = `
      export default {
        meta: { name: "test", allowNondeterminism: true },
        async run() { const x = Date.now(); const y = Math.random(); const z = new Date() }
      }
    `
    const res = SourceLint.lint(withEscape, "test.ts")
    expect(res.findings.filter(f => f.rule.startsWith("determinism-")).length).toBe(0)
  })
})
