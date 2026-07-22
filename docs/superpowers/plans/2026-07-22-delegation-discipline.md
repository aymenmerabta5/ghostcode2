# Delegation Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent main agent from duplicating work delegated to Task subagents or Workflows, while allowing unlimited parallel delegation, and fix 12+12 duplicate reviewer spam via code waiting in goal pursue loop.

**Architecture:** Two-layer fix: (1) Prompt layer — add Delegation Discipline section to all system prompt txt files and harden task.txt. (2) Code layer — modify SessionPrompt.pursue() to list BackgroundJob and wait for running task-type jobs belonging to its session before next iteration, preventing duplicate batch spawning.

**Tech Stack:** TypeScript, Bun, Effect TS, opencode prompt system, BackgroundJob service

## Global Constraints

- Revert goalr.txt to original — already done, keep it unchanged
- No new dependencies
- Branch name style: at most 3 words, hyphen separated (if branch needed)
- Commit style: conventional commits type(scope): summary
- Update ALL prompt variants for consistency, not just one
- Code fix must only wait for task-type jobs, not shell-type (dev servers run forever)
- Do not block indefinitely — use timeoutOption 5min max per job wait in pursue loop

---

### Task 1: Harden Task Tool Description

**Files:**
- Modify: `packages/opencode/src/tool/task.txt`

**Interfaces:**
- Consumes: Existing task.txt content with delegation guidance
- Produces: Hardened description with unlimited allowed but no-touch rule and background_list check

- [ ] **Step 1: Read current task.txt**

Read file `D:\MyWork\ghostcode2\packages\opencode\src\tool\task.txt`

Current content is:
```
Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Grep tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- If no available agent is a good fit for the task, use other tools directly


Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
2. Once you have delegated work to an agent, do not duplicate that work yourself. Continue with non-overlapping tasks, or wait for the result. For background tasks, you will be notified automatically when it finishes.
3. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.
4. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
5. The agent's outputs should generally be trusted
6. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).
7. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
```

- [ ] **Step 2: Edit task.txt to add unlimited + no-touch + background_list guidance**

Edit file `D:\MyWork\ghostcode2\packages\opencode\src\tool\task.txt` to:

```
Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Grep tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- If no available agent is a good fit for the task, use other tools directly


Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses. You may launch UNLIMITED Task subagents in parallel — more is better for speed.
2. Once you have delegated work to an agent, do not duplicate that work yourself. Do NOT edit same files, search same topics, or redo same logic that you gave to subagents. The subagent OWNS that work until it completes. Call background_list before editing files to check for running subagents covering same area. If duplicate work is already running, wait for it instead of spawning again.
3. After you spawn subagents, WAIT for them to return. Do NOT spawn 12 then 12 on same files. Spawn ONE batch per topic/round, wait for ALL in that batch to complete, then fix or continue. If you see running jobs in background_list handling same topic, you are FORBIDDEN from spawning new ones on that topic.
4. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result. The output includes a task_id you can reuse later to continue the same subagent session.
5. Each agent invocation starts with a fresh context unless you provide task_id to resume the same subagent session (which continues with its previous messages and tool outputs). When starting fresh, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
6. The agent's outputs should generally be trusted
7. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g., relevant test commands).
8. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
9. For background tasks, you will be notified automatically when it finishes. DO NOT poll, but do use background_list to avoid duplicate spawning on same topic before starting new work.
```

Ensure you replace old usage notes 2-3 with expanded version.

- [ ] **Step 3: Verify file**

Run: `cat packages/opencode/src/tool/task.txt` (or Read tool) and expect it contains "UNLIMITED" and "background_list" and "Do NOT spawn 12 then 12"

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/tool/task.txt
git commit -m "feat(opencode): harden task tool delegation discipline"
```

---

### Task 2: Add Delegation Discipline Section to All System Prompt Variants

**Files:**
- Modify: `packages/opencode/src/session/prompt/default.txt`
- Modify: `packages/opencode/src/session/prompt/anthropic.txt`
- Modify: `packages/opencode/src/session/prompt/beast.txt`
- Modify: `packages/opencode/src/session/prompt/gpt.txt`
- Modify: `packages/opencode/src/session/prompt/gemini.txt`
- Modify: `packages/opencode/src/session/prompt/meta.txt`
- Modify: `packages/opencode/src/session/prompt/codex.txt`
- Modify: `packages/opencode/src/session/prompt/trinity.txt`
- Modify: `packages/opencode/src/session/prompt/kimi.txt`
- Modify: `packages/opencode/src/session/prompt/copilot-gpt-5.txt`

**Interfaces:**
- Consumes: Existing prompt files (each ~100-150 lines)
- Produces: Same files plus new # Delegation Discipline section at end before code references or final lines

- [ ] **Step 1: Read one prompt file to confirm structure**

Read `packages/opencode/src/session/prompt/default.txt` — it ends with code references section. We'll append new section after # Doing tasks but before # Code References, or at end if no such section.

For each file, find a good insertion point: after # Tool usage policy or # Doing tasks, before # Code References if exists.

- [ ] **Step 2: Create delegation discipline snippet to inject**

Content to inject (same for all files):

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
   - Before editing any file, call background_list and workflow inspect to see what's running. If overlap exists, wait or work on completely unrelated tasks.

3. No duplicate spawning (fixes 12+12 bug):
   - Before spawning new subagents on same topic, call background_list.
   - If identical work is already running, DO NOT spawn again — wait for its result.
   - You must spawn EXACTLY ONE batch per review round, then WAIT for ALL in that batch to return. Do not spawn 6+6+6 on same convex files.

4. After workflow start — STOP:
   - Once workflow start returns run ID, you MUST NOT begin doing same work yourself.
   - Only poll inspect, relay pending_question, report progress.
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

- [ ] **Step 3: Edit each file — append section**

For each prompt file, edit to append the delegation discipline section at end of file (or before final code references if that section exists for readability).

Example edit for `default.txt`:
- Read file
- Append new section at bottom with two newlines separation

Do same for all 10 files. You can batch edits in parallel.

- [ ] **Step 4: Verify all files contain section**

Run powershell:
```
Select-String -Pattern "Delegation Discipline" -Path "packages/opencode/src/session/prompt/*.txt"
```
Expected: 10 matches (one per file)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/session/prompt/*.txt
git commit -m "feat(opencode): add delegation discipline to system prompts"
```

---

### Task 3: Fix Goal Pursue Loop to Wait for Background Task Jobs

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`
  - Imports: add `BackgroundJob` service import
  - Layer deps: add BackgroundJob node
  - pursue function: add waiting logic

**Interfaces:**
- Consumes: `BackgroundJob.Service` with `list()` and `wait()`
- Produces: pursue() that waits for running task jobs of same session before next step

- [ ] **Step 1: Read current prompt.ts around pursue and node deps**

Read `packages/opencode/src/session/prompt.ts` lines 1-60 for imports, and 1399-1440 for pursue, and 2078-2112 for node deps.

Current node deps at 2078:
```
export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    Goal.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
  ],
})
```

- [ ] **Step 2: Add BackgroundJob import and dep**

Edit `packages/opencode/src/session/prompt.ts` imports section (around line 50):

Add import:
```ts
import { BackgroundJob } from "@/background/job"
```

Add dep:
In node deps, add `BackgroundJob.node,` alongside other deps (e.g., after `Goal.node,`).

Also need to ensure `BackgroundJob` layer is available — it is instance-scoped, similar to other services used in prompt.

- [ ] **Step 3: Modify pursue function to wait for background task jobs**

Read pursue function:

Current:
```ts
const pursue: (input: { sessionID: SessionID }) => Effect.Effect<void> = Effect.fn("SessionPrompt.pursue")(
  function* (input) {
    if (pursuing.has(input.sessionID)) return
    pursuing.add(input.sessionID)
    yield* Effect.ensuring(
      Effect.gen(function* () {
        let step = 0
        while (step < GOAL_MAX_STEPS) {
          const goal = yield* goals.get(input.sessionID)
          if (!goal || goal.status !== "active") break
          const budget = goal.budgetTokens ?? GOAL_DEFAULT_BUDGET_TOKENS
          if (goal.tokensUsed >= budget) {
            yield* goals.pause(input.sessionID)
            break
          }

          const text =
            step === 0
              ? `You are now autonomously pursuing this session's goal:\n\n${goal.text}\n\nWork toward it using the available tools. When it is fully achieved, call the goal tool with action "complete" and a concise verification of what was accomplished. If you become blocked or need input from the user, call the goal tool with action "pause".`
              : `The session goal is not yet complete:\n\n${goal.text}\n\nKeep working toward it. When it is done, call the goal tool with action "complete" (include a short verification). If you are blocked, call it with action "pause".`

          const start = Date.now()
          const result = yield* prompt({
            sessionID: input.sessionID,
            parts: [{ type: "text", text }],
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!result) break

          const info = result.info
          if (info.role === "assistant" && info.tokens) {
            const t = info.tokens
            const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
            yield* goals.recordUsage({ sessionID: input.sessionID, tokens: used, durationMs: Date.now() - start })
          }
          step++
        }
      }),
      Effect.sync(() => pursuing.delete(input.sessionID)),
    )
  },
)
```

Edit to inject BackgroundJob waiting. New version:

```ts
const pursue: (input: { sessionID: SessionID }) => Effect.Effect<void> = Effect.fn("SessionPrompt.pursue")(
  function* (input) {
    if (pursuing.has(input.sessionID)) return
    pursuing.add(input.sessionID)
    const bg = yield* BackgroundJob.Service
    yield* Effect.ensuring(
      Effect.gen(function* () {
        let step = 0
        while (step < GOAL_MAX_STEPS) {
          // Before each step after first, wait for any still-running task jobs for this session (fixes 12+12 duplication)
          if (step > 0) {
            const jobs = yield* bg.list().pipe(Effect.catch(() => Effect.succeed([] as any[])))
            const runningForSession = (jobs as any[]).filter(
              (j: any) =>
                j.status === "running" &&
                j.type === "task" &&
                (j.metadata as any)?.parentSessionId === input.sessionID,
            )
            if (runningForSession.length > 0) {
              yield* Effect.logInfo("pursue waiting for background task jobs", {
                sessionID: input.sessionID,
                count: runningForSession.length,
                ids: runningForSession.map((j: any) => j.id),
              })
              for (const job of runningForSession) {
                yield* bg
                  .wait({ id: job.id })
                  .pipe(Effect.timeoutOption(5 * 60 * 1000), Effect.ignore, Effect.catch(() => Effect.void))
              }
            }
          }

          const goal = yield* goals.get(input.sessionID)
          if (!goal || goal.status !== "active") break
          const budget = goal.budgetTokens ?? GOAL_DEFAULT_BUDGET_TOKENS
          if (goal.tokensUsed >= budget) {
            yield* goals.pause(input.sessionID)
            break
          }

          const text =
            step === 0
              ? `You are now autonomously pursuing this session's goal:\n\n${goal.text}\n\nWork toward it using the available tools. When it is fully achieved, call the goal tool with action "complete" and a concise verification of what was accomplished. If you become blocked or need input from the user, call the goal tool with action "pause".`
              : `The session goal is not yet complete:\n\n${goal.text}\n\nKeep working toward it. If you previously spawned reviewer subagents or other task subagents that are still running (check background_list), wait for them to complete instead of spawning duplicate ones. When it is done, call the goal tool with action "complete" (include a short verification). If you are blocked, call it with action "pause".`

          const start = Date.now()
          const result = yield* prompt({
            sessionID: input.sessionID,
            parts: [{ type: "text", text }],
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!result) break

          const info = result.info
          if (info.role === "assistant" && info.tokens) {
            const t = info.tokens
            const used = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
            yield* goals.recordUsage({ sessionID: input.sessionID, tokens: used, durationMs: Date.now() - start })
          }
          step++
        }
      }),
      Effect.sync(() => pursuing.delete(input.sessionID)),
    )
  },
)
```

Note: The added check for `background_list` wording in the second iteration text also helps prompt-level fix.

- [ ] **Step 4: Ensure BackgroundJob import is at top with other services**

Verify file still compiles — `BackgroundJob` should be imported from `@/background/job` which is instance-scoped wrapper around core background job. Confirm node deps include `BackgroundJob.node`.

- [ ] **Step 5: Run typecheck**

Run:
```
cd packages/opencode
bun typecheck
```
Expected: No errors in prompt.ts. May have unrelated errors but not from our change.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/session/prompt.ts
git commit -m "fix(opencode): make goal pursue wait for background task jobs"
```

---

### Task 4: Verification and Cleanup

**Files:**
- Test manually via typecheck
- Ensure goalr.txt unchanged

**Interfaces:**
- Consumes: All previous tasks

- [ ] **Step 1: Verify goalr.txt is still original (no delegation discipline)**

Read `packages/opencode/src/command/template/goalr.txt` — should NOT contain "UNLIMITED" or "CRITICAL ANTI-DUPLICATION" (we reverted). If it does, revert again.

- [ ] **Step 2: Run relevant tests**

Run:
```
cd packages/opencode
bun test test/tool/task.test.ts -t "background" --timeout 30000
bun test test/session/prompt.test.ts --timeout 30000
```
Expected: PASS or at least not failing due to our change.

- [ ] **Step 3: Final typecheck**

```
cd packages/opencode
bun typecheck
```
Expected: No new errors from our files.

- [ ] **Step 4: Document completion**

Ensure design doc checklist updated — but plan says design doc already committed.

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Prompt layer — delegation discipline to all system prompts — Task 2
- [x] Task tool hardening — Task 1
- [x] Code fix in pursue loop waiting for background jobs — Task 3
- [x] Allows unlimited parallel — covered in Task 1 and Task 2 wording
- [x] Forbids main touching delegated work — Task 1 and 2
- [x] Fixes 12+12 bug — Task 3 wait logic + Task 2 guidance
- [x] Workflow STOP rule — included in Task 2 section (reinforces existing workflow.txt)
- [x] Revert goalr.txt — done before plan, verified in Task 4

**2. Placeholder scan:** No TBD/TODO, all file paths exact, all code blocks complete

**3. Type consistency:**
- BackgroundJob.Service.list() returns Info[] with id, type, status, metadata — our filter uses parentSessionId which matches metadata.parentSessionId from task.ts (line 213)
- bg.wait({id}) returns WaitResult, we handle with timeoutOption and ignore
- pursue still returns Effect<void> — added bg dep but still compatible

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-22-delegation-discipline.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
