export default {
  meta: {
    name: "test-flex",
    description: "Test workflow for flexibility - verifies all ctx methods",
    phases: ["init", "work", "verify", "done"],
    arguments: {
      message: { type: "string", default: "hello", description: "Test message" }
    },
    whenToUse: "When testing workflow flexibility"
  },
  async run(args, ctx) {
    ctx.setPhase("init")
    ctx.log("Starting test-flex with message: " + args.message)
    
    ctx.setPhase("work")
    ctx.log("Testing parallel execution")
    const results = await ctx.parallel([
      () => ctx.agent({ prompt: "Task 1", label: "task1" }),
      () => ctx.agent({ prompt: "Task 2", label: "task2" }),
      () => ctx.agent({ prompt: "Task 3", label: "task3" }),
    ])
    
    ctx.log(`Parallel results: ${results.length} completed`)
    
    ctx.setPhase("verify")
    ctx.log("Testing verification pattern")
    const verified = await ctx.parallel(
      results.map((r, i) => () => 
        ctx.agent({ 
          prompt: `Verify task ${i} result`, 
          label: `verify:${i}`,
          schema: { type: "object", required: ["supported"], properties: { supported: { type: "boolean" } } }
        }).then(v => ({ original: r, verified: v.data.supported }))
      )
    )
    
    ctx.setPhase("done")
    const surviving = verified.filter(v => v && v.verified)
    
    // Test child workflow, shell, tool
    await ctx.shell("echo 'test shell'")
    await ctx.tool("test-tool", { arg: "value" })
    
    return { 
      success: true, 
      message: "Flexible workflow works!", 
      args,
      phases: ["init", "work", "verify", "done"],
      verification: { total: results.length, verified: surviving.length },
      globalCompat: typeof (globalThis as any).agent === "function" ? "globals available" : "no globals"
    }
  }
}