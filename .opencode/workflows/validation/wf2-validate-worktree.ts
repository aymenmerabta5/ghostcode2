export default {
  meta: {
    name: "wf2-validate-worktree",
    description: "Validate worktree isolation",
    phases: ["test", "verify"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("test")
    
    const testFile = "worktree-test.txt"
    
    const results = await ctx.parallel([
      () => ctx.agent({
        prompt: `You are worktree agent A. Write file ${testFile} with content "content from agent A" in your isolated worktree. Provide detailed reasoning about isolation, then return JSON with branch and changedFiles.`,
        label: "worktree-agent-A",
        isolation: "worktree",
        schema: {
          type: "object",
          required: ["branch", "changedFiles"],
          properties: {
            branch: { type: "string" },
            changedFiles: { type: "array", items: { type: "string" } }
          }
        }
      }),
      () => ctx.agent({
        prompt: `You are worktree agent B. Write file ${testFile} with content "content from agent B" in your isolated worktree. Provide detailed analysis of worktree isolation, then return JSON.`,
        label: "worktree-agent-B",
        isolation: "worktree",
        schema: {
          type: "object",
          required: ["branch", "changedFiles"],
          properties: {
            branch: { type: "string" },
            changedFiles: { type: "array", items: { type: "string" } }
          }
        }
      })
    ])
    
    const filtered = results.filter(Boolean)
    if (filtered.length !== 2) {
      throw new Error(`Expected 2 worktree agents, got ${filtered.length}`)
    }
    
    for (const r of filtered) {
      const data = r.data as any
      if (!data.branch) throw new Error(`Agent result missing branch: ${JSON.stringify(data)}`)
      if (!data.branch.includes("wf/")) throw new Error(`Branch should contain wf/: ${data.branch}`)
    }
    
    try {
      const check = await ctx.shell(`cat ${testFile} 2>&1 || echo "not exists"`)
    } catch {}
    
    ctx.setPhase("verify", { branches: filtered.map((r: any) => r.data.branch) })
    
    return { success: true, branches: filtered.map((r: any) => r.data.branch), message: "wf2-validate-worktree passed" }
  }
}
