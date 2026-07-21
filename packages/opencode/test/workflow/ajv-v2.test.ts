import { describe, expect, test } from "bun:test"
import { parseStructured } from "../../src/workflow/workflow"

describe("Workflows v2 - parseStructured + ajv validation", () => {
  test("valid JSON passes extraction", () => {
    const text = '{"ok":true, "count":5}'
    const data = parseStructured(text)
    expect(data).toEqual({ ok: true, count: 5 })
  })

  test("ajv validation - valid passes", async () => {
    const Ajv = (await import("ajv")).default
    const ajv = new Ajv({ allErrors: true })
    const schema = {
      type: "object",
      required: ["ok", "count"],
      properties: {
        ok: { type: "boolean" },
        count: { type: "number" }
      }
    }
    const validate = ajv.compile(schema)
    const valid = validate({ ok: true, count: 5 })
    expect(valid).toBe(true)
  })

  test("ajv validation - invalid fails with errors", async () => {
    const Ajv = (await import("ajv")).default
    const ajv = new Ajv({ allErrors: true })
    const schema = {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "number" }
      }
    }
    const validate = ajv.compile(schema)
    const valid = validate({ value: "not-a-number" })
    expect(valid).toBe(false)
    expect(validate.errors).toBeDefined()
    expect(validate.errors!.length).toBeGreaterThan(0)
    const errorText = validate.errors!.map(e => `${e.instancePath} ${e.message}`).join("; ")
    expect(errorText).toContain("must be number")
  })

  test("repair round-trip simulation", async () => {
    // Simulate extraction failure then repair
    const Ajv = (await import("ajv")).default
    const ajv = new Ajv({ allErrors: true })
    const schema = {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } }
    }
    const validate = ajv.compile(schema)

    let text = '{"value": "not-a-number"}'
    let data = parseStructured(text)
    let valid = validate(data)
    expect(valid).toBe(false)

    // Simulate repair: agent returns corrected JSON after being told validation failed
    const repairMsg = `Your output failed validation: ${validate.errors!.map(e => e.message).join(", ")}. Respond with ONLY corrected JSON.`
    expect(repairMsg).toContain("must be number")

    // Mock repaired output
    text = '{"value": 42}'
    data = parseStructured(text)
    valid = validate(data)
    expect(valid).toBe(true)
    expect((data as any).value).toBe(42)
  })

  test("StructuredOutputError after maxRepairs exhausted", () => {
    // Simulate that after maxRepairs, we throw StructuredOutputError
    // This is tested via workflow's agent method, but we can at least verify error class exists
    const { StructuredOutputError } = require("../../src/workflow/errors")
    const err = new StructuredOutputError({ message: "test" })
    expect(err.message).toBe("test")
  })
})

describe("Workflows v2 - budget and tool delegation placeholders", () => {
  test("tool() registry delegation placeholder", () => {
    // For M3, but we can test that meta.tools allowlist would be checked
    const meta = { tools: ["read", "glob"] }
    const toolName = "read"
    expect(meta.tools.includes(toolName)).toBe(true)
    expect(meta.tools.includes("write")).toBe(false)
  })
})
