# Delegation Discipline Design — Fix Duplicate Subagent/Workflow Work

Date: 2026-07-22
Status: Approved — Approach B (Prompt + Code Fix)

## Problem Summary

Observed bugs in production:

1. **12 then 12 duplication**: Model launches 6 reviewers (DB, Auth, Schema, Web, Billing, Single) on same convex files, then before they finish launches another 6 identical, then another 6 = 18 reviewers, 24 notifications spam.
   - Model self-diagnosed: "I didn't see my delegations - I should have waited for first 6 to finish, collected their verdicts, fixed the blockers, THEN re-sent reviewers. Instead I fired new batch while old was still running."

2. **Main duplicates subagent work**: Main tells subagent "do X" then itself goes and does X in parallel (edits same files), causing conflicts and wasted work. Same for workflows: starts workflow then does its job manually.

Root causes found:

- `task.txt` says "Launch multiple agents concurrently whenever possible" + "Once you have delegated work to an agent, do not duplicate that work yourself" but not strong enough, no file-lock language, no mention of unlimited allowed.
- `workflow.txt` already has "# AFTER YOU START A RUN — STOP. DO NOT WORK ALONGSIDE IT." but main still violates.
- `SessionPrompt.pursue()` loop in `packages/opencode/src/session/prompt.ts:1399` does:
  ```
  while (step < GOAL_MAX_STEPS) {
    prompt({ text: "You are now autonomously pursuing..." })
    step++
  }
  ```
  It does NOT check `BackgroundJob.list()` before next iteration. If reviewers are spawned as background:true, first `prompt()` returns instantly with "Background task started", pursue immediately starts next iteration with "The session goal is not yet complete..." → model forgets running tasks and spawns duplicate batch.
- `goalr.txt` says "Spawn at least 2-3 reviewers" but doesn't forbid background or per-file fan-out, so model spawns 6 per domain.
- No shared delegation discipline section in system prompts (`default.txt`, `anthropic.txt`, etc.) — they focus on tone but not delegation lifecycle.

## Architecture Overview

Fix at two layers:

1. **Prompt layer (system prompts + tool descriptions)**: Make delegation discipline impossible to miss, allow unlimited parallel but forbid touching delegated work.
2. **Code layer (pursue loop)**: Make autonomous goal loop wait for running Task-type background jobs belonging to its session before starting next iteration. This eliminates 12+12 race even if prompt is ignored.

```
User /goal set X
  → goals.set + pursue fork
    → step 0: prompt("You are now pursuing...")
        → model spawns 3 reviewers via Task (foreground ideally)
        → if background:true, jobs start, tool returns "running"
    → [CODE FIX] before step 1: list background jobs where metadata.parentSessionId == sessionID and status==running and type=="task"
        → if any, wait for them (bg.wait) with timeout, or at least log and delay
    → step 1: only after prior reviewers finished, prompt("Keep working...") — now model sees reviewer feedback and doesn't duplicate
    → same for workflows: pursue should also check workflow runs? But workflow runs are separate from BackgroundJob; they have their own runs. System prompt will handle that part.
```

## System Prompt Changes (Prompt Layer)

**Files to edit**: All prompt variants in `packages/opencode/src/session/prompt/`:
- `default.txt`
- `anthropic.txt`
- `beast.txt`
- `gpt.txt`
- `gemini.txt`
- `meta.txt`
- `codex.txt`
- `trinity.txt`
- `kimi.txt`
- `copilot-gpt-5.txt`

Add new section at end (or after # Doing tasks) — `# Delegation Discipline (MANDATORY)`:

```
# Delegation Discipline (MANDATORY — prevents duplicate work and lost subagents)

You may launch UNLIMITED Task subagents and Workflows in parallel — more agents is better for speed and quality. You are encouraged to fan out.

But you have STRICT isolation rules:

1. Once delegated, DO NOT touch:
   - When you call Task tool (any subagent_type) or workflow start, you MUST NOT do the same work yourself.
   - Do NOT edit files, search same topics, or redo logic you gave to subagents.
   - The subagent/workflow OWNS that work until it completes.

2. File/topic lock:
   - If a background job (task or workflow) is handling files or topics X, you are FORBIDDEN from editing X until it completes.
   - Before editing any file, call `background_list` and `workflow inspect` to see what's running. If overlap exists, wait or work on completely unrelated tasks.

3. No duplicate spawning (fixes 12+12 bug):
   - Before spawning new subagents on same topic, call `background_list`.
   - If identical work is already running, DO NOT spawn again — wait for its result.
   - You must spawn EXACTLY ONE batch per review round, then WAIT for ALL in that batch to return. Do not spawn 6+6+6 on same convex files.

4. After workflow start — STOP:
   - Once `workflow start` returns run ID, you MUST NOT begin doing same work yourself.
   - Only poll `inspect`, relay `pending_question`, report progress.
   - Do NOT edit files workflow may touch; work only on unrelated tasks.
   - If run fails: fix workflow file and resume with resume_of — never silently redo by hand.

5. Foreground vs background:
   - For reviewer loops or any case where you need result before proceeding, use FOREGROUND (omit background:true).
   - This forces you to wait and prevents forgetting.
   - Background:true is ONLY for truly independent work that can run while you do unrelated tasks.

6. Accountability:
   - Each Task output includes task_id you can resume.
   - You will be notified automatically when background tasks finish — do NOT poll, do NOT duplicate.

Violation = duplicated work, file conflicts, spammed notifications, wasted tokens.
```

Placement: After existing # Doing tasks / # Tool usage policy sections, before # Code References.

## Task Tool Hardening

**File**: `packages/opencode/src/tool/task.txt`

Current line 2 already says "Once you have delegated work to an agent, do not duplicate that work yourself."

Add after line 2:

```
- You may launch UNLIMITED Task subagents in parallel — more is better. But once delegated, you MUST NOT touch their work. Do NOT edit same files or redo same logic. Call `background_list` before touching files to check for running subagents covering same area. If duplicate work is already running, wait for it.
- After you spawn subagents, WAIT for them to return. Do NOT spawn 12 then 12 on same files. One batch per round, wait for all to complete, then fix, then re-spawn if needed.
```

Also update `packages/opencode/src/tool/task.ts` BACKGROUND_STARTED and BACKGROUND_UPDATED constants already warn "DO NOT duplicate this task's work" — keep as is, but ensure `description` includes new guidance (it concatenates DESCRIPTION + BACKGROUND_DESCRIPTION, so editing task.txt suffices).

## Code Fix in pursue Loop

**File**: `packages/opencode/src/session/prompt.ts`

**Layer deps**: Add `BackgroundJob.node` to `node` deps (line 2093) and import `BackgroundJob` service.

**Interface**: In `pursue` function (line 1399-1438), inject `BackgroundJob.Service`.

**Logic**: Before each iteration after step 0, or before every iteration:

```ts
const bg = yield* BackgroundJob.Service
const jobs = yield* bg.list()
const runningForSession = jobs.filter(j => 
  j.status === "running" && 
  j.type === "task" &&
  (j.metadata as any)?.parentSessionId === input.sessionID
)
if (runningForSession.length > 0) {
  // Wait for all running task jobs for this session to finish before next pursue step
  for (const job of runningForSession) {
    yield* bg.wait({ id: job.id }).pipe(
      Effect.timeoutOption(5 * 60 * 1000), // 5 min max per job wait in pursue loop
      Effect.ignore
    )
  }
}
```

Alternative simpler: Wait with timeoutOption, if still running after timeout, continue anyway but log. Prevents infinite block on hung jobs.

Also ensure pursue doesn't start next step if there are still running jobs that were just spawned in previous step — this eliminates 12+12.

Edge: shell background jobs (bun run dev) are type "shell", not "task", so they won't block pursue — intentional, dev servers should run forever.

This fix ensures even if model uses background:true for reviewers (against guidance), pursue won't fire next iteration and cause duplicate.

## Workflow Reinforcement

`workflow.txt` already has strong guidance at line 65: "# AFTER YOU START A RUN — STOP. DO NOT WORK ALONGSIDE IT."

No code change needed for workflows in pursue loop (workflows are not BackgroundJobs). System prompt addition will reinforce.

Optionally, could also add workflow run check in pursue loop via Workflow service list, but not required for Prompt + Code fix scope — keep to Task jobs only to minimize change.

## Data Flow — Fixed

```
Goal set → pursue fork
  → step 0: prompt("pursuing...")
      → model: Task x3 foreground (blocks) or background (returns quickly)
      → if foreground: prompt() waits via bg.wait inside task.ts, returns only after reviewers finish → no race
      → if background: bg jobs now running
  → [NEW] pursue checks bg.list() filtered by parentSessionId, waits for running task jobs
      → ensures reviewers finish before next step
  → step 1: prompt("keep working...") now sees reviewer feedback, model can fix and respawn ONE batch
  → repeat until goal complete
```

No more 12 then 12 because second batch cannot start while first still running.

## Testing / Verification

- Manual test: /goal set "create convex schema for DB, Auth, etc." and observe background_list doesn't show duplicate reviewers.
- Unit: add test in `packages/opencode/test/tool/task.test.ts` for delegation discipline description contains "UNLIMITED" and "do not touch"
- Unit: test pursue waits — mock BackgroundJob with running jobs, ensure pursue calls wait before next prompt (can add integration test in `test/session/prompt.test.ts`)
- Verify all prompt files `bun --check` still valid (they are txt, not ts)
- Run `bun typecheck` in `packages/opencode`
- Verify `goalr.txt` still original (reverted) — no change.

## Rollout

- Commit delegation discipline to all prompt files in one commit: `feat(opencode): add delegation discipline to system prompts`
- Commit code fix: `fix(opencode): make goal pursue wait for background task jobs`
- No breaking change, just stronger guidance + small wait logic.

## Open Questions Resolved

- User wanted unlimited subagents allowed → yes, explicitly allow unlimited in new section.
- Should apply to both Task and Workflow → yes, section covers both.
- File/topic lock → yes, forbids editing same files as running jobs.
- Which files to patch → all prompt variants for consistency.
- Code fix needed → yes, Approach B includes pursue wait.

## Checklist

- [x] Revert goalr.txt to original (done)
- [ ] Add Delegation Discipline section to all session prompt txt files
- [ ] Harden task.txt
- [ ] Modify prompt.ts pursue to wait for background task jobs
- [ ] Add BackgroundJob dep to prompt.ts node
- [ ] Typecheck and test
- [ ] Commit design doc
