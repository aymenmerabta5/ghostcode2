export const BUILTIN_PATH_PREFIX = "builtin:"

export function builtinPath(name: string) {
  return `${BUILTIN_PATH_PREFIX}${name}`
}

export function isBuiltinPath(path: string) {
  return path.startsWith(BUILTIN_PATH_PREFIX)
}

export const INLINE_PATH_PREFIX = "inline:"

export function inlinePath(name: string) {
  return `${INLINE_PATH_PREFIX}${name}`
}

export function isInlinePath(path: string) {
  return path.startsWith(INLINE_PATH_PREFIX)
}

const DEEP_RESEARCH = `export default {
  meta: {
    name: "deep-research",
    description: "Research a question across angles with adversarial claim verification",
    phases: ["plan", "research", "verify", "synthesize"],
    arguments: { question: { type: "string", description: "Research question" } },
    whenToUse: "When you need to research a question across many sources with cross-checked citations"
  },
  async run(args, ctx) {
    const question = String(args.question ?? "")
    if (!question) throw new Error("deep-research needs args.question")

    ctx.setPhase("plan", { question })
    const plan = await ctx.agent({
      prompt: \`Break this research question into 3-5 distinct search angles. Question: \${question}. Respond ONLY via the schema.\`,
      schema: {
        type: "object",
        required: ["angles"],
        properties: { angles: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } } },
      },
      label: "plan",
      effort: "max"
    })
    if (!plan) throw new Error("deep-research: plan agent failed to return result (check previous agent logs for parse errors)")
    const angles = (plan.data as any)?.angles
    if (!Array.isArray(angles) || angles.length === 0) throw new Error("deep-research: plan returned invalid data, expected {angles: string[]}")

    ctx.setPhase("research", { plan: angles })
    const findingsRaw = await ctx.parallel(
      angles.map((angle, idx) => {
        const safeAngle = String(angle ?? "")
        return () =>
          ctx.agent({
            prompt: \`Research this angle using your available web/search tools. If NO web/search tools are available, return {"claims": [], "no_web_tools": true} via the schema. Angle: \${safeAngle}\\nFull question: \${question}\\nReturn findings with source URLs via the schema.\`,
            schema: {
              type: "object",
              required: ["claims"],
              properties: {
                claims: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["claim", "sources"],
                    properties: {
                      claim: { type: "string" },
                      sources: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                no_web_tools: { type: "boolean" },
              },
            },
            label: \`research:\${idx}:\${safeAngle.slice(0,20)}\`,
            effort: "max"
          })
      }),
    )
    const findings = (findingsRaw as any[]).filter((f) => f !== null)
    if (findings.length === 0) throw new Error("deep-research: all research agents failed")
    if (findings.some((f) => (f.data as { no_web_tools?: boolean })?.no_web_tools))
      throw new Error("deep-research requires web/search tools to be available to agents")

    const claims = findings.flatMap((f) => {
      const c = (f.data as any)?.claims
      return Array.isArray(c) ? c.filter((x: any) => x && typeof x.claim === "string") : []
    })

    ctx.setPhase("verify", { claims: claims.length })
    // Adversarial verify with 3 lenses per claim, survive on >=2 support
    const verifiedRaw = await ctx.parallel(
      claims.map((c, claimIdx) => {
        const claimStr = String((c as any)?.claim ?? "")
        const sourcesArr = Array.isArray((c as any)?.sources) ? (c as any).sources : []
        return () =>
          ctx.parallel([0,1,2].map(lens => () =>
            ctx.agent({
              prompt: \`Adversarially verify (lens \${lens}: \${["correctness","exploitability","reproduction"][lens]}): does claim "\${claimStr}" hold against sources \${sourcesArr.join(", ")}? Try to REFUTE it. Reply {supported:boolean, reason:string}\`,
              schema: {
                type: "object",
                required: ["supported", "reason"],
                properties: { supported: { type: "boolean" }, reason: { type: "string" } },
              },
              label: \`verify:\${claimIdx}:\${lens}\`,
              effort: "max"
            })
          )).then(votes => {
            const validVotes = votes.filter(Boolean).map((v: any) => v.data)
            const supportedCount = validVotes.filter((v: any) => v.supported).length
            return { ...c, votes: validVotes, supported: supportedCount >= 2 }
          })
      }),
      { concurrencyLimit: 8 },
    )
    const verified = (verifiedRaw as any[]).filter((v) => v !== null)
    const surviving = verified.filter((c: any) => c.supported)
    const rejected = verified.filter((c: any) => !c.supported)

    ctx.setPhase("synthesize", { verified: surviving.length, rejected: rejected.length })
    const critic = await ctx.agent({
      prompt: \`Completeness critic: for question "\${question}" and verified claims \${JSON.stringify(surviving.slice(0,5))}, what is MISSING? What did the research likely overlook?\`,
      label: "completeness-critic",
      effort: "max"
    })
    const planData = ctx.getPhase("plan")
    const report = await ctx.agent({
      prompt: \`Write a cited research report answering: \${question}\\nPlan was: \${JSON.stringify(planData)}\\nUse ONLY these verified claims (cite their sources inline): \${JSON.stringify(surviving)}\\nGaps from critic: \${critic?.text ?? "none"}\\nList rejected claims briefly at the end: \${JSON.stringify(rejected.map((r: any) => ({ claim: r.claim, reason: r.votes?.[0]?.reason })))}\`,
      label: "synthesize",
      effort: "max"
    })
    if (!report) throw new Error("deep-research: synthesize agent failed")

    return { report: report.text, claims: { verified: surviving.length, rejected: rejected.length } }
  },
}
`

const AUDIT_AUTH = `export default {
  meta: {
    name: "audit-auth",
    description: "Audit route handlers for missing authentication checks with adversarial verification",
    phases: ["discover", "audit", "verify", "report"],
    arguments: { dir: { type: "string", default: "src/routes", description: "Directory to audit" } },
    whenToUse: "When auditing API endpoints for missing auth"
  },
  async run(args, ctx) {
    const dir = String(args.dir ?? "src/routes")
    ctx.setPhase("discover", { dir })
    const found = await ctx.agent({
      prompt: \`List every .ts file under \${dir} that looks like a route handler. Return {files: string[]}\`,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "discover",
      effort: "max"
    })
    if (!found) throw new Error("audit-auth: discover failed")
    const files = (found.data as any)?.files ?? []
    if (!Array.isArray(files)) throw new Error("audit-auth: invalid files")

    ctx.setPhase("audit", { fileCount: files.length, dir })
    const auditsRaw = await ctx.parallel(
      files.map((file) => {
        const safeFile = String(file ?? "unknown")
        return () =>
          ctx.agent({
            prompt: \`Audit \${safeFile} for missing authentication checks. Return {file, issues: string[]}\`,
            schema: { type: "object", required: ["file","issues"], properties: { file:{type:"string"}, issues:{type:"array",items:{type:"string"}} } },
            label: \`audit:\${safeFile}\`,
            effort: "max"
          })
      }),
      { concurrencyLimit: 8 }
    )
    const audits = (auditsRaw as any[]).filter(Boolean)

    const flattened = audits.flatMap(a => {
      const data = (a.data as any) ?? {}
      const f = String(data.file ?? "unknown")
      const issues = Array.isArray(data.issues) ? data.issues : []
      return issues.filter((iss: any) => typeof iss === "string").map((iss: string) => ({ file: f, issue: iss }))
    })

    const discoverData = ctx.getPhase("discover")
    ctx.setPhase("verify", { issueCount: flattened.length, discover: discoverData })
    const verifiedRaw = await ctx.parallel(
      flattened.map((item, idx) => {
        const safeFile = String(item.file ?? "unknown")
        const safeIssue = String(item.issue ?? "")
        return () =>
          ctx.agent({
            prompt: \`Adversarially verify: Does \${safeFile} really have issue "\${safeIssue}"? Reply {supported:boolean, reason:string}\`,
            schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
            label: \`verify:\${idx}:\${safeFile}\`,
            effort: "max"
          }).then(v => v ? ({ ...item, verdict: v.data }) : null)
      }),
      { concurrencyLimit: 8 }
    )
    const verified = (verifiedRaw as any[]).filter(Boolean)
    const surviving = verified.filter(v => v.verdict?.supported)
    const rejected = verified.filter(v => !v.verdict?.supported)

    ctx.setPhase("report", { verified: surviving.length, rejected: rejected.length, files: files.length })
    const report = await ctx.agent({
      prompt: \`Write ranked security report from verified findings: \${JSON.stringify(surviving)}. Rejected: \${JSON.stringify(rejected)}. Group by severity.\`,
      label: "report",
      effort: "max"
    })
    if (!report) throw new Error("audit-auth: report failed")

    return { report: report.text, verified: surviving.length, rejected: rejected.length, files: files.length }
  }
}
`

const FIX_TYPECHECK = `export default {
  meta: {
    name: "fix-typecheck",
    description: "Run typecheck and keep fixing errors until it passes",
    phases: ["check", "fix", "verify"],
    whenToUse: "When you need to fix type errors iteratively"
  },
  async run(args, ctx) {
    let attempts = 0
    const maxAttempts = 5
    let lastErrorCount = Infinity

    while (attempts < maxAttempts) {
      ctx.setPhase("check", { attempt: attempts, lastCount: lastErrorCount })
      const check = await ctx.agent({
        prompt: "Run npx tsc --noEmit or bun typecheck and report errors. Return {errors: string[], count: number}",
        schema: { type: "object", required: ["errors","count"], properties: { errors:{type:"array",items:{type:"string"}}, count:{type:"number"} } },
        label: \`check:\${attempts}\`,
        effort: "max"
      })
      if (!check) {
        ctx.log(\`check \${attempts} null\`)
        attempts++
        continue
      }
      const count = (check.data as any)?.count
      const errors = (check.data as any)?.errors
      if (typeof count !== "number") throw new Error("fix-typecheck: invalid count")
      if (count === 0) {
        return { success: true, attempts, message: "Typecheck passes" }
      }
      if (count >= lastErrorCount) {
        ctx.log(\`No progress: \${count} vs \${lastErrorCount}\`)
        if (attempts >= 2) break
      }
      lastErrorCount = count

      ctx.setPhase("fix", { attempt: attempts, errorCount: count, sample: Array.isArray(errors) ? errors.slice(0,3) : [] })
      const safeErrors = Array.isArray(errors) ? errors : []
      const fixRes = await ctx.agent({
        prompt: \`Fix these type errors: \${JSON.stringify(safeErrors.slice(0,10))}. Edit files to resolve.\`,
        label: \`fix:\${attempts}\`,
        effort: "max"
      })
      if (!fixRes) ctx.log(\`fix \${attempts} null\`)

      attempts++
    }

    ctx.setPhase("verify", { attempts, lastErrorCount })
    const final = await ctx.agent({
      prompt: "Run typecheck one more time and summarize remaining errors",
      label: "final-check",
      effort: "max"
    })
    if (!final) throw new Error("fix-typecheck: final failed")

    return { success: false, attempts, final: final.text }
  }
}
`

const REVIEW_PR = `export default {
  meta: {
    name: "review-pr",
    description: "Review every changed file and write one ranked summary with verification",
    phases: ["discover", "review", "dedupe", "report"],
    whenToUse: "When reviewing PR changed files"
  },
  async run(args, ctx) {
    ctx.setPhase("discover", { start: true })
    const changed = await ctx.agent({
      prompt: "List files changed in this branch vs main. Use git diff --name-only origin/main...HEAD. Return {files: string[]}",
      schema: { type: "object", required: ["files"], properties: { files:{type:"array",items:{type:"string"}} } },
      label: "discover-changed",
      effort: "max"
    })
    if (!changed) throw new Error("review-pr: discover failed")
    const changedFiles = (changed.data as any)?.files
    if (!Array.isArray(changedFiles)) throw new Error("review-pr: invalid files")

    ctx.setPhase("review", { changedCount: changedFiles.length })
    const reviewsRaw = await ctx.parallel(
      changedFiles.map(file => {
        const safeFile = String(file ?? "unknown")
        return () =>
          ctx.agent({
            prompt: \`Review \${safeFile} for correctness issues. Return {file, issues: [{severity:"low|medium|high", description:string}]}\`,
            schema: { type: "object", required:["file","issues"], properties:{ file:{type:"string"}, issues:{type:"array",items:{type:"object",required:["severity","description"],properties:{severity:{type:"string"},description:{type:"string"}}}} } },
            label: \`review:\${safeFile}\`,
            effort: "max"
          })
      }),
      { concurrencyLimit: 8 }
    )
    const reviews = (reviewsRaw as any[]).filter(Boolean)

    const allIssues = reviews.flatMap(r => {
      const data = (r.data as any) ?? {}
      const file = String(data.file ?? "unknown")
      const issues = Array.isArray(data.issues) ? data.issues : []
      return issues.map((i: any) => ({ ...i, file }))
    })
    const discoverData = ctx.getPhase("discover")
    ctx.setPhase("dedupe", { issueCount: allIssues.length, discover: discoverData })
    const deduped = await ctx.agent({
      prompt: \`Deduplicate and rank these issues by severity: \${JSON.stringify(allIssues)}. Return {issues: same shape sorted high->low}\`,
      schema: { type: "object", required:["issues"], properties:{ issues:{type:"array",items:{type:"object",required:["severity","description","file"],properties:{severity:{type:"string"},description:{type:"string"},file:{type:"string"}}}} } },
      label: "dedupe-rank",
      effort: "max"
    })
    if (!deduped) throw new Error("review-pr: dedupe failed")
    const dedupedIssues = (deduped.data as any)?.issues ?? []
    if (!Array.isArray(dedupedIssues)) throw new Error("review-pr: invalid deduped")

    ctx.setPhase("report", { finalIssueCount: dedupedIssues.length, files: changedFiles.length })
    const report = await ctx.agent({
      prompt: \`Write one ranked summary from: \${JSON.stringify(dedupedIssues)}. Group by severity, cite files.\`,
      label: "report",
      effort: "max"
    })
    if (!report) throw new Error("review-pr: report failed")

    return { report: report.text, files: changedFiles.length, issues: dedupedIssues.length }
  }
}
`

export const BUILTIN_WORKFLOWS: Record<string, string> = {
  "deep-research": DEEP_RESEARCH,
  "audit-auth": AUDIT_AUTH,
  "fix-typecheck": FIX_TYPECHECK,
  "review-pr": REVIEW_PR,
}
