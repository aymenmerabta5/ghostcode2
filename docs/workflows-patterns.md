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
