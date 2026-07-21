export default {
  meta: {
    name: "wf2-validate-resume",
    description: "Validate keyed journal resume",
    phases: ["run-agents", "check-cache"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("run-agents")
    
    // Create N agents with stable labels - these should be cached on resume
    const agents = await ctx.parallel([
      () => ctx.agent({
        prompt: 'Reply with exactly: {"id":1, "value":"a"}',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-a"
      }),
      () => ctx.agent({
        prompt: 'Reply with exactly: {"id":2, "value":"b"}',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-b"
      }),
      () => ctx.agent({
        prompt: 'Reply with exactly: {"id":3, "value":"c"}',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-c"
      }),
    ])
    
    const filtered = agents.filter(Boolean)
    if (filtered.length !== 3) {
      throw new Error(`Expected 3 agents, got ${filtered.length}`)
    }
    
    ctx.setPhase("check-cache", { agents: filtered.map((a: any) => a.data) })
    
    // For direct runner without DB, we can't test actual resume, but we can test that cacheKey is stable
    // The real resume test will be done via server-based runner that checks cached:true
    // Here we just verify agents completed
    ctx.state.set("agentCount", filtered.length)
    
    return { success: true, agents: filtered.length, message: "wf2-validate-resume passed (single run)" }
  }
}
