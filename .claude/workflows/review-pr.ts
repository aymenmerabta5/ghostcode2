export default {
  meta: {
    name: "review-pr",
    description: "Review every changed file and write one ranked summary with verification",
    phases: ["discover", "review", "dedupe", "report"],
    whenToUse: "When reviewing PR changed files"
  },
  async run(_args: any, ctx: any) {
    ctx.setPhase("discover")
    const changed = await ctx.agent({
      prompt: "List files changed in this branch vs main. Use git diff --name-only origin/main...HEAD. Return {files: string[]}",
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "discover-changed"
    })

    ctx.setPhase("review")
    const reviews = (await ctx.parallel(
      changed.data.files.map((file: string) => () =>
        ctx.agent({
          prompt: `Review ${file} for correctness issues, security, logic errors. Return {file, issues: [{severity:"low|medium|high", description:string}]}`,
          schema: {
            type: "object",
            required: ["file", "issues"],
            properties: {
              file: { type: "string" },
              issues: { type: "array", items: { type: "object", required: ["severity", "description"], properties: { severity: { type: "string" }, description: { type: "string" } } } }
            }
          },
          label: file
        })
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    ctx.setPhase("dedupe")
    const allIssues = reviews.flatMap((r: any) => r.data.issues.map((i: any) => ({ ...i, file: r.data.file })))
    const deduped = await ctx.agent({
      prompt: `Deduplicate and rank these issues by severity and impact: ${JSON.stringify(allIssues)}. Return {issues: same shape sorted high->low}`,
      schema: {
        type: "object",
        required: ["issues"],
        properties: {
          issues: { type: "array", items: { type: "object", required: ["severity", "description", "file"], properties: { severity: { type: "string" }, description: { type: "string" }, file: { type: "string" } } } }
        }
      },
      label: "dedupe-rank"
    })

    ctx.setPhase("report")
    const report = await ctx.agent({
      prompt: `Write one ranked summary from: ${JSON.stringify(deduped.data.issues)}. Group by severity, cite files.`,
      label: "report"
    })

    return { report: report.text, files: changed.data.files.length, issues: deduped.data.issues.length }
  }
}
