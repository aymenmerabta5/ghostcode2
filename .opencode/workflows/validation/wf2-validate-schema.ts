export default {
  meta: {
    name: "wf2-validate-schema",
    description: "Validate schema-validated agent returns with ajv and repair - prose+JSON contract",
    phases: ["test", "verify"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("test", { start: true })
    
    // Test 1: valid schema should pass with prose+JSON
    const result1 = await ctx.agent({
      prompt: 'Analyze the task and return JSON with ok true and count 5. Provide detailed reasoning first.',
      schema: {
        type: "object",
        required: ["ok", "count"],
        properties: {
          ok: { type: "boolean" },
          count: { type: "number" }
        }
      },
      label: "valid-schema-test"
    })
    
    if (!result1 || !result1.data) throw new Error("valid-schema-test returned null")
    if ((result1.data as any).ok !== true || (result1.data as any).count !== 5) {
      throw new Error(`Valid schema test failed: ${JSON.stringify(result1.data)}`)
    }
    // Verify node.output preserves full prose (should contain prose + json fence)
    if (!result1.text || result1.text.length < 50) {
      throw new Error(`Expected detailed prose in text, got: ${result1.text.slice(0,200)}`)
    }
    if (!result1.text.includes("```json")) {
      throw new Error(`Expected fenced json block in output, got: ${result1.text.slice(0,500)}`)
    }
    
    // Test 2: repair - first return invalid string, then repair fixes to number
    const result2 = await ctx.agent({
      prompt: 'Return JSON with value as number. For testing repair, first return string "not-a-number" to trigger validation error, then repair should fix to 42.',
      schema: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "number" }
        }
      },
      label: "repair-test",
      maxRepairs: 1
    })
    
    if (!result2 || !result2.data) throw new Error("repair-test returned null, expected repaired value")
    if ((result2.data as any).value !== 42) {
      throw new Error(`Repair test failed, expected value 42 got ${JSON.stringify(result2.data)}`)
    }
    
    ctx.setPhase("verify", { result1: result1.data, result2: result2?.data })
    
    return { success: true, message: "wf2-validate-schema passed with prose+JSON", result1: result1.data }
  }
}
