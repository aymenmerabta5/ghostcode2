export default {
  meta: {
    name: "wf2-validate-merge-agent",
    description: "Validate neutral merge agent for worktree conflicts",
    phases: ["setup", "parallel-edit", "merge", "verify", "unresolvable"],
  },
  async run(args: any, ctx: any) {
    ctx.setPhase("setup", { start: true })

    const check = await ctx.shell("git rev-parse --is-inside-work-tree")
    if (check.exitCode !== 0) {
      throw new Error("Not a git checkout, cannot test worktree merge")
    }

    const sh = async (cmd: string) => {
      const res = await ctx.shell(cmd)
      if (res.exitCode !== 0) {
        throw new Error(`Command failed (exit ${res.exitCode}): ${cmd}\n${res.output.slice(0, 500)}`)
      }
      return res
    }

    const testFile = "merge-agent-test-file.txt"
    const branches = {
      a: "wf/merge-agent-test-a",
      b: "wf/merge-agent-test-b",
      failA: "wf/should-fail-a",
      failB: "wf/should-fail-b",
    }

    await ctx.shell("git merge --abort").catch(() => {})
    await sh("git checkout dev")
    for (const br of Object.values(branches)) {
      await ctx.shell(`git branch -D ${br}`).catch(() => {})
    }

    await sh(`echo initial content > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m reset-merge-agent-test-file --allow-empty`)

    ctx.setPhase("parallel-edit", { file: testFile })

    const agents = await ctx.parallel([
      () =>
        ctx.agent({
          prompt: `You are worktree agent A. Provide detailed reasoning about worktree isolation, then return JSON with branch, changedFiles, intent A.`,
          schema: {
            type: "object",
            required: ["branch", "changedFiles", "intent"],
            properties: {
              branch: { type: "string" },
              changedFiles: { type: "array", items: { type: "string" } },
              intent: { type: "string" },
            },
          },
          label: "worktree-intent-a",
          isolation: "worktree",
          effort: "low",
        }),
      () =>
        ctx.agent({
          prompt: `You are worktree agent B. Provide detailed analysis of isolation, then return JSON with branch, changedFiles, intent B.`,
          schema: {
            type: "object",
            required: ["branch", "changedFiles", "intent"],
            properties: {
              branch: { type: "string" },
              changedFiles: { type: "array", items: { type: "string" } },
              intent: { type: "string" },
            },
          },
          label: "worktree-intent-b",
          isolation: "worktree",
          effort: "low",
        }),
    ])

    const results = agents.filter(Boolean) as any[]
    if (results.length < 2) {
      throw new Error(`Expected 2 worktree agents, got ${results.length}`)
    }

    ctx.setPhase("merge", { branches: results.length })

    await sh("git checkout dev")
    await ctx.shell(`git branch -D ${branches.a}`).catch(() => {})
    await sh(`git checkout -b ${branches.a}`)
    await sh(`echo Intent A - alpha change > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m intent-a --allow-empty`)

    await sh("git checkout dev")
    await ctx.shell(`git branch -D ${branches.b}`).catch(() => {})
    await sh(`git checkout -b ${branches.b}`)
    await sh(`echo Intent B - beta change > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m intent-b --allow-empty`)

    await sh("git checkout dev")

    await sh(`git merge --ff-only ${branches.a}`)

    let afterFirst: any
    try {
      afterFirst = await ctx.tool("read", { path: testFile })
      ctx.log(`After first merge: ${String(afterFirst.output).slice(0, 200)}`)
    } catch {}

    let secondMergeSuccess = false
    let mergeAgentRow: any = null
    try {
      const res = await ctx.mergeWorktree({ branch: branches.b }, { onConflict: "agent" })
      secondMergeSuccess = true
      ctx.log(`Second merge with agent succeeded: ${JSON.stringify(res)}`)
    } catch (e: any) {
      ctx.log(`Second merge threw: ${(e.message ?? String(e)).slice(0, 500)}`)
      throw new Error(`Merge with agent should succeed but threw: ${e.message}`)
    }

    ctx.setPhase("verify", { secondMergeSuccess })

    let finalContent = ""
    try {
      const finalRead = await ctx.tool("read", { path: testFile })
      finalContent = String(finalRead.output)
    } catch (e: any) {
      throw new Error(`Failed to read final file: ${e.message}`)
    }

    if (!finalContent.includes("Intent A") || !finalContent.includes("Intent B")) {
      throw new Error(`Final file does not contain BOTH intents: got "${finalContent.slice(0, 500)}"`)
    }

    // Check no conflict markers
    if (finalContent.includes("<<<<<<<") || finalContent.includes(">>>>>>>") || finalContent.includes("=======")) {
      throw new Error(`Final file still contains conflict markers: ${finalContent.slice(0, 500)}`)
    }

    // Check no back-to-back duplicated blocks (simple heuristic: same line repeated twice consecutively)
    const lines = finalContent.split("\n").map((l: string) => l.trim()).filter(Boolean)
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] && lines[i] === lines[i + 1] && lines[i].includes("Intent")) {
        throw new Error(`Found back-to-back duplicated block: ${lines[i]} at line ${i}`)
      }
    }

    ctx.log(`Verify: final content contains both, length ${finalContent.length}`)

    ctx.setPhase("unresolvable", { test: "impossible conflict should still error" })

    await sh("git checkout dev")
    await sh(`echo initial content > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m reset-for-impossible --allow-empty`)
    await ctx.shell(`git branch -D ${branches.failA}`).catch(() => {})
    await ctx.shell(`git branch -D ${branches.failB}`).catch(() => {})
    await sh(`git checkout -b ${branches.failA}`)
    await sh(`echo Should Fail A > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m fail-a --allow-empty`)
    await sh("git checkout dev")
    await sh(`git checkout -b ${branches.failB}`)
    await sh(`echo Should Fail B > ${testFile}`)
    await sh(`git add ${testFile}`)
    await sh(`git commit -m fail-b --allow-empty`)
    await sh("git checkout dev")
    await sh(`git merge --ff-only ${branches.failA}`)

    let impossibleThrew = false
    try {
      await ctx.mergeWorktree({ branch: branches.failB }, { onConflict: "error" })
    } catch (e: any) {
      const msg = e.message ?? String(e)
      if (e._tag === "WorkflowMergeConflictError" || msg.includes("Merge conflict") || (e as any).conflict || msg.includes("conflict")) {
        impossibleThrew = true
        ctx.log(`Impossible conflict correctly threw MergeConflictError: ${msg.slice(0, 200)}`)
      }
    }

    if (!impossibleThrew) {
      throw new Error("Expected MergeConflictError for impossible conflict but none thrown")
    }

    await ctx.shell("git merge --abort").catch(() => {})
    await sh("git checkout dev")
    await ctx.shell(`git branch -D ${branches.a} ${branches.b} ${branches.failA} ${branches.failB}`).catch(() => {})
    await ctx.shell("git worktree prune").catch(() => {})
    await sh(`echo initial content > ${testFile} && git add ${testFile} && git commit -m cleanup-merge-agent-test --allow-empty`)

    // Verify merge:<label> agent row exists with real token usage (checked in harness)
    return {
      success: true,
      finalContent: finalContent.slice(0, 500),
      secondMergeSuccess,
      impossibleThrew,
      message: "wf2-validate-merge-agent passed",
    }
  },
}
