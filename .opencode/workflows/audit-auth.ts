export default {
  meta: {
    name: "audit-auth",
    description: "Audit route handlers for missing auth with verification agents",
    phases: ["discover", "audit", "verify", "report"],
    arguments: {
      dir: { type: "string", default: "src/routes", description: "Directory to audit" }
    },
    whenToUse: "When auditing API routes for auth"
  },
  async run(args: any, ctx: any) {
    const dir = String(args.dir ?? "src/routes")
    ctx.setPhase("discover")
    const found = await ctx.agent({
      prompt: `List every .ts file under ${dir} that looks like a route handler. Return {files: string[]}`,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "discover"
    })

    ctx.setPhase("audit")
    const audits = (await ctx.parallel(
      found.data.files.map((file: string) => () =>
        ctx.agent({
          prompt: `Audit ${file} for missing authentication checks. Return {file, issues: string[]}`,
          schema: { type: "object", required: ["file", "issues"], properties: { file: { type: "string" }, issues: { type: "array", items: { type: "string" } } } },
          label: file
        })
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    const flattened = audits.flatMap((a: any) => a.data.issues.map((iss: string) => ({ file: a.data.file, issue: iss })))

    ctx.setPhase("verify")
    const verified = (await ctx.parallel(
      flattened.map((item: any) => () =>
        ctx.agent({
          prompt: `Adversarially verify: Does ${item.file} really have issue "${item.issue}"? Read file, check auth. Reply {supported:boolean, reason:string}`,
          schema: { type: "object", required: ["supported", "reason"], properties: { supported: { type: "boolean" }, reason: { type: "string" } } },
          label: `verify:${item.file}`
        }).then((v: any) => ({ ...item, verdict: v.data }))
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    const surviving = verified.filter((v: any) => v.verdict.supported)
    const rejected = verified.filter((v: any) => !v.verdict.supported)

    ctx.setPhase("report")
    const report = await ctx.agent({
      prompt: `Write ranked security report from verified findings: ${JSON.stringify(surviving)}. Briefly list rejected as false positives: ${JSON.stringify(rejected)}. Group by severity.`,
      label: "report"
    })

    return { report: report.text, verified: surviving.length, rejected: rejected.length, files: found.data.files.length }
  }
}
