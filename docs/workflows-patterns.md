# Workflows Patterns

This document demonstrates the Workflows v2 patterns with runnable snippets.

## Adversarial Verify (>=2 refuters kill a finding)

A finding survives only if >=2 verifiers support it. Each verifier tries to refute.

```ts
export default {
  meta: { name: "adversarial-verify", phases: ["discover", "verify", "report"] },
  async run(args, ctx) {
    ctx.setPhase("discover", { target: "src/routes" })
    const findings = await ctx.agent({
      prompt: `Find auth issues in src/routes. Return {issues: string[]}`,
      schema: { type: "object", required: ["issues"], properties: { issues: { type: "array", items: { type: "string" } } } },
      label: "discover"
    })

    ctx.setPhase("verify")
    const flattened = (findings.data as any).issues.map((issue: string, i: number) => ({ id: i, issue }))
    const verified = (await ctx.parallel(
      flattened.map(item => () =>
        ctx.parallel([0,1,2].map(lens => () =>
          ctx.agent({
            prompt: `Adversarially verify (lens ${lens}): Does issue "${item.issue}" really exist? Try to REFUTE it. Reply {supported:boolean}`,
            schema: { type: "object", required: ["supported"], properties: { supported: { type: "boolean" } } },
            label: `verify:${item.id}:${lens}`,
            effort: "max"
          })
        )).then(votes => {
          const supported = votes.filter(Boolean).filter((v: any) => v.data.supported).length
          return { ...item, supported: supported >= 2, votes }
        })
      )
    )).filter(Boolean)

    ctx.setPhase("report", { verified: verified.filter((v: any) => v.supported).length })
    return { verified }
  }
}
```

## Perspective-Diverse Verify

Each verifier gets a distinct lens (correctness, security, perf, reproducibility).

```ts
const lenses = ["correctness", "security", "performance", "reproducibility"]
const verified = await ctx.parallel(
  claims.map(c => () =>
    ctx.parallel(lenses.map(lens => () =>
      ctx.agent({
        prompt: `Verify from ${lens} perspective: ${c.claim}. Reply {supported:boolean, reason:string}`,
        schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
        label: `verify:${c.id}:${lens}`,
        effort: "max"
      })
    )).then(vs => ({ ...c, perspectives: vs }))
  )
)
```

## Judge Panel

N independent solutions from different angles, then a judge scores.

```ts
ctx.setPhase("solve")
const solutions = await ctx.parallel([
  () => ctx.agent({ prompt: "Solve MVP-first", label: "solve:mvp", effort: "max" }),
  () => ctx.agent({ prompt: "Solve risk-first", label: "solve:risk", effort: "max" }),
  () => ctx.agent({ prompt: "Solve perf-first", label: "solve:perf", effort: "max" }),
])

ctx.setPhase("judge")
const judged = await ctx.agent({
  prompt: `Judge these solutions: ${JSON.stringify(solutions.map(s=>s?.text))}. Score and synthesize best. Return {winner: number, report: string}`,
  schema: { type: "object", required: ["winner","report"], properties: { winner:{type:"number"}, report:{type:"string"} } },
  label: "judge",
  effort: "max"
})
```

## Loop-Until-Dry

Keep running discovery/fix rounds until 2 consecutive rounds produce nothing new.

```ts
let attempts = 0
let lastCount = Infinity
let dryRounds = 0

while (attempts < 10 && dryRounds < 2) {
  ctx.setPhase("discover", { attempt: attempts })
  const found = await ctx.agent({
    prompt: `Find issues round ${attempts}. Return {issues: string[], count: number}`,
    schema: { type: "object", required: ["count"], properties: { count:{type:"number"}, issues:{type:"array",items:{type:"string"}} } },
    label: `discover:${attempts}`
  })

  const count = (found.data as any).count
  if (count === 0) dryRounds++
  else dryRounds = 0

  if (count >= lastCount && attempts >= 2) break
  lastCount = count

  ctx.setPhase("fix", { count })
  await ctx.agent({ prompt: `Fix ${count} issues`, label: `fix:${attempts}` })
  attempts++
}
```

## Loop-Until-Budget

Run until budget nearly exhausted, with reservation checking.

```ts
ctx.setPhase("work")
while (ctx.budget.remaining() > 0.01) {
  const result = await ctx.agent({
    prompt: `Do work, budget remaining ${ctx.budget.remaining()}`,
    label: `work:${ctx.budget.spent()}`,
    effort: "high"
  })
  if (!result) break
}
```

## Multi-Modal Sweep

Parallel agents search same target by different methods.

```ts
const [byFile, byContent, byEntity, byHistory] = await ctx.parallel([
  () => ctx.agent({ prompt: "Search by file name for auth", label: "sweep:by-file" }),
  () => ctx.agent({ prompt: "Search by content grep for auth", label: "sweep:by-content" }),
  () => ctx.agent({ prompt: "Search by entity for auth handlers", label: "sweep:by-entity" }),
  () => ctx.agent({ prompt: "Search by git history for auth changes", label: "sweep:by-history" }),
])
```

## Completeness Critic

Final agent asks "what's missing?" before report.

```ts
ctx.setPhase("critic")
const critic = await ctx.agent({
  prompt: `Completeness critic: given findings ${JSON.stringify(findings)}, what is MISSING? What did we overlook?`,
  label: "completeness-critic",
  effort: "max"
})

ctx.setPhase("report", { gaps: critic.text })
const report = await ctx.agent({
  prompt: `Write report from ${JSON.stringify(findings)}. Append gaps: ${critic.text}`,
  label: "report",
  effort: "max"
})
```

## Determinism Rules

- `Date.now()`, `Math.random()`, `new Date()` without args are BLOCKING errors in source lint.
- They break resume caching because cache key would be non-deterministic.
- Pass seeds/timestamps via args or compute inside an agent.
- Escape hatch: `meta.allowNondeterminism: true` if truly needed.

```ts
// BAD - will be rejected by lint
export default {
  meta: { name: "bad", phases: ["work"] },
  async run(args, ctx) {
    const now = Date.now() // BLOCKING
    const r = Math.random() // BLOCKING
    const d = new Date() // BLOCKING
  }
}

// GOOD - deterministic
export default {
  meta: { name: "good", phases: ["work"], arguments: { seed: { type: "number" } } },
  async run(args, ctx) {
    const seed = args.seed ?? 42
    ctx.setPhase("work", { seed })
    // Compute nondeterministic values inside agent
    const result = await ctx.agent({
      prompt: `Generate random with seed ${seed}. Return {value: number}`,
      schema: { type: "object", required: ["value"], properties: { value: { type: "number" } } },
      label: "random-with-seed"
    })
  }
}
```

## Resume / Invalidation Model

- `cacheKey = stableHash({ prompt, label, agent, model, schema, phase, agentType, effort })`
- Changing model/effort invalidates cache for that agent.
- Replay by KEY, not position: reordering/inserting/removing agent() calls is safe.
- Invalidation: `invalidate_agents` accepts labels OR cache keys
- `invalidatePhase(name)` sugar invalidates every key under that phase
- `allowNondeterminism` escape hatch for scripts that need Date.now() etc.

```ts
// Resume: first run
// opencode --workflow my-workflow
// Second run with resume - replays cached agents
// opencode --workflow my-workflow --args '{"resume_of":"job_abc123"}'

// Invalidate specific label
// opencode --workflow my-workflow --args '{"resume_of":"job_abc123","invalidate_agents":["agent-a"]}'

// Invalidate by phase
export default {
  meta: { name: "example", phases: ["discover","verify"] },
  async run(args, ctx) {
    // ... agents ...
    ctx.invalidatePhase("discover") // all discover agents will re-run on next resume
  }
}
```

## State and Phase Data

```ts
ctx.setPhase("discover", { files: ["a.ts", "b.ts"] }) // persisted + frozen
const files = ctx.getPhase("discover") as { files: string[] }
const all = ctx.getAllPhases() // { discover: {...}, verify: {...} }

ctx.state.set("counter", 1)
ctx.state.get("counter") // frozen copy
ctx.state.has("counter")
ctx.state.delete("counter")
ctx.state.entries() // [ ["counter",1], ... ]
ctx.state.toObject() // { counter:1, ... }
```

## DECORRELATED REVIEW LENSES

Verification requires >=3 lenses that differ in INPUT, not just persona — lens 1 sees finding + actual artifact/file; lens 2 sees the worker's output ONLY (no source context); lens 3 uses a different model or adversarial persona. Survive on >=2.

```ts
export default {
  meta: { name: "decorrelated-lenses", phases: ["discover", "verify", "report"] },
  async run(args, ctx) {
    ctx.setPhase("discover", { target: "src/routes" })
    const findings = await ctx.agent({
      prompt: `Find 2 auth issues in src/routes. Return {issues: [{file: string, issue: string, artifact: string}]}`,
      schema: { type: "object", required: ["issues"], properties: { issues: { type: "array", items: { type: "object", required: ["file","issue","artifact"], properties: { file:{type:"string"}, issue:{type:"string"}, artifact:{type:"string"} } } } } },
      label: "discover"
    })
    const issues = (findings.data as any).issues ?? []

    ctx.setPhase("verify", { count: issues.length })
    const verified = (await ctx.parallel(
      issues.map((it: any, idx: number) => () =>
        ctx.parallel([
          // Lens 1: finding + actual artifact/file — sees file content and issue
          () => ctx.agent({
            prompt: `Lens 1 (correctness, sees file + issue): Does file ${it.file} really have issue "${it.issue}"? Artifact: ${it.artifact}. Check artifact content. Reply {supported:boolean, reason:string}`,
            schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
            label: `verify:${idx}:lens1`,
            effort: "max"
          }),
          // Lens 2: worker's output ONLY, no source context — sees only issue text
          () => ctx.agent({
            prompt: `Lens 2 (output-only, no source): Evaluate this security claim on its own merits, no file context: "${it.issue}". Is it a valid security concern in general? Reply {supported:boolean, reason:string}`,
            schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
            label: `verify:${idx}:lens2`,
            effort: "max"
          }),
          // Lens 3: different model or adversarial persona — adversarial refuter
          () => ctx.agent({
            prompt: `Lens 3 (adversarial, try to REFUTE): Claim "${it.issue}" in ${it.file}. Try to prove it's NOT a real issue. Adversarial mindset. Reply {supported:boolean, reason:string}`,
            schema: { type: "object", required: ["supported","reason"], properties: { supported:{type:"boolean"}, reason:{type:"string"} } },
            label: `verify:${idx}:lens3`,
            model: "anthropic/claude-3-5-sonnet",
            effort: "max"
          }),
        ]).then(votes => {
          const valid = votes.filter(Boolean).map((v: any) => v.data)
          const supportedCount = valid.filter((v: any) => v.supported).length
          return { ...it, votes: valid, supported: supportedCount >= 2 }
        })
      ),
      { concurrencyLimit: 8 }
    )).filter(Boolean)

    const surviving = verified.filter((v: any) => v.supported)
    ctx.setPhase("report", { verified: surviving.length })
    return { verified: surviving }
  }
}
```

## SPLIT-BRAIN RULE

All shared design decisions are made once in the plan phase, stored in the setPhase payload, and passed verbatim into worker prompts. Worker prompts must contain the line "Decide nothing; if the spec is ambiguous, return the ambiguity in your output instead of choosing." Parallel workers NEVER decide shared conventions.

```ts
export default {
  meta: { name: "split-brain", phases: ["plan", "execute", "report"] },
  async run(args, ctx) {
    ctx.setPhase("plan", { start: true })
    const plan = await ctx.agent({
      prompt: `Make all shared design decisions for refactoring: naming convention, error handling, file structure. Return {conventions: {naming: string, errors: string, structure: string}, example: string}`,
      schema: { type: "object", required: ["conventions","example"], properties: { conventions:{type:"object",required:["naming","errors","structure"],properties:{naming:{type:"string"},errors:{type:"string"},structure:{type:"string"}}}, example:{type:"string"} } },
      label: "plan",
      effort: "max"
    })
    const conventions = (plan.data as any).conventions
    const example = (plan.data as any).example

    ctx.setPhase("execute", { conventions, example })
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"]
    const results = await ctx.parallel(
      files.map(f => () =>
        ctx.agent({
          prompt: `Refactor ${f} using these shared conventions (verbatim, do not reinterpret): ${JSON.stringify(conventions)}. Worked example: ${example}. Decide nothing; if the spec is ambiguous, return the ambiguity in your output instead of choosing. Return {file, result, ambiguity?: string}`,
          schema: { type: "object", required: ["file","result"], properties: { file:{type:"string"}, result:{type:"string"}, ambiguity:{type:"string"} } },
          label: `refactor:${f}`,
          effort: "max"
        })
      ),
      { concurrencyLimit: 8 }
    )

    ctx.setPhase("report", { count: results.filter(Boolean).length })
    return { conventions, results }
  }
}
```

## SPEC-COLLAPSE (planner/worker)

Frontier planner at effort max emits an explicit, ambiguity-free spec with a worked example; workers receive only their slice + the example.

```ts
export default {
  meta: { name: "spec-collapse", phases: ["plan", "execute", "verify"] },
  async run(args, ctx) {
    ctx.setPhase("plan", { start: true })
    const specAgent = await ctx.agent({
      prompt: `You are frontier planner at effort max. Emit an explicit, ambiguity-free spec for implementing auth middleware. Include: exact function signatures, error codes, a worked example with input/output. No ambiguity. Return {spec: string, example: {input: string, output: string}}`,
      schema: { type: "object", required: ["spec","example"], properties: { spec:{type:"string"}, example:{type:"object",required:["input","output"],properties:{input:{type:"string"},output:{type:"string"}}} } },
      label: "planner",
      effort: "max"
    })
    const spec = (specAgent.data as any).spec
    const example = (specAgent.data as any).example

    ctx.setPhase("execute", { spec, example })
    const slices = ["route /api/users", "route /api/posts", "route /api/comments"]
    const workers = await ctx.parallel(
      slices.map(slice => () =>
        ctx.agent({
          prompt: `Implement slice: ${slice}. Use ONLY this spec (verbatim): ${spec}. Worked example: input=${example.input} output=${example.output}. Do not deviate, do not add features. Return {slice, code}`,
          schema: { type: "object", required: ["slice","code"], properties: { slice:{type:"string"}, code:{type:"string"} } },
          label: `worker:${slice}`,
          effort: "max"
        })
      ),
      { concurrencyLimit: 8 }
    )

    ctx.setPhase("verify", { count: workers.filter(Boolean).length })
    return { spec, workers }
  }
}
```

## FIELD GUIDE USAGE

Workers get a `surprises: string[]` schema field; script appends non-empty surprises via ctx.guide.append(); add a curation agent step when the guide nears maxLines.

```ts
export default {
  meta: { name: "field-guide-usage", phases: ["discover", "audit", "curate", "report"], guide: { maxLines: 20 } },
  async run(args, ctx) {
    ctx.setPhase("discover", { start: true })
    const files = await ctx.agent({
      prompt: `List ts files under src/routes. Return {files: string[]}`,
      schema: { type: "object", required: ["files"], properties: { files:{type:"array",items:{type:"string"}} } },
      label: "discover"
    })
    const fileList = (files.data as any).files ?? []

    ctx.setPhase("audit", { count: fileList.length })
    const audits = await ctx.parallel(
      fileList.map((f: string) => () =>
        ctx.agent({
          prompt: `Audit ${f} for auth issues. Return {file, issues: string[], surprises: string[]}. Surprises are unexpected learnings about codebase that future agents should know.`,
          schema: { type: "object", required: ["file","issues","surprises"], properties: { file:{type:"string"}, issues:{type:"array",items:{type:"string"}}, surprises:{type:"array",items:{type:"string"}} } },
          label: `audit:${f}`,
          effort: "max"
        }).then(res => {
          if (res) {
            const data = res.data as any
            const surprises = Array.isArray(data?.surprises) ? data.surprises : []
            for (const s of surprises) {
              if (typeof s === "string" && s.trim()) {
                try { ctx.guide.append(s) } catch (e: any) {
                  // If guide full, trigger curation
                  ctx.log(`Guide full, need curation: ${e.message}`)
                }
              }
            }
          }
          return res
        })
      ),
      { concurrencyLimit: 8 }
    )

    // Curation agent when guide nears maxLines
    if (ctx.guide.lines().length >= 15) {
      ctx.setPhase("curate", { guideSize: ctx.guide.lines().length })
      const curated = await ctx.agent({
        prompt: `Compact this field guide from ${ctx.guide.lines().length} to 10 lines, preserving most important learnings. Current guide: ${JSON.stringify(ctx.guide.lines())}. Return {lines: string[]}`,
        schema: { type: "object", required: ["lines"], properties: { lines:{type:"array",items:{type:"string"}} } },
        label: "curate-guide",
        effort: "max"
      })
      if (curated) {
        const newLines = (curated.data as any).lines
        if (Array.isArray(newLines)) ctx.guide.set(newLines)
      }
    }

    ctx.setPhase("report", { guide: ctx.guide.lines() })
    return { audits: audits.filter(Boolean).length, guide: ctx.guide.lines() }
  }
}
```

## SECOND-CHANCE SWEEP

onError:"null" + collect nulls + one retry pass (cached successes replay free), then report items that failed twice.

```ts
export default {
  meta: { name: "second-chance-sweep", phases: ["first-pass", "retry", "report"] },
  async run(args, ctx) {
    const items = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]

    ctx.setPhase("first-pass", { count: items.length })
    const firstPass = await ctx.parallel(
      items.map(f => () =>
        ctx.agent({
          prompt: `Audit ${f} for issues. Return {file, issues: string[]}`,
          schema: { type: "object", required: ["file","issues"], properties: { file:{type:"string"}, issues:{type:"array",items:{type:"string"}} } },
          label: `audit:${f}`,
          effort: "max",
          onError: "null"
        })
      ),
      { concurrencyLimit: 8 }
    )

    const succeeded = firstPass.filter(Boolean) as any[]
    const failedItems = items.filter((_, idx) => firstPass[idx] === null)

    ctx.setPhase("retry", { failed: failedItems.length, succeeded: succeeded.length })
    let secondPass: any[] = []
    let stillFailed: string[] = []
    if (failedItems.length > 0) {
      const retryResults = await ctx.parallel(
        failedItems.map(f => () =>
          ctx.agent({
            prompt: `Retry audit ${f} for issues. Return {file, issues: string[]}`,
            schema: { type: "object", required: ["file","issues"], properties: { file:{type:"string"}, issues:{type:"array",items:{type:"string"}} } },
            label: `audit:${f}`,
            effort: "max",
            onError: "null"
          })
        ),
        { concurrencyLimit: 8 }
      )
      secondPass = retryResults.filter(Boolean)
      stillFailed = failedItems.filter((_, idx) => retryResults[idx] === null)
      // Cached successes replay free — first pass succeeded items are cached and don't cost again
    }

    ctx.setPhase("report", { first: succeeded.length, second: secondPass.length, stillFailed: stillFailed.length })
    return { succeeded: succeeded.length + secondPass.length, failedTwice: stillFailed }
  }
}
```

## MEGAFILE GUARD + LICENSED BREAKAGE

Code workflows: workers flag bloated files for a dedicated decomposition agent; a scoped out-of-spec fix is allowed only with an explanatory comment at the change site so downstream agents self-correct from build errors.

```ts
export default {
  meta: { name: "megafile-guard", phases: ["audit", "decompose", "fix", "verify"] },
  async run(args, ctx) {
    ctx.setPhase("audit", { start: true })
    const files = await ctx.agent({
      prompt: `List ts files and their line counts under src/. Return {files: [{path: string, lines: number}]}`,
      schema: { type: "object", required: ["files"], properties: { files:{type:"array",items:{type:"object",required:["path","lines"],properties:{path:{type:"string"},lines:{type:"number"}}}} } },
      label: "list-files",
      effort: "max"
    })
    const fileList = (files.data as any).files ?? []
    const bloated = fileList.filter((f: any) => f.lines > 500)

    ctx.setPhase("decompose", { bloated: bloated.length })
    if (bloated.length > 0) {
      const decomposition = await ctx.agent({
        prompt: `Decompose these bloated files (>${500} lines) into smaller modules: ${JSON.stringify(bloated)}. Return {plan: string}`,
        schema: { type: "object", required: ["plan"], properties: { plan:{type:"string"} } },
        label: "decompose-plan",
        effort: "max"
      })
      ctx.log(`Decomposition plan: ${decomposition?.text?.slice(0,200)}`)
    }

    ctx.setPhase("fix", { start: true })
    const fixes = await ctx.parallel(
      fileList.slice(0,5).map((f: any) => () =>
        ctx.agent({
          prompt: `Fix issues in ${f.path}. If you need to fix out-of-spec bloated file, you may do a scoped fix ONLY with explanatory comment at change site: // LICENSED BREAKAGE: <reason> - allows downstream agents to self-correct from build errors. Return {file, fixed: boolean}`,
          schema: { type: "object", required: ["file","fixed"], properties: { file:{type:"string"}, fixed:{type:"boolean"} } },
          label: `fix:${f.path}`,
          effort: "max"
        })
      ),
      { concurrencyLimit: 8 }
    )

    ctx.setPhase("verify", { fixed: fixes.filter(Boolean).length })
    return { bloated: bloated.length, fixes: fixes.filter(Boolean).length }
  }
}
```

## Worktree Merge (onConflict: "agent")

Extend ctx.mergeWorktree with opts.onConflict: "error" | "agent" (default "error"). "agent" spawns a neutral merge agent that resolves impartially, preserves BOTH intents.

```ts
export default {
  meta: { name: "worktree-merge-agent", phases: ["parallel-edit", "merge", "verify"] },
  async run(args, ctx) {
    ctx.setPhase("parallel-edit", { start: true })
    const agents = await ctx.parallel([
      () => ctx.agent({
        prompt: `Edit file.txt with Intent A. Return {branch, intent}`,
        schema: { type: "object", required: ["branch","intent"], properties: { branch:{type:"string"}, intent:{type:"string"} } },
        label: "edit-a",
        isolation: "worktree",
        effort: "max"
      }),
      () => ctx.agent({
        prompt: `Edit file.txt with Intent B. Return {branch, intent}`,
        schema: { type: "object", required: ["branch","intent"], properties: { branch:{type:"string"}, intent:{type:"string"} } },
        label: "edit-b",
        isolation: "worktree",
        effort: "max"
      }),
    ])

    ctx.setPhase("merge", { branches: agents.filter(Boolean).length })
    // Merge with neutral agent on conflict
    const result = await ctx.mergeWorktree({ branch: "wf/job_abc/edit-a" }, { onConflict: "agent", model: "anthropic/claude-3-5-sonnet" })
    // result.merged === true, merge agent row visible as merge:<sourceLabel> in inspect
    // If still conflicting -> throws MergeConflictError listing files

    ctx.setPhase("verify", { merged: result.merged })
    return { merged: result.merged }
  }
}
```

## Field Guide and Cache Interaction

Field Guide is run-scoped, agent-authored context injected into every subsequent agent.

- API: ctx.guide.append(line), ctx.guide.lines(), ctx.guide.set(lines)
- Line budget: meta.guide?.maxLines (default 50)
- Injection: every ctx.agent prompt gets preamble "## FIELD GUIDE (learnings from earlier agents in this run — read before working)\\n- <line>..."
- CRITICAL — guide content is NOT part of cacheKey. Inject the guide AFTER cache-key computation, outside the keyed prompt. Rationale: guide grows during run; if it keyed cache, every resume would invalidate every agent.
- Resume: cached agents replay regardless of guide changes; the guide is advisory. On resume, reconstruct guide state by replaying journal entries in order.
- Persistence: guide column (JSON array) on run row, journal entries kind "guide:append"/"guide:set", included in export bundle.

```ts
export default {
  meta: { name: "guide-cache-note", phases: ["first", "second"], guide: { maxLines: 10 } },
  async run(args, ctx) {
    ctx.guide.append("Never use Date.now() in workflow source, compute inside agent")
    ctx.setPhase("first", { guide: ctx.guide.lines() })

    const a = await ctx.agent({
      prompt: `Do work. Return {ok: boolean}`,
      schema: { type: "object", required: ["ok"], properties: { ok:{type:"boolean"} } },
      label: "worker-a"
    })

    // Guide grows, but cached agents replay regardless of guide changes; guide is advisory
    ctx.guide.append("Use ctx.tool for real file reads, not Bun.file directly in LLM")

    ctx.setPhase("second", { guide: ctx.guide.lines() })
    const b = await ctx.agent({
      prompt: `Do more work, you should have field guide in preamble. Return {ok: boolean}`,
      schema: { type: "object", required: ["ok"], properties: { ok:{type:"boolean"} } },
      label: "worker-b"
    })

    return { guide: ctx.guide.lines(), a, b }
  }
}
```
