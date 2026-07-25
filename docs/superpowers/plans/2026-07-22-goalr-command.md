# /goalr Command with Reviewer Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new slash command `/goalr` that behaves like `/goal` but enforces a mandatory reviewer loop before completion.

**Architecture:** Create a new template file `goalr.txt` containing `goal.txt` content plus explicit reviewer-loop instructions. Register the new command in `Command` service (`src/command/index.ts`) as `GOALR` constant and entry, mirroring `GOAL` registration pattern.

**Tech Stack:** TypeScript, Bun, opencode command system, Effect TS

## Global Constraints

- Keep existing `/goal` command unchanged
- New command name must be exactly `goalr`
- Template must include `$ARGUMENTS` placeholder like `goal.txt`
- Implementation must be prompt-only (no new tool code)
- Branch name style: at most 3 words, hyphen separated
- Commit style: conventional commits `type(scope): summary`
- No new dependencies

---

### Task 1: Create goalr template with reviewer loop

**Files:**
- Create: `packages/opencode/src/command/template/goalr.txt`
- Read: `packages/opencode/src/command/template/goal.txt`

**Interfaces:**
- Consumes: Existing `goal.txt` content for base usage instructions
- Produces: New template file with reviewer loop enforcement

- [ ] **Step 1: Read existing goal template**

Read file `D:\MyWork\ghostcode2\packages\opencode\src\command\template\goal.txt`

Content is:
```
Manage the session goal for autonomous pursuit.

Usage:
- `/goal set <description>` — set a new active goal and start pursuing it
- `/goal pause` — pause the active goal (stops the autonomous loop)
- `/goal resume` — resume the paused goal (restarts the autonomous loop)
- `/goal complete [verification]` — mark the goal as completed
- `/goal clear` — remove the goal entirely
- `/goal show` — display the current goal and its status

$ARGUMENTS
```

- [ ] **Step 2: Create goalr.txt with reviewer loop**

Create file `packages/opencode/src/command/template/goalr.txt` with content:

```
Manage the session goal for autonomous pursuit with mandatory reviewer approval.

This command is identical to /goal but adds a strict reviewer loop that MUST be followed before declaring victory.

Usage:
- `/goalr set <description>` — set a new active goal and start pursuing it
- `/goalr pause` — pause the active goal (stops the autonomous loop)
- `/goalr resume` — resume the paused goal (restarts the autonomous loop)
- `/goalr complete [verification]` — mark the goal as completed (only after reviewer approval)
- `/goalr clear` — remove the goal entirely
- `/goalr show` — display the current goal and its status

$ARGUMENTS

## Reviewer Loop (MANDATORY - MUST be followed)

You MUST NOT call goal complete until ALL of the following steps are satisfied. This is a hard requirement.

1. **Implement the goal fully** using best practices and verification:
   - Run typechecks, tests, or verifications relevant to the changes (e.g., `bun typecheck` from package dirs)
   - Ensure changes are objectively correct, not just superficially working

2. **Spawn reviewer subagents** after implementation is done:
   - Spawn at least 2-3 independent reviewer subagents in parallel using the Task tool with explore or general subagent_type
   - Each reviewer should be given a distinct lens:
     - Lens 1: Correctness, logic, edge cases, bug detection
     - Lens 2: Code quality, structure, style, adherence to AGENTS.md, conventions, security
     - Lens 3: Completeness, missing requirements, goal alignment, testing
   - Reviewers must read actual changed files and relevant context, not just diffs
   - Reviewers must produce actionable feedback: either APPROVE with no comments, or list specific fixes required

3. **Hard gate on completion**:
   - You are PROHIBITED from declaring victory or calling `goal complete` until ALL spawned reviewer subagents return explicit approval without any comments or required fixes
   - Interpretation: If ANY reviewer says "needs fix", "issue found", "should change", "consider", etc., that counts as NOT approved

4. **Fix loop**:
   - If any reviewer reports an issue or required fix, you MUST go and fix it
   - After fixing, you MUST respawn the reviewer subagents again (new Task calls) and repeat the review
   - Continue this loop: implement/fix → review → fix → re-review until all reviewers fully approve without any comment

5. **Completion criteria**:
   - Only when ALL reviewers in the latest round approve with zero comments/issues, you may call `goal complete` with verification that includes reviewer approval summary
   - Include in verification: what reviewers checked, that all approved, and any changes made during reviewer loop

## Workflow Summary

```
Goal set → Implement → Verify (typecheck/tests) → Spawn reviewers (2-3 parallel)
→ If any reviewer has comments → Fix → Respawning reviewers → Repeat
→ When all reviewers APPROVE clean → goal complete
```

## Important Rules

- Use the `task` tool to spawn reviewers as subagents, not inline reasoning
- Reviewers must be adversarial and thorough, trying to find problems
- Do NOT skip reviewers to save time - quality over speed
- Do NOT declare completion after first implementation without reviewers
- If you fix issues, re-run relevant verification before next review round
- Document the reviewer loop in your final verification
```

- [ ] **Step 3: Verify file created**

Run: `Test-Path -LiteralPath "D:\MyWork\ghostcode2\packages\opencode\src\command\template\goalr.txt"` in powershell, expect True

- [ ] **Step 4: Commit template**

```bash
git add packages/opencode/src/command/template/goalr.txt
git commit -m "feat(opencode): add goalr template with reviewer loop"
```

---

### Task 2: Register goalr command in Command service

**Files:**
- Modify: `packages/opencode/src/command/index.ts`
- Read: `packages/opencode/src/command/index.ts`

**Interfaces:**
- Consumes: New `goalr.txt` file path and PROMPT_GOAL import pattern
- Produces: Registered `goalr` command available via `/goalr`

- [ ] **Step 1: Read current command/index.ts**

Read `D:\MyWork\ghostcode2\packages\opencode\src\command\index.ts` to see existing registration:

```ts
import PROMPT_GOAL from "./template/goal.txt"
...
export const Default = {
  INIT: "init",
  GOAL: "goal",
  LOOP: "loop",
  REVIEW: "review",
} as const
...
commands[Default.GOAL] = {
  name: Default.GOAL,
  description: "set or update the session goal",
  source: "command",
  get template() {
    return PROMPT_GOAL
  },
  hints: ["$ARGUMENTS"],
}
```

- [ ] **Step 2: Add import for goalr template**

Edit `packages/opencode/src/command/index.ts` line 11, add:
```ts
import PROMPT_GOALR from "./template/goalr.txt"
```
after the PROMPT_GOAL import.

File before:
```
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_GOAL from "./template/goal.txt"
import PROMPT_LOOP from "./template/loop.txt"
import PROMPT_REVIEW from "./template/review.txt"
```

File after:
```
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_GOAL from "./template/goal.txt"
import PROMPT_GOALR from "./template/goalr.txt"
import PROMPT_LOOP from "./template/loop.txt"
import PROMPT_REVIEW from "./template/review.txt"
```

- [ ] **Step 3: Add GOALR to Default const**

Edit Default const from:
```ts
export const Default = {
  INIT: "init",
  GOAL: "goal",
  LOOP: "loop",
  REVIEW: "review",
} as const
```
To:
```ts
export const Default = {
  INIT: "init",
  GOAL: "goal",
  GOALR: "goalr",
  LOOP: "loop",
  REVIEW: "review",
} as const
```

- [ ] **Step 4: Register goalr command alongside goal**

After the block that registers `commands[Default.GOAL]`, add new block:

```ts
      commands[Default.GOALR] = {
        name: Default.GOALR,
        description: "set or update the session goal with reviewer loop",
        source: "command",
        get template() {
          return PROMPT_GOALR
        },
        hints: ["$ARGUMENTS"],
      }
```

So final file should have both GOAL and GOALR registrations sequentially.

- [ ] **Step 5: Verify file compiles**

Run: `bun typecheck` from `packages/opencode` directory

Expected: No type errors related to new code. Existing unrelated errors may exist but not from our changes.

- [ ] **Step 6: Commit registration**

```bash
git add packages/opencode/src/command/index.ts
git commit -m "feat(opencode): register goalr command with reviewer loop"
```

---

### Task 3: Verification and testing

**Files:**
- Test: `packages/opencode/src/command/index.ts`
- Test: Manual verification via command list

**Interfaces:**
- Consumes: Registered commands
- Produces: Verified working /goalr command

- [ ] **Step 1: Write manual verification script (optional)**

Create temporary file to test command list includes goalr (can be deleted after):

```ts
// verification script concept
// Check that Command service list returns goalr
```

But simpler: just verify template file exists and index.ts contains goalr references.

Run powershell:
```
Select-String -Pattern "goalr" -Path "D:\MyWork\ghostcode2\packages\opencode\src\command\index.ts"
```
Expected: Shows import, Default.GOALR, commands[Default.GOALR]

- [ ] **Step 2: Run relevant tests**

From `packages/opencode` dir run:
```
bun test test/config/config.test.ts -t "command configuration" --timeout 30000
```
Expected: PASS (or at least not failing due to our change)

Also from `packages/core` dir:
```
bun test test/command.test.ts
```
Expected: PASS (core command tests unrelated but should still pass)

- [ ] **Step 3: Final verification - list all Default commands**

Ensure file `packages/opencode/src/command/index.ts` contains:
- `GOALR: "goalr"`
- `PROMPT_GOALR` import
- `commands[Default.GOALR]` registration with description "set or update the session goal with reviewer loop" and hints ["$ARGUMENTS"]

- [ ] **Step 4: Document completion**

Update verification for goal completion to include:
- Created goalr.txt template
- Registered command in index.ts
- Verified via typecheck and file existence

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] Adds slash command /goalr same as goal - covered by Task 1 and Task 2
- [x] Includes loop of reviewer agents - covered by template content in Task 1
- [x] Prompt-only change - satisfied, no tool code changes
- [x] Agent must not declare victory until reviewers approve - enforced in template
- [x] If fix needed, agent fixes and respawns reviewers - enforced in template loop section
- [x] Use superpowers skill - this plan uses writing-plans skill format

**2. Placeholder scan:** No TBD/TODO, all file paths exact, all code blocks complete

**3. Type consistency:**
- PROMPT_GOALR follows same pattern as PROMPT_GOAL (string import from txt)
- Default.GOALR follows same pattern as Default.GOAL
- commands[Default.GOALR] mirrors commands[Default.GOAL] structure exactly
