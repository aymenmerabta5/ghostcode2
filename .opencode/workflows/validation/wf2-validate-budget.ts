export default {
  meta: {
    name: "wf2-validate-budget",
    description: "Validate budget atomicity",
    phases: ["test"],
    arguments: {
      budget: { type: "number", default: 0.01, description: "Tight budget" }
    }
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("test")
    
    const budget = args.budget ?? 0.01
    let budgetExceeded = false
    let completedCount = 0
    
    try {
      const tasks = Array.from({ length: 10 }, (_, i) => () => 
        ctx.agent({
          prompt: `Task ${i} - Provide detailed analysis of budget tracking for task ${i}, then return JSON with task number ${i}.`,
          label: `budget-agent-${i}`,
          schema: { type: "object", required: ["task"], properties: { task: { type: "number" } } }
        }).then(r => {
          if (r) completedCount++
          return r
        })
      )
      
      const results = await ctx.parallel(tasks, { concurrencyLimit: 5 })
      
      const spent = ctx.budget.spent()
      const remaining = ctx.budget.remaining()
      
      if (spent > budget + 0.5) {
        throw new Error(`Budget exceeded: spent ${spent} > budget ${budget}`)
      }
      
      if (remaining < -0.5) {
        throw new Error(`Budget remaining negative: ${remaining}`)
      }
      
    } catch (e: any) {
      const msg = e.message ?? String(e)
      if (msg.includes("budget") || msg.includes("BudgetExceeded") || e._tag === "WorkflowBudgetExceededError") {
        budgetExceeded = true
        const spent = ctx.budget.spent()
        if (spent > budget + 1) {
          throw new Error(`Budget exceeded even after error: spent ${spent} > budget ${budget}`)
        }
      } else {
        throw e
      }
    }
    
    const finalSpent = ctx.budget.spent()
    const finalRemaining = ctx.budget.remaining()
    
    if (finalSpent < 0) throw new Error(`Final spent negative: ${finalSpent}`)
    if (finalRemaining < -0.5) throw new Error(`Final remaining negative: ${finalRemaining}`)
    
    return { 
      success: true, 
      budgetExceeded, 
      completedCount, 
      spent: finalSpent, 
      remaining: finalRemaining,
      message: "wf2-validate-budget passed" 
    }
  }
}
