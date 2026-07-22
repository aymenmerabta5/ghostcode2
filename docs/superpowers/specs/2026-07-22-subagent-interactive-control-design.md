# Subagent Interactive Control & Background Jobs Design

> Date: 2026-07-22
> Status: Approved (Approach 2 + background tasks amendment)
> Area: opencode CLI TUI, TUI SDK, App, Core background-job, Tool registry

## 1. Overview & Problem
Current opencode blocks main agent when spawning subagents via task tool in foreground. TUI shows Explore Task – 8 toolcalls – 21.8s with main stuck, no way to talk to main. ESC double-press aborts all (main + subagents + dev servers). Long-running shells like bun run dev timeout after 2min and have no background survive, and malformed tool calls (ServiceException: Function tool call is malformed) kill sessions via Effect.orDie.

Goal: Make subagents first-class interactive sessions, unified with shell background jobs, with safe ESC semantics and proper malformed handling.

## 2. Goals
- C: Both human TUI control AND programmatic agent→subagent control
- Option1 ESC + revised guard: First ESC = hint/no-op, second ESC = focused kill (main only OR selected subagent only), new key Shift+A = kill all. Invariant: interrupting main NEVER stops subagents/background unless explicit kill-all.
- A + enhancements: Blocking task_output/background_output tool that waits for specific job with timeout, plus background_list and background_kill for management. Plus detail view with tail, full logs, port detection.
- Shell background: bash tool gains background:true param using same BackgroundJob.Service so bun run dev can run forever.
- Malformed fix: Invalid tool args return model-facing error instead of dying fiber.
- TUI shows everything: ctrl+x lists both task subagents and shell jobs, selected banner, prompt retargeting, background indicators.

## 3. Non-Goals
- Full workflow engine unification
- Arbitrary multi-join barrier in v1
- Single-ESC instant abort

## 4. Success Criteria
- User can ctrl+x → select subagent → type → steers that subagent; ESC returns to main
- Main waiting 21.8s: hit ESC once → hint, ESC twice → prompt returns instantly, subagent promoted to background
- Main can spawn bash background:true command:"bun run dev" → job survives, background_list shows it, background_output shows logs, background_kill stops it
- Glob with bad args returns "The glob tool was called with invalid arguments: ...", session alive
- No behavior where interrupting main kills subagents/dev server unless Shift+A

## 5. Architecture
- Core: BackgroundJob.Service generic for task+shell
- ShellTool: background param, uses BackgroundJob.start with 24h timeout, creates log file upfront for live streaming
- New tools: background_output/task_output (alias), background_list, background_kill with prefix matching, ambiguous detection, port detection, tail/full/filter
- Tool error: wrap() catches InvalidArgumentsError and generic errors, returns error result not defect; remove orDie from glob/shell/background-list
- Transport: selectedSubagent targeting, idle per target sessionID
- TUI CLI: footer.ts ESC branching, promotes foreground jobs to background on main abort, kills only selected on subagent view, Shift+A kill-all cancels shell jobs too
- TUI SDK: keybind session_interrupt_all Shift+A, visible memo allows prompt when viewing child
- App: background-jobs-panel.tsx polling /background endpoints, server groups/background.ts list/get/cancel

## 6. ESC Matrix
- ESC 1st anywhere: hint, arm 5s timer
- ESC 2nd main view: abort main only, promote running jobs to background
- ESC 2nd subagent view: abort that subagent only, return to main
- Shift+A 1st: hint "again to interrupt ALL"
- Shift+A 2nd: abort main + all children + all background jobs (shell+task)

## 7. Tool Details
- background_output: task_id, timeout 0-600k default 120k, tail 1-1000 default 100, full bool, filter string, returns id/type/title/status/duration/timedOut/detectedPorts/Urls/output, reads live log file via metadata.logPath
- background_list: no args, table id/type/title/status/duration/tail
- background_kill: task_id, reason?, resolves prefix, ambiguous error, cancels via BackgroundJob.cancel
- shell background: creates log file via trunc.write(""), stores in metadata logPath/outputPath, stream handler writes all chunks to file, 5s startup failure detection via wait timeout

## 8. Permissions & Nesting
- Allow background_list/kill/output for explore and general subagents
- Depth guard max 2, returns error result not defect
- Anti-poll guidance: DO NOT spam background_output in loop

## 9. Testing
- Unit: tool-define invalid args returns error not defect, glob no orDie, task background without flag, depth guard, shell background immediate return, background_list/kill/output with real shell jobs, port detection, filter, tail
- Integration: ESC promotion, transport targeting, subagent data merge, ctrl+x panel, TUI SDK keybind
- E2E: spawn explore foreground, double ESC keeps it, select subagent ESC kills only it, spawn bun dev background, list/output/kill

## 10. Files Modified
- tool/tool.ts (fix orDie), glob.ts, shell.ts, task.ts, background-list.ts, background-kill.ts, task-output.ts, registry.ts, agent.ts, cli/cmd/run/footer.ts, stream.transport.ts, subagent-data.ts, footer.subagent.tsx, footer.command.tsx, footer.view.tsx, tui/config/keybind.ts, routes/session/index.tsx, component/prompt/index.tsx, app/session.tsx, server background group/handler, etc.
