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
    arguments: { question: { type: "string" } },
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
    })

    return { report: report.text, claims: { verified: surviving.length, rejected: rejected.length } }
  },
}
`

export const BUILTIN_WORKFLOWS: Record<string, string> = {
  "deep-research": DEEP_RESEARCH,
}
