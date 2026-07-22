# Subagent Interactive Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagents first-class interactive sessions with unified background shell jobs, safe ESC semantics (focused kill), new management tools, and fixed malformed tool handling

**Architecture:** Reuse BackgroundJob.Service as unified registry for task+shell. Extend ShellTool with background param, fix Tool.wrap orDie, add background_list|kill|output tools, branch ESC handling on selectedSubagent, promote foreground jobs on main abort, add TUI banner and ctrl+x listing

**Tech Stack:** TypeScript, Effect TS, Bun, opencode TUI, BackgroundJob core, Tool registry

## Global Constraints

- Existing double-ESC guard must stay: first ESC hint only, second ESC focused kill
- Invariant: interrupting main NEVER stops subagents/background unless Shift+A kill-all
- Subagent view ESC kills that subagent only and returns to main
- Tool error handling must return model-facing error, not fiber defect
- All new tools must have timeout, anti-poll guidance, bounded output
- Depth guard for nesting: max 2
- TUI must show both task and shell jobs in ctrl+x panel
- Port detection regex: /(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/
- Tests required for each fix: unit + integration, strong tests mirroring real world, never weaken tests to make pass

---

### Task 1: Fix Tool Invalid Args Handling
Files: Modify packages/opencode/src/tool/tool.ts, Test packages/opencode/test/tool/tool-define.test.ts
- Write test invalid args returns error not defect
- Fix wrap() to catch InvalidArgumentsError and generic errors returning error result
- Run bun test, commit

### Task 2: Remove orDie from Glob and Shell
Files: Modify packages/opencode/src/tool/glob.ts, shell.ts
- Remove Effect.orDie, change throw to Effect.fail for expected errors
- Test glob invalid path returns error not defect
- Commit

### Task 3: Shell Background Support
Files: Modify shell.ts, Test shell-background.test.ts
- Add background bool and description params
- Inject BackgroundJob.Service, start job with 24h timeout, return immediately BACKGROUND_STARTED
- Add 5s startup failure detection via wait
- Create log file upfront via trunc.write("") and store in metadata logPath/outputPath, write all chunks to file for live streaming
- Test background true returns jobId quickly, foreground still works
- Commit

### Task 4: Remove Experimental Flag + Depth Guard
Files: Modify task.ts
- Remove flag check, always allow background param
- Add depth guard walking parent chain, max 2, return error result not defect
- Test background without flag, depth 0/1 pass 2+ fail
- Commit

### Task 5: New Background Tools
Files: Create background-list.ts, background-kill.ts, task-output.ts (+ txt)
- background_list: no args, list jobs table
- background_kill: task_id, reason, prefix matching, ambiguous error, cancel
- task_output/background_output: task_id, timeout 0-600k default 120k, tail 1-1000 default 100, full bool, filter string, port/url detection, anti-poll guidance, read live log file via metadata.logPath for running jobs, full bounded 50k via FSUtil
- Strong tests with real shell background jobs
- Commit

### Task 6: Registry Wiring
Files: Modify registry.ts, agent.ts
- Import and init new tools, add to builtin array, alias background_output
- Allow background_* for explore agent
- Test registry includes new tools
- Commit

### Task 7: CLI TUI ESC Promotion
Files: Modify footer.ts, runtime.ts, keybind.ts, run-state.ts, task.ts onAbort
- First ESC hint only, second ESC main view promotes running jobs to background via background.promote, aborts main only
- Subagent view ESC kills selected only
- Shift+A kill-all cancels shell jobs too via background.list+cancel + session children abort
- Fix run-state to not cascade parent→child cancel
- Test task promotion
- Commit

### Task 8: Transport Selected Targeting
Files: Modify stream.transport.ts
- targetID = selectedSubagent ?? main
- idle(), touch(), mark(), complete() use targetID
- onVisibleOutput for selected subagent
- Test stream-selection targeting main vs child, keeps selection after turn, main idle does not complete subagent turn
- Commit

### Task 9: Subagent Data Merge + Banner
Files: Modify subagent-data.ts, footer.subagent.tsx
- Add background Map, listUnifiedTabs, backgroundToTab, syncBackgroundDetail with synthetic frame for logs
- Banner: Messaging: @agent subagent (idx/total) [icon title status] — ESC=kill
- Type icons 🤖 task, ▣ shell
- Tests subagent-data merge
- Commit

### Task 10: Ctrl+X Panel
Files: Modify footer.command.tsx, footer.view.tsx, footer.ts
- Merge tabs + background jobs, shortId 8 chars, type icons, status, duration, tail/port preview, search keywords, ctrl+d kill
- Enter selects task subagent, shell closes panel
- Commit

### Task 11: TUI SDK Keybind + Visible Memo
Files: Modify tui/config/keybind.ts (A for interrupt_all), routes/session/index.tsx visible memo allows prompt when child selected, component/prompt/index.tsx branching for ESC main vs subagent, Shift+A kill-all includes shell jobs via SDK background.list/cancel
- Test tui typecheck
- Commit

### Task 12: App UI + Server Endpoints
Files: Create groups/background.ts, handlers/background.ts, background-jobs-panel.tsx, modify session.tsx, api.ts, server.ts
- Endpoints GET /background list, GET /background/:id, POST /background/:id/cancel
- App panel polling 2s via fetch with auth, shows running jobs with kill/logs
- Allow child session prompting in App (remove isChildSession guards)
- Commit

### Task 13: Tests + Reviewers Loop
- Run bun test for tool suites, fix any failing due to outdated expectations (update to expect error result not defect)
- Spawn 2-3 adversarial reviewer agents with plan path only, produce reports
- Fix blockers: kill-all leaks shell, defect on job-not-found, ambiguous prefix, startup detection, full file read, streaming logs
- Loop until reviewers say ACCEPT production ready
- Final verification and goal complete
