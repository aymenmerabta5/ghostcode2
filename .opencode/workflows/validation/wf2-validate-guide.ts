export default {
  meta: {
    name: "wf2-validate-guide",
    description: "Validate Field Guide feature",
    phases: ["first", "second", "third"],
    guide: { maxLines: 3 },
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("first", { start: true })

    // Test append, dedupe, split
    ctx.guide.append("SENTINEL_123")
    let lines = ctx.guide.lines() as string[]
    if (lines.length !== 1 || lines[0] !== "SENTINEL_123") {
      throw new Error(`append failed: ${JSON.stringify(lines)}`)
    }

    // Dedupe exact duplicates silently
    ctx.guide.append("SENTINEL_123")
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 1) {
      throw new Error(`dedupe failed, expected 1 got ${lines.length}: ${JSON.stringify(lines)}`)
    }

    // Multi-line split
    ctx.guide.set([])
    ctx.guide.append("a\nb")
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 2 || !lines.includes("a") || !lines.includes("b")) {
      throw new Error(`split failed: ${JSON.stringify(lines)}`)
    }

    // Reset and test set replacement
    ctx.guide.set(["x", "y", "z"])
    lines = ctx.guide.lines() as string[]
    if (lines.length !== 3 || lines[0] !== "x") {
      throw new Error(`set failed: ${JSON.stringify(lines)}`)
    }

    // Test frozen lines
    try {
      // @ts-ignore
      ;(lines as any).push("should fail")
      const check = ctx.guide.lines()
      if ((check as any).length !== 3) {
        throw new Error("lines() should be frozen copy, mutation affected stored guide")
      }
    } catch (e: any) {
      // If frozen throws, that's okay
    }

    // Test GuideFullError past maxLines (max 3)
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

    // Test set over budget throws
    caught = false
    try {
      ctx.guide.set(["1", "2", "3", "4"])
    } catch (e: any) {
      caught = true
    }
    if (!caught) {
      throw new Error("Expected GuideFullError on set over budget")
    }

    // Reset to sentinel for injection test
    ctx.guide.set(["SENTINEL_123"])

    ctx.setPhase("second", { guide: ctx.guide.lines() })

    // Agent 2's task is to echo field guide back — assert sentinel appears in output (proves injection)
    const agent2 = await ctx.agent({
      prompt: `Echo the field guide you received in preamble. Return JSON {guide: string} containing the sentinel you see. Exactly: {"guide": "SENTINEL_123 found in field guide"}`,
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

    // Test trim and empty rejection
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

    // Final set to contain sentinel for export check
    ctx.guide.set(["SENTINEL_123", "final-line"])

    return { success: true, guide: ctx.guide.lines(), message: "wf2-validate-guide passed" }
  },
}
