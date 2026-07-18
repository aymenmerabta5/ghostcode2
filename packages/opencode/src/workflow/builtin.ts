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

    ctx.setPhase("plan")
    const plan = await ctx.agent({
      prompt: \`Break this research question into 3-5 distinct search angles. Question: \${question}. Respond ONLY via the schema.\`,
      schema: {
        type: "object",
        required: ["angles"],
        properties: { angles: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } } },
      },
      label: "plan"
    })

    ctx.setPhase("research")
    const findings = (await ctx.parallel(
      plan.data.angles.map((angle) => () =>
        ctx.agent({
          prompt: \`Research this angle using your available web/search tools. If NO web/search tools are available, return {"claims": [], "no_web_tools": true} via the schema. Angle: \${angle}\\nFull question: \${question}\\nReturn findings with source URLs via the schema.\`,
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
          label: \`research:\${angle.slice(0,30)}\`
        }),
      ),
    )).filter((f) => f !== null)
    if (findings.some((f) => (f.data as { no_web_tools?: boolean }).no_web_tools))
      throw new Error("deep-research requires web/search tools to be available to agents")

    const claims = findings.flatMap((f) => f.data.claims)

    ctx.setPhase("verify")
    const verified = (await ctx.parallel(
      claims.map((c) => () =>
        ctx
          .agent({
            prompt: \`Adversarially verify this claim against its sources (fetch them). Claim: \${c.claim}\\nSources: \${c.sources.join(", ")}\\nReply via schema: supported=true only if the sources actually back the claim.\`,
            schema: {
              type: "object",
              required: ["supported", "reason"],
              properties: { supported: { type: "boolean" }, reason: { type: "string" } },
            },
            label: \`verify:\${c.claim.slice(0,30)}\`
          })
          .then((v) => ({ ...c, verdict: v.data })),
      ),
      { concurrencyLimit: 8 },
    )).filter((v) => v !== null)
    const surviving = verified.filter((c) => c.verdict.supported)
    const rejected = verified.filter((c) => !c.verdict.supported)

    ctx.setPhase("synthesize")
    const report = await ctx.agent({
      prompt: \`Write a cited research report answering: \${question}\\nUse ONLY these verified claims (cite their sources inline): \${JSON.stringify(surviving)}\\nList rejected claims briefly at the end: \${JSON.stringify(rejected.map((r) => ({ claim: r.claim, reason: r.verdict.reason })))}\`,
      label: "synthesize"
    })

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
    ctx.setPhase("discover")
    const found = await ctx.agent({
      prompt: \`List every .ts file under \${dir} that looks like a route handler. Return {files: string[]}\`,
      schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      label: "discover"
    })

    ctx.setPhase("audit")
    const audits = (await ctx.parallel(
      found.data.files.map((file) => () =>
        ctx.agent({
          prompt: \`Audit \${file} for missing authentication checks. Look for handlers without auth middleware, missing permission checks. Return {file, issues: string[]}\`,
          schema: { type: "object", required: ["file","issues"], properties: { file:{type:"string"}, issues:{type:"array",items:{type:"string"}} } },
          label: file
        })
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    const flattened = audits.flatMap(a => a.data.issues.map(iss => ({ file: a.data.file, issue: iss })))

    ctx.setPhase("verify")
    const verified = (await ctx.parallel(
      flattened.map(item => () =>
        ctx.agent({
          prompt: \`Adversarially verify: Does \${item.file} really have issue "\${item.issue}"? Read the file, check auth. Reply {supported:boolean, reason:string}\`,
          schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
          label: \`verify:\${item.file}\`
        }).then(v => ({ ...item, verdict: v.data }))
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    const surviving = verified.filter(v => v.verdict.supported)
    const rejected = verified.filter(v => !v.verdict.supported)

    ctx.setPhase("report")
    const report = await ctx.agent({
      prompt: \`Write ranked security report from verified findings: \${JSON.stringify(surviving)}. Briefly list rejected as false positives: \${JSON.stringify(rejected)}. Group by severity.\`,
      label: "report"
    })

    return { report: report.text, verified: surviving.length, rejected: rejected.length, files: found.data.files.length }
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
      ctx.setPhase("check")
      const check = await ctx.agent({
        prompt: "Run npx tsc --noEmit or bun typecheck and report errors. Return {errors: string[], count: number}",
        schema: { type: "object", required: ["errors","count"], properties: { errors:{type:"array",items:{type:"string"}}, count:{type:"number"} } },
        label: \`check:\${attempts}\`
      })

      if (check.data.count === 0) {
        return { success: true, attempts, message: "Typecheck passes" }
      }

      if (check.data.count >= lastErrorCount) {
        ctx.log(\`No progress: \${check.data.count} errors vs \${lastErrorCount} previous\`)
        if (attempts >= 2) break
      }
      lastErrorCount = check.data.count

      ctx.setPhase("fix")
      await ctx.agent({
        prompt: \`Fix these type errors: \${JSON.stringify(check.data.errors.slice(0,10))}. Edit files to resolve.\`,
        label: \`fix:\${attempts}\`
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
`

const REVIEW_PR = `export default {
  meta: {
    name: "review-pr",
    description: "Review every changed file and write one ranked summary with verification",
    phases: ["discover", "review", "dedupe", "report"],
    whenToUse: "When reviewing PR changed files"
  },
  async run(args, ctx) {
    ctx.setPhase("discover")
    const changed = await ctx.agent({
      prompt: "List files changed in this branch vs main. Use git diff --name-only origin/main...HEAD. Return {files: string[]}",
      schema: { type: "object", required: ["files"], properties: { files:{type:"array",items:{type:"string"}} } },
      label: "discover-changed"
    })

    ctx.setPhase("review")
    const reviews = (await ctx.parallel(
      changed.data.files.map(file => () =>
        ctx.agent({
          prompt: \`Review \${file} for correctness issues, security, logic errors. Return {file, issues: [{severity:"low|medium|high", description:string}]}\`,
          schema: { type: "object", required:["file","issues"], properties:{ file:{type:"string"}, issues:{type:"array",items:{type:"object",required:["severity","description"],properties:{severity:{type:"string"},description:{type:"string"}}}} } },
          label: file
        })
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    ctx.setPhase("dedupe")
    const allIssues = reviews.flatMap(r => r.data.issues.map(i => ({ ...i, file: r.data.file })))
    const deduped = await ctx.agent({
      prompt: \`Deduplicate and rank these issues by severity and impact: \${JSON.stringify(allIssues)}. Return {issues: same shape sorted high->low}\`,
      schema: { type: "object", required:["issues"], properties:{ issues:{type:"array",items:{type:"object",required:["severity","description","file"],properties:{severity:{type:"string"},description:{type:"string"},file:{type:"string"}}}} } },
      label: "dedupe-rank"
    })

    ctx.setPhase("report")
    const report = await ctx.agent({
      prompt: \`Write one ranked summary from: \${JSON.stringify(deduped.data.issues)}. Group by severity, cite files.\`,
      label: "report"
    })

    return { report: report.text, files: changed.data.files.length, issues: deduped.data.issues.length }
  }
}
`

export const BUILTIN_WORKFLOWS: Record<string, string> = {
  "deep-research": DEEP_RESEARCH,
  "audit-auth": AUDIT_AUTH,
  "fix-typecheck": FIX_TYPECHECK,
  "review-pr": REVIEW_PR,
}
