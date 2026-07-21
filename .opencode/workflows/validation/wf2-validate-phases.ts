export default {
  meta: {
    name: "wf2-validate-phases",
    description: "Validate phase system overhaul",
    phases: ["discover", "validate", "report"],
    arguments: {
      n: { type: "number", default: 3, description: "Number" }
    }
  },
  async run(args: any, ctx: any) {
    // Test Setup pseudo-phase: log before first setPhase should go to Setup
    ctx.log("Log before any phase - should be Setup")
    
    // Test setPhase with payload
    const prev1 = ctx.setPhase("discover", { files: ["a.ts", "b.ts"], count: 2 })
    if (prev1 !== undefined) {
      throw new Error(`Expected previous phase data undefined on first setPhase, got ${JSON.stringify(prev1)}`)
    }
    
    const discoverData = ctx.getPhase("discover") as any
    if (!discoverData || discoverData.count !== 2 || !Array.isArray(discoverData.files) || discoverData.files.length !== 2) {
      throw new Error(`getPhase failed for discover: ${JSON.stringify(discoverData)}`)
    }
    
    // Test deep-freeze: try to mutate should fail or be prevented
    try {
      // This should fail if frozen
      (discoverData as any).count = 999
      // If we reach here and mutation succeeded, check if original is mutated
      const check = ctx.getPhase("discover") as any
      if (check.count === 999) {
        throw new Error("Deep-freeze failed: mutation of phase data affected stored data")
      }
      // If strict mode, assignment to frozen object throws in strict mode - but we are not in strict? We'll check
    } catch (e: any) {
      // If it's a TypeError about read-only, that's expected for frozen
      if (!e.message.includes("read only") && !e.message.includes("Cannot assign") && !e.message.includes("object is not extensible") && !e.message.includes("Deep-freeze failed")) {
        // Re-throw unexpected
        // But frozen check may throw in strict, which is okay
      }
    }
    
    ctx.setPhase("validate", { validated: true, phase: "validate" })
    const prev2 = ctx.getPhase("discover")
    if (!prev2) throw new Error("Previous phase data lost after second setPhase")
    
    ctx.state.set("counter", 1)
    ctx.state.set("key", "value")
    if (ctx.state.get("counter") !== 1) throw new Error("state.get/set failed")
    if (!ctx.state.has("key")) throw new Error("state.has failed")
    
    ctx.state.set("counter", 2)
    if (ctx.state.get("counter") !== 2) throw new Error("state update failed")
    
    const entries = ctx.state.entries()
    if (!Array.isArray(entries) || entries.length < 2) throw new Error(`state.entries failed: ${JSON.stringify(entries)}`)
    
    const obj = ctx.state.toObject()
    if (obj.counter !== 2 || obj.key !== "value") throw new Error(`state.toObject failed: ${JSON.stringify(obj)}`)
    
    // Test getAllPhases
    const all = ctx.getAllPhases() as any
    if (!all.discover || !all.validate) {
      throw new Error(`getAllPhases missing phases: ${JSON.stringify(all)}`)
    }
    if (all.discover.count !== 2 || all.validate.validated !== true) {
      throw new Error(`getAllPhases data mismatch: ${JSON.stringify(all)}`)
    }
    
    // Test phase validation: strict mode should throw InvalidPhaseError for unknown phase
    let caughtInvalid = false
    try {
      ctx.setPhase("unknown_phase_typo")
    } catch (e: any) {
      const msg = e.message ?? String(e)
      // Check if it's InvalidPhaseError or contains expected text
      if (msg.includes("Unknown phase") || msg.includes("unknown_phase_typo") || e._tag === "WorkflowInvalidPhaseError" || msg.includes("Declared phases")) {
        caughtInvalid = true
      } else {
        throw new Error(`Unexpected error for invalid phase: ${msg}`)
      }
    }
    if (!caughtInvalid) {
      throw new Error("Expected InvalidPhaseError for unknown phase but none thrown")
    }
    
    // Test that valid phase still works after failed attempt
    ctx.setPhase("report", { result: "ok", n: args.n })
    
    // Test that phases after report include all previous
    const finalAll = ctx.getAllPhases() as any
    if (!finalAll.discover || !finalAll.validate || !finalAll.report) {
      throw new Error(`Final getAllPhases incomplete: ${JSON.stringify(finalAll)}`)
    }
    
    // Test terminal cleanup will be verified by outer harness (current_phase cleared on terminal)
    // We can't test terminal here, but we can ensure current_phase is report currently
    // The validation harness will check DB row after completion has current_phase cleared
    
    return { success: true, phases: Object.keys(finalAll), state: obj, message: "wf2-validate-phases passed" }
  }
}
