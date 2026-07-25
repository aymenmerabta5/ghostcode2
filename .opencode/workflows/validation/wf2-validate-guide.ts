export default {
  meta: {
    name: "wf2-validate-guide",
    description: "Validate Field Guide feature",
    phases: ["first", "second", "third"],
    guide: { maxLines: 3 },
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("first", { start: true })

    ctx.guide.append("SENTINEL_123")
    let lines = ctx.guide.lines() as string[]
    if (lines.length !== 1 || lines[0] !== "SENTINEL_123") {
      throw new Error(`append failed: ${JSON.stringify(lines)}`)
    }

    ctx.guide.append("SENTINEL_123")
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 1) {
      throw new Error(`dedupe failed, expected 1 got ${lines.length}: ${JSON.stringify(lines)}`)
    }

    ctx.guide.set([])
    ctx.guide.append("a\nb")
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 2 || !lines.includes("a") || !lines.includes("b")) {
      throw new Error(`split failed: ${JSON.stringify(lines)}`)
    }

    ctx.guide.set(["x", "y", "z"])
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 3 || lines[0] !== "x") {
      throw new Error(`set failed: ${JSON.stringify(lines)}`)
    }

    try {
      ;(lines as any).push("should fail")
      const check = ctx.guide.lines()
      if ((check as any).length !== 3) {
        throw new Error("lines() should be frozen copy, mutation affected stored guide")
      }
    } catch (e: any) {}

    let caught = false
    try {
      ctx.guide.append("overflow")
    } catch (e: any) {
      const msg = e.message ?? String(e)
      if (msg.includes("Guide full") || msg.includes("maxLines") || e._tag === "WorkflowGuideFullError") {
        caught = true
        if (!msg.includes("curation") && !msg.includes("set()")) {
          throw new Error(`GuideFullError hint missing curation hint: ${msg}`)
        }
      } else {
        throw new Error(`Unexpected error for overflow: ${msg}`)
      }
    }
    if (!caught) {
      throw new Error("Expected GuideFullError when exceeding maxLines")
    }

    caught = false
    try {
      ctx.guide.set(["1", "2", "3", "4"])
    } catch (e: any) {
      caught = true
    }
    if (!caught) {
      throw new Error("Expected GuideFullError on set over budget")
    }

    ctx.guide.set(["SENTINEL_123"])

    ctx.setPhase("second", { guide: ctx.guide.lines() })

    const agent2 = await ctx.agent({
      prompt: `You have a field guide in your preamble. Echo it back with detailed analysis proving injection works, then return JSON with guide field containing sentinel. Provide thorough reasoning about guide functionality.`,
      schema: {
        type: "object",
        required: ["guide"],
        properties: { guide: { type: "string" } },
      },
      label: "echo-guide",
      effort: "low",
    })
    if (!agent2) throw new Error("echo-guide agent failed")
    const guideOut = (agent2.data as any)?.guide ?? ""
    if (!String(guideOut).includes("SENTINEL_123")) {
      throw new Error(`Injection failed: sentinel not in agent output ${JSON.stringify(agent2.data)} text=${agent2.text.slice(0,200)}`)
    }

    ctx.setPhase("third", { secondDone: true })

    ctx.guide.set([])
    ctx.guide.append("  trimmed  ")
    lines = ctx.guide.lines() as string[]
    if (lines[0] !== "trimmed") {
      throw new Error(`trim failed: ${JSON.stringify(lines)}`)
    }
    ctx.guide.append("   ")
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 1) {
      throw new Error(`empty rejection failed: ${JSON.stringify(lines)}`)
    }

    ctx.guide.set(["SENTINEL_123", "final-line"])

    return { success: true, guide: ctx.guide.lines(), message: "wf2-validate-guide passed" }
  },
}
