export default {
  meta: {
    name: "fix-typecheck",
    description: "Run typecheck and keep fixing errors until it passes",
    phases: ["check", "fix", "verify"],
    whenToUse: "When typecheck fails and you want iterative fixing"
  },
  async run(_args: any, ctx: any) {
    let attempts = 0
    const maxAttempts = 5
    let lastErrorCount = Infinity

    while (attempts < maxAttempts) {
      ctx.setPhase("check")
      const check = await ctx.agent({
        prompt: "Run npx tsc --noEmit or bun typecheck and report errors. Return {errors: string[], count: number}",
        schema: { type: "object", required: ["errors", "count"], properties: { errors: { type: "array", items: { type: "string" } }, count: { type: "number" } } },
        label: `check:${attempts}`
      })

      if (check.data.count === 0) {
        return { success: true, attempts, message: "Typecheck passes" }
      }

      if (check.data.count >= lastErrorCount) {
        ctx.log(`No progress: ${check.data.count} errors vs ${lastErrorCount} previous`)
        if (attempts >= 2) break
      }
      lastErrorCount = check.data.count

      ctx.setPhase("fix")
      await ctx.agent({
        prompt: `Fix these type errors: ${JSON.stringify(check.data.errors.slice(0, 10))}. Edit files to resolve.`,
        label: `fix:${attempts}`
      })

      attempts++
    }

    ctx.setPhase("verify")
    const final = await ctx.agent({
      prompt: "Run typecheck one more time and summarize remaining errors",
      label: "final-check"
    })

    return { success: false, attempts, final: final.text }
  }
}
