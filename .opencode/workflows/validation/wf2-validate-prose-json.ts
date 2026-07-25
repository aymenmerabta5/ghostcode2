export default {
  meta: {
    name: "wf2-validate-prose-json",
    description: "Validate prose+JSON extraction: long prose + final json fence",
    phases: ["test"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("test")

    const result = await ctx.agent({
      prompt: `You are testing the new prose+JSON output contract. Provide a long detailed analysis with reasoning, evidence, caveats, and noteworthy observations. Be thorough, do not omit detail. Then end with a JSON block containing ok true and count 5. The JSON must be the last thing in your reply.

Your analysis should be at least 200 words, covering edge cases, performance, security, and include evidence. Then provide JSON.

Return JSON {ok: boolean, count: number} via fenced block.`,
      schema: {
        type: "object",
        required: ["ok", "count"],
        properties: {
          ok: { type: "boolean" },
          count: { type: "number" }
        }
      },
      label: "prose-json-test"
    })

    if (!result || !result.data) throw new Error("prose-json-test returned null")
    if ((result.data as any).ok !== true || (result.data as any).count !== 5) {
      throw new Error(`Expected ok true count 5, got ${JSON.stringify(result.data)}`)
    }

    // Verify node.output preserves full prose (should be long, contain prose + fence)
    const text = result.text ?? ""
    if (text.length < 200) {
      throw new Error(`Expected detailed prose in output, got short text length ${text.length}: ${text.slice(0,200)}`)
    }
    if (!text.includes("```json")) {
      throw new Error(`Expected fenced json block in output, got: ${text.slice(0,500)}`)
    }
    // Verify prose is before JSON fence (prose+JSON contract)
    const fenceIdx = text.lastIndexOf("```json")
    const prosePart = text.slice(0, fenceIdx)
    if (prosePart.length < 100) {
      throw new Error(`Prose part too short, expected detailed reasoning before JSON, got ${prosePart.length} chars`)
    }

    ctx.log(`Prose length: ${prosePart.length}, total: ${text.length}, data: ${JSON.stringify(result.data)}`)

    return { success: true, proseLength: prosePart.length, totalLength: text.length, data: result.data, message: "wf2-validate-prose-json passed" }
  }
}
