export default {
  meta: {
    name: "wf2-validate-resume",
    description: "Validate keyed journal resume",
    phases: ["run-agents", "check-cache"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("run-agents")
    
    const agents = await ctx.parallel([
      () => ctx.agent({
        prompt: 'Agent A: Return JSON with id 1 and value a. Provide detailed reasoning about caching and stable keys.',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-a"
      }),
      () => ctx.agent({
        prompt: 'Agent B: Return JSON with id 2 and value b. Explain caching stability.',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-b"
      }),
      () => ctx.agent({
        prompt: 'Agent C: Return JSON with id 3 and value c. Detailed analysis of keyed journal.',
        schema: { type: "object", required: ["id"], properties: { id: { type: "number" }, value: { type: "string" } } },
        label: "agent-c"
      }),
    ])
    
    const filtered = agents.filter(Boolean)
    if (filtered.length !== 3) {
      throw new Error(`Expected 3 agents, got ${filtered.length}`)
    }
    
    ctx.setPhase("check-cache", { agents: filtered.map((a: any) => a.data) })
    
    ctx.state.set("agentCount", filtered.length)
    
    return { success: true, agents: filtered.length, message: "wf2-validate-resume passed (single run)" }
  }
}
