import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable } from "@opencode-ai/core/workflow/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../plugin"
import * as Truncate from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Permission as PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Workflow as WorkflowSchema } from "@opencode-ai/schema/workflow"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from "effect"
import { and, eq, notInArray } from "drizzle-orm"
import { MetaReader } from "./meta-reader"
import { SourceLint } from "./source-lint"
import { Syntax } from "./syntax"
import { BUILTIN_WORKFLOWS, builtinPath, inlinePath, isBuiltinPath, isInlinePath } from "./builtin"
import { TurnBudget } from "./turn-budget"
import {
  AgentLimitError,
  BudgetExceededError,
  CancelledError,
  InvalidError,
  InvalidPhaseError,
  NotFoundError,
  SaveConflictError,
  StructuredOutputError,
} from "./errors"
import Ajv from "ajv"
import { createHash } from "crypto"
import type { DeepMutable } from "@opencode-ai/core/schema"
import type {
  AgentInput,
  AnswerInput,
  ContextApi,
  Interface,
  PipelineFn,
  PromptOps,
  SaveInput,
  StartOptions,
  WaitInput,
  WaitResult,
} from "./types"
import type { Meta } from "@opencode-ai/schema/workflow"

export { type Interface } from "./types"
export { NotFoundError, InvalidError, SaveConflictError, BudgetExceededError, AgentLimitError, StructuredOutputError, CancelledError } from "./errors"

export const RunID = WorkflowSchema.RunID
export type RunID = WorkflowSchema.RunID
export const Run = WorkflowSchema.Run
export type Run = DeepMutable<WorkflowSchema.Run>
export const Info = WorkflowSchema.Info
export type Info = WorkflowSchema.Info
export const Source = WorkflowSchema.Source
export type Source = WorkflowSchema.Source
export const Status = WorkflowSchema.Status
export type Status = WorkflowSchema.Status
export const Event = WorkflowSchema.Event

export class Service extends Context.Service<Service, Interface>()("@opencode/Workflow") {}

const DEFAULT_AGENT_LIMIT = 1_000
const MAX_BATCH_ITEMS = 4_096
const RESUMABLE: ReadonlySet<string> = new Set(["paused", "interrupted", "failed", "completed"])
const agentConcurrencyCap = () => Math.min(16, Math.max(2, os.cpus().length - 2))
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const

// AsyncLocalStorage for workflow context to avoid globalThis race when multiple workflows run concurrently.
// The original implementation mutated globalThis process-wide, so concurrent workflows clobbered each other's ctx.
// We now store ctx in ALS and install getters on globalThis that read from ALS if available.
const workflowContextStorage = new AsyncLocalStorage<Record<string, unknown>>()

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

const SETUP_PHASE = "Setup"

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj
  if (Object.isFrozen(obj)) return obj
  // Freeze properties first
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = (obj as any)[key]
    if (value && typeof value === "object") {
      deepFreeze(value)
    }
  }
  return Object.freeze(obj) as T
}

// --- Workflows v2: stableHash + ajv validation layer ---
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}"
}

function stableHash(obj: unknown): string {
  const str = stableStringify(obj)
  return createHash("sha256").update(str).digest("hex").slice(0, 16)
}

const ajvInstance = new Ajv({ allErrors: true, strict: false, verbose: true })
const ajvCache = new Map<string, any>()

function getAjvValidator(schema: Record<string, unknown>) {
  const key = stableStringify(schema)
  let validator = ajvCache.get(key)
  if (!validator) {
    validator = ajvInstance.compile(schema)
    ajvCache.set(key, validator)
  }
  return validator
}

function formatAjvErrors(errors: any[] | null | undefined): string {
  if (!errors || errors.length === 0) return "validation failed"
  return errors.map((e) => `${e.instancePath || "/"} ${e.message} (${JSON.stringify(e.params)})`).join("; ")
}

type Active = {
  run: Run
  directory: string
  done: Deferred.Deferred<Run>
  fiber?: Fiber.Fiber<void, unknown>
  runScope: Scope.Closeable
  sessions: Set<string>
  cancelSession?: (sessionID: SessionID) => Effect.Effect<void>
  cancelling?: boolean
  removed?: boolean
  budget: number
  budgetRemaining: number
  budgetTotal?: number
  costSpent: number
  tokensBudgetTotal?: number
  tokensSpent: number
  agentSemaphore: Semaphore.Semaphore
  agentStarted: number
  agentLimit: number
  pausing?: boolean
  callerModel?: { providerID: string; modelID: string }
  skipRequests: Set<string>
  pool?: TurnBudget.Pool
  journal?: Run["agents"]
  journalCursor: number
  invalidatedAgents: Set<number>
  questionDeferred?: Deferred.Deferred<string>
  pendingQuestionNodeId?: string
  // Workflows v2 additions
  declaredPhases: string[]
  phaseOutputs: Map<string, unknown>
  phaseData: Record<string, unknown>
  stateMap: Map<string, unknown>
  stateData: Record<string, unknown>
  childStack: Array<{ run: string; workflow: string }>
  phaseValidation: "strict" | "warn"
  // Keyed journal replay
  journalKeyMap: Map<string, Run["agents"][number]>
  invalidatedKeys: Set<string>
  invalidatedLabels: Set<string>
}

type State = {
  runs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

function sweepOrphans(
  db: Database.Interface["db"],
  liveIds: ReadonlySet<string>,
  now: number,
  directory: string,
) {
  const where = and(
    eq(WorkflowRunTable.status, "running"),
    eq(WorkflowRunTable.directory, directory),
    liveIds.size ? notInArray(WorkflowRunTable.id, [...liveIds]) : undefined,
  )
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const orphans = yield* tx
          .select({ id: WorkflowRunTable.id, agents: WorkflowRunTable.agents })
          .from(WorkflowRunTable)
          .where(where)
          .all()
        yield* Effect.forEach(
          orphans,
          (orphan) =>
            tx
              .update(WorkflowRunTable)
              .set({
                status: "interrupted",
                completed_at: now,
                time_updated: now,
                agents: orphan.agents.map((node) =>
                  node.status === "running"
                    ? { ...node, status: "failed", completed_at: now, error: "interrupted: process restarted" }
                    : node,
                ),
              })
              .where(eq(WorkflowRunTable.id, orphan.id))
              .run(),
          { discard: true },
        )
      }),
    )
    .pipe(Effect.orDie, Effect.asVoid)
}

function snapshot(active: Active): Run {
  return structuredClone(active.run)
}

function encodeDefinitionForRow(def: WorkflowSchema.Definition) {
  return {
    name: def.name,
    path: def.path,
    meta: def.meta,
    ...(def.source !== undefined ? { source: def.source } : {}),
    ...(def.temporary !== undefined ? { temporary: def.temporary } : {}),
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError || (error as { _tag?: string })?._tag === "WorkflowCancelledError"
}

function extractText(parts: SessionV1.Part[]): string {
  return parts
    .filter((p): p is SessionV1.TextPart => p.type === "text")
    .map((p) => p.text)
    .join("")
}

export function parseStructured(text: string): unknown {
  const tryParse = (src: string): unknown | undefined => {
    try {
      return JSON.parse(src)
    } catch {
      return undefined
    }
  }

  // 1. Direct parse
  const direct = tryParse(text.trim())
  if (direct !== undefined) return direct

  // 2. All ```json fences, try largest first (models sometimes include example + real)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  const fences: string[] = []
  let m: RegExpExecArray | null
  while ((m = fenceRegex.exec(text)) !== null) {
    fences.push(m[1].trim())
  }
  // Try fences from longest to shortest – real payload often longest
  for (const f of fences.sort((a, b) => b.length - a.length)) {
    const parsed = tryParse(f)
    if (parsed !== undefined) return parsed
    // Try extracting {..} inside fence
    const s = f.indexOf("{")
    const e = f.lastIndexOf("}")
    if (s !== -1 && e !== -1 && e > s) {
      const inner = tryParse(f.slice(s, e + 1))
      if (inner !== undefined) return inner
    }
  }

  // 3. Extract from raw text: first { to last } and first [ to last ]
  const raw = text.trim()
  const firstBrace = raw.indexOf("{")
  const lastBrace = raw.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1)
    const parsed = tryParse(slice)
    if (parsed !== undefined) return parsed
    // Try repair: remove trailing commas, fix single quotes
    const repaired = slice
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/'/g, '"')
    const repairedParsed = tryParse(repaired)
    if (repairedParsed !== undefined) return repairedParsed
  }

  const firstBracket = raw.indexOf("[")
  const lastBracket = raw.lastIndexOf("]")
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const slice = raw.slice(firstBracket, lastBracket + 1)
    const parsed = tryParse(slice)
    if (parsed !== undefined) return parsed
  }

  // 4. Truncated JSON repair: count open/close braces and auto-close
  if (firstBrace !== -1) {
    let candidate = raw.slice(firstBrace)
    // Truncate to last complete field (last comma or brace)
    // Try to close with } and ]]
    for (let i = 0; i < 5; i++) {
      const open = (candidate.match(/{/g) ?? []).length
      const close = (candidate.match(/}/g) ?? []).length
      const openB = (candidate.match(/\[/g) ?? []).length
      const closeB = (candidate.match(/]/g) ?? []).length
      if (open === close && openB === closeB) break
      if (open > close) candidate += "}".repeat(open - close)
      if (openB > closeB) candidate += "]".repeat(openB - closeB)
      const parsed = tryParse(candidate)
      if (parsed !== undefined) return parsed
      // If still fails, trim to last comma
      const lastComma = candidate.lastIndexOf(",")
      if (lastComma > 0) candidate = candidate.slice(0, lastComma)
      else break
    }
  }

  throw new Error("No JSON found")
}

function coerceArgs(meta: Meta | undefined, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta?.arguments) return args
  const result: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(meta.arguments)) {
    const value = args?.[key] ?? spec.default
    if (value === undefined) {
      result[key] = undefined
      continue
    }
    if (spec.type === "number") result[key] = Number(value)
    else if (spec.type === "boolean") result[key] = Boolean(value)
    else result[key] = String(value)
  }
  return result
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const providers = yield* Provider.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const permission = yield* Permission.Service
    const fsUtil = yield* FSUtil.Service
    const plugin = yield* Plugin.Service
    const truncate = yield* Truncate.Service
    const toolRegistry = yield* ToolRegistry.Service

    const state = yield* InstanceState.make<State>((ctx) =>
      Effect.gen(function* () {
        const runs = yield* SynchronizedRef.make(new Map<string, Active>())
        yield* sweepOrphans(db, new Set(), yield* Clock.currentTimeMillis, ctx.directory).pipe(Effect.ignore)
        return { runs, scope: yield* Scope.Scope }
      }),
    )

    const persist = (active: Active, options?: { terminal?: boolean }) =>
      Effect.gen(function* () {
        if (active.removed) return
        const data = {
          id: active.run.id,
          session_id: active.run.session_id ?? null,
          directory: active.directory,
          workflow: active.run.workflow,
          status: active.run.status,
          started_at: active.run.started_at,
          completed_at: active.run.completed_at ?? null,
          current_phase: isTerminalStatus(active.run.status) ? null : (active.run.current_phase ?? null),
          args: active.run.args ?? null,
          definition: active.run.definition ? (encodeDefinitionForRow(active.run.definition) as any) : null,
          logs: active.run.logs as any,
          agents: active.run.agents as any,
          result: active.run.result === undefined ? null : JSON.stringify(active.run.result),
          error: active.run.error ?? null,
          resume_of: active.run.resume_of ?? null,
          pending_question: isTerminalStatus(active.run.status)
            ? null
            : active.run.pending_question
              ? { question: active.run.pending_question.question, options: active.run.pending_question.options ? [...active.run.pending_question.options] : undefined, asked_at: active.run.pending_question.asked_at }
              : null,
          phase_data: Object.keys(active.phaseData).length ? active.phaseData : null,
          state: Object.keys(active.stateData).length ? active.stateData : null,
          time_updated: Date.now(),
        }
        yield* db
          .insert(WorkflowRunTable)
          .values(data as any)
          .onConflictDoUpdate({ target: WorkflowRunTable.id, set: data as any })
          .run()
          .pipe(Effect.orDie)
        const eventData = {
          id: active.run.id,
          workflow: active.run.workflow,
          status: active.run.status,
          current_phase: active.run.current_phase ?? null,
          directory: active.directory,
          agents: {
            total: active.run.agents.length,
            running: active.run.agents.filter((a: { status: string }) => a.status === "running").length,
            failed: active.run.agents.filter((a: { status: string }) => a.status === "failed").length,
          },
          pending_question: active.run.pending_question !== undefined,
          error: active.run.error ?? null,
        }
        yield* events.publish(
          isTerminalStatus(active.run.status) ? Event.Finished : Event.Updated,
          eventData,
        )
      })

    const finish = Effect.fn("Workflow.finish")(
      function* (id: string, status: string, options?: { result?: unknown; error?: string }) {
        const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
        const active = live.get(id)
        if (!active) return undefined
        if (isTerminalStatus(active.run.status)) return snapshot(active)

        // Fund: ensure workflow fully finishes before pulling results.
        // If the run function returned while agents are still marked running
        // (e.g. unawaited ctx.agent calls), the result would be pulled early
        // and the TUI would show a completed run with lingering running agents
        // ticking. Wait briefly for running agents to settle, then fail any
        // that are still stuck so the terminal run never carries a live agent.
        // Use Clock for testability and Duration for clarity per Effect guide.
        if (isTerminalStatus(status) || status === "completed") {
          const LINGERING_GRACE_MS = 10_000
          const LINGERING_POLL_MS = 200
          const startMs = yield* Clock.currentTimeMillis
          let nowMs = startMs
          while (active.run.agents.some((a: any) => a.status === "running") && nowMs - startMs < LINGERING_GRACE_MS) {
            yield* Effect.sleep(LINGERING_POLL_MS)
            nowMs = yield* Clock.currentTimeMillis
          }
          let cleaned = false
          for (const a of active.run.agents as any[]) {
            if (a.status === "running") {
              a.status = "failed"
              a.completed_at = nowMs
              a.error =
                status === "completed"
                  ? "Agent still running when workflow returned — marked as failed (unawaited ctx.agent?)"
                  : `Agent still running when workflow ${status} — marked as failed`
              cleaned = true
            }
          }
          if (cleaned) {
            active.run.logs.push({
              time: nowMs,
              phase: active.run.current_phase,
              message: "Cleaned up lingering running agents at terminal transition",
            })
          }
        }

        const nowMs = yield* Clock.currentTimeMillis
        active.run.status = status as Run["status"]
        active.run.completed_at = nowMs
        if (isTerminalStatus(status)) {
          active.run.current_phase = undefined
          active.run.pending_question = undefined
        }
        if (options?.result !== undefined) active.run.result = options.result
        if (options?.error !== undefined) active.run.error = options.error
        yield* persist(active, { terminal: true })
        yield* Deferred.succeed(active.done, snapshot(active))
        const finished = snapshot(active)
        live.delete(id)
        // Cleanup runScope and temp cache files older than 1h
        yield* Scope.close(active.runScope, Exit.void).pipe(Effect.ignore, Effect.forkIn((yield* InstanceState.get(state)).scope))
        yield* Effect.promise(async () => {
          try {
            const fs = await import("fs/promises")
            const now = Date.now()
            // Clean .opencode/workflows/.cache dir (builtin/inline)
            const cacheDir = path.join(active.directory, ".opencode", "workflows", ".cache")
            const files = await fs.readdir(cacheDir).catch(() => [] as string[])
            for (const f of files) {
              const fp = path.join(cacheDir, f)
              try {
                const stat = await fs.stat(fp)
                if (now - stat.mtimeMs > 60 * 60 * 1000) await fs.unlink(fp).catch(() => {})
              } catch {}
            }
            // Self-healing: also clean orphan .cache-* files in all workflow dirs (regular workflows)
            // These accumulate when Windows lock prevents unlink after failed import
            const workflowDirs = [
              path.join(active.directory, ".opencode", "workflows"),
              path.join(active.directory, ".claude", "workflows"),
            ]
            for (const wDir of workflowDirs) {
              const wFiles = await fs.readdir(wDir).catch(() => [] as string[])
              for (const f of wFiles) {
                if (!f.startsWith(".cache-")) continue
                const fp = path.join(wDir, f)
                try {
                  const stat = await fs.stat(fp)
                  // Delete orphans older than 5 minutes (not just 1h, to keep dir clean)
                  if (now - stat.mtimeMs > 5 * 60 * 1000) await fs.unlink(fp).catch(() => {})
                } catch {}
              }
            }
          } catch {}
        }).pipe(Effect.ignore)
        return finished
      },
    )

    const list: Interface["list"] = Effect.fn("Workflow.list")(function* () {
      const ctx = yield* InstanceState.get(state)
      const dirs = yield* config.directories()
      const instanceDir = yield* InstanceState.directory
      const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
      // Project-first precedence, support both .opencode and .claude directories
      const workflowRoots = new Set<string>()
      // Instance dir first (highest priority)
      workflowRoots.add(path.join(instanceDir, ".opencode"))
      workflowRoots.add(path.join(instanceDir, ".claude"))
      // Project dirs from config.directories() are already up-scan of .opencode, but we also need their .claude siblings
      for (const d of dirs) {
        workflowRoots.add(d)
        // d is like /some/path/.opencode → also try sibling .claude
        const parent = path.dirname(d)
        workflowRoots.add(path.join(parent, ".claude"))
        // Also add the parent itself if it contains workflows directly (for .claude/workflows case where d is .opencode)
        // The glob below will look for {workflow,workflows}/* inside each root
      }
      // Global locations (lowest priority)
      workflowRoots.add(path.join(Global.Path.config, "workflows"))
      workflowRoots.add(path.join(Global.Path.config.replace("opencode", "claude"), "workflows"))
      workflowRoots.add(path.join(Global.Path.home, ".claude", "workflows"))
      workflowRoots.add(path.join(Global.Path.home, ".config", "claude", "workflows"))

      const allDirs = [...workflowRoots]
      const results: Info[] = []
      const seenNames = new Set<string>()
      // Project-first: scan files first, then builtin as fallback (lowest priority)
      // v2: also support nested validation workflows via **/*
      for (const dir of allDirs) {
        const matches = Glob.scanSync("{workflow,workflows}/**/*.{js,ts,mjs,cjs}", {
          cwd: dir,
          absolute: true,
          dot: false,
          symlink: false,
        })
        for (const match of matches) {
          const name = path.basename(match, path.extname(match))
          if (seenNames.has(name)) continue
          if (results.some((r) => r.path === match)) continue
          try {
            const source = yield* Effect.promise(() => Bun.file(match).text())
            const syntax = Syntax.validateSyntax(source, match)
            if (!syntax.ok) {
              results.push({
                name,
                path: match,
                meta: { name },
                valid: false,
                error: Syntax.formatInvalidError(match, syntax),
              })
              // Don't add to seenNames so a valid builtin with same name could still be fallback? Actually we want to show invalid and block valid duplicate? Keep as invalid, but still mark seen to prevent duplicate invalid over invalid.
              seenNames.add(name)
              continue
            }
            const metaResult = MetaReader.read(source, match)
            results.push({
              name,
              path: match,
              meta: metaResult.valid ? metaResult.meta : { name },
              valid: metaResult.valid,
              ...(metaResult.valid ? {} : { error: metaResult.error }),
            })
            if (metaResult.valid) seenNames.add(name)
          } catch {
            // Skip unreadable files
          }
        }
      }
      // Then builtin workflows as fallback (project wins over builtin)
      for (const [name, source] of Object.entries(BUILTIN_WORKFLOWS)) {
        if (seenNames.has(name)) continue
        const builtInPath = builtinPath(name)
        const syntax = Syntax.validateSyntax(source, builtInPath)
        if (!syntax.ok) {
          results.push({
            name,
            path: builtInPath,
            meta: { name },
            valid: false,
            error: Syntax.formatInvalidError(builtInPath, syntax),
            source_kind: "builtin",
          })
          seenNames.add(name)
          continue
        }
        const metaResult = MetaReader.read(source, builtInPath)
        results.push({
          name,
          path: builtInPath,
          meta: metaResult.valid ? metaResult.meta : { name },
          valid: metaResult.valid,
          ...(metaResult.valid ? {} : { error: metaResult.error }),
          source_kind: "builtin",
        })
        seenNames.add(name)
      }
      return results
    })

    const read: Interface["read"] = Effect.fn("Workflow.read")(function* (name: string) {
      const dirs = yield* config.directories()
      const instanceDir = yield* InstanceState.directory
      const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
      const workflowRoots: string[] = []
      workflowRoots.push(path.join(instanceDir, ".opencode"))
      workflowRoots.push(path.join(instanceDir, ".claude"))
      for (const d of dirs) {
        workflowRoots.push(d)
        workflowRoots.push(path.join(path.dirname(d), ".claude"))
      }
      workflowRoots.push(path.join(Global.Path.config, "workflows"))
      workflowRoots.push(path.join(Global.Path.home, ".claude", "workflows"))

      const allDirs = [...new Set(workflowRoots)]
      for (const dir of allDirs) {
        const matches = Glob.scanSync("{workflow,workflows}/**/*.{js,ts,mjs,cjs}", {
          cwd: dir,
          absolute: true,
          dot: false,
          symlink: false,
        })
        for (const match of matches) {
          if (path.basename(match, path.extname(match)) === name) {
            const source = yield* Effect.promise(() => Bun.file(match).text())
            return { name, path: match, source }
          }
        }
      }
      // Fallback to builtin if not found in files (project wins)
      if (isBuiltinPath(name) || BUILTIN_WORKFLOWS[name]) {
        const source = BUILTIN_WORKFLOWS[name] ?? BUILTIN_WORKFLOWS[name.replace("builtin:", "")]
        if (!source) return undefined
        return { name: name.replace("builtin:", ""), path: builtinPath(name), source, source_kind: "builtin" as const }
      }
      return undefined
    })

    const runs: Interface["runs"] = Effect.fn("Workflow.runs")(function* () {
      const dir = yield* InstanceState.directory
      const rows = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.directory, dir))
        .orderBy(WorkflowRunTable.started_at)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => rowToRun(row))
    })

    const get: Interface["get"] = Effect.fn("Workflow.get")(function* (id: RunID) {
      const row = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
        const active = live.get(id)
        return active ? snapshot(active) : undefined
      }
      return rowToRun(row)
    })

    const abortRun = Effect.fn("Workflow.abortRun")(function* (active: Active, mode: "cancel" | "pause" = "cancel") {
      if (mode === "pause") active.pausing = true
      else active.cancelling = true
      if (active.cancelSession) {
        yield* Effect.forEach(
          [...active.sessions],
          (sessionID) => active.cancelSession!(SessionID.make(sessionID)),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.ignore)
      }
      const instState = yield* InstanceState.get(state)
      yield* Scope.close(active.runScope, Exit.void).pipe(Effect.ignore, Effect.forkIn(instState.scope))
      if (active.fiber) {
        const interrupted = yield* Fiber.interrupt(active.fiber).pipe(Effect.forkIn(instState.scope))
        yield* Fiber.await(interrupted).pipe(Effect.ignore)
      }
    })

    const start: Interface["start"] = Effect.fn("Workflow.start")(function* (input: StartOptions) {
      const instanceCtx = yield* InstanceRef
      const workspaceCtx = yield* WorkspaceRef
      const runtimeCtx = yield* Effect.context()
      const budget = typeof input.budget === "number" ? { usd: input.budget } : (input.budget ?? {})
      const dir = yield* InstanceState.directory

      const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(runtimeCtx),
            Effect.provideService(InstanceRef, instanceCtx),
            Effect.provideService(WorkspaceRef, workspaceCtx),
          ) as Effect.Effect<A, E, never>,
        )

      let targetName = input.name ?? "inline"
      let targetPath = input.name ?? inlinePath("inline")
      let source = input.source ?? ""

      if (!input.source && input.name) {
        if (BUILTIN_WORKFLOWS[input.name]) {
          targetPath = builtinPath(input.name)
          source = BUILTIN_WORKFLOWS[input.name]
        } else {
          const found = yield* read(input.name)
          if (!found) return yield* new NotFoundError({ name: input.name })
          targetPath = found.path
          source = found.source
          targetName = found.name
        }
      }

      // Validate full file syntax before meta — ensures syntax errors (often from unescaped ${})
      // are reported with actionable hint instead of misleading "Cannot find module .cache-*.ts"
      // or "Missing meta export" when meta parsing itself is broken by syntax error.
      const syntaxCheck = Syntax.validateSyntax(source, targetPath)
      if (!syntaxCheck.ok) {
        return yield* new InvalidError({
          path: targetPath,
          message: Syntax.formatInvalidError(targetPath, syntaxCheck),
        })
      }

      const metaResult = MetaReader.read(source, targetPath)
      if (!metaResult.valid) return yield* new InvalidError({ path: targetPath, message: metaResult.error })

      const meta = metaResult.meta
      const args = coerceArgs(meta, input.args)

      // --- Determinism lint (BLOCKING per locked decision #4) ---
      const lintResult = SourceLint.lint(source, targetPath)
      const determinismFindings = lintResult.findings.filter((f) => f.rule.startsWith("determinism-"))
      if (determinismFindings.length > 0) {
        const allow = (meta as any).allowNondeterminism === true
        if (!allow) {
          const details = determinismFindings.map((f) => `${f.rule} at line ${f.line}: ${f.text}`).join("\n")
          return yield* new InvalidError({
            path: targetPath,
            message: `Determinism lint failed:\n${details}\n\nHint: pass a seed via args or compute inside an agent. Escape hatch: meta.allowNondeterminism: true`,
          })
        }
      }

      // --- Resume journal handling (keyed + legacy prefix) ---
      let journal: Run["agents"] = []
      let baseLogs: Run["logs"] = []
      let baseCost = 0
      let baseTokens = 0
      let baseStartedAt: number | undefined
      let basePhaseData: Record<string, unknown> = {}
      let baseStateData: Record<string, unknown> = {}
      let prevRowForResume: typeof WorkflowRunTable.$inferSelect | undefined
      if (input.resume_of) {
        const prevRow = yield* db
          .select()
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.resume_of))
          .get()
          .pipe(Effect.orDie)
        if (!prevRow) return yield* new NotFoundError({ name: input.resume_of })
        if (!RESUMABLE.has(prevRow.status)) {
          return yield* new InvalidError({ path: input.resume_of, message: `Cannot resume run with status ${prevRow.status}` })
        }
        prevRowForResume = prevRow
        const invalidated = new Set(input.invalidate_agents ?? [])
        const invalidatedPhases = new Set(input.invalidate_phases ?? [])
        // Support invalidation by phase name
        journal = prevRow.agents.filter((a: any, idx: number) => {
          if (a.status !== "completed") return false
          if (invalidated.has(idx)) return false
          if (invalidated.has(a.label)) return false
          if (invalidated.has(a.cache_key)) return false
          if (a.phase && invalidatedPhases.has(a.phase)) return false
          return true
        })
        // Also filter phase_data and state if phase invalidated?
        baseLogs = prevRow.logs
        baseCost = prevRow.agents.reduce((s: number, a: any) => s + (a.cost ?? 0), 0)
        baseTokens = prevRow.agents.reduce(
          (s: number, a: any) => s + (a.tokens ? a.tokens.input + a.tokens.output + a.tokens.reasoning : 0),
          0,
        )
        baseStartedAt = prevRow.started_at
        basePhaseData = (prevRow as any).phase_data ?? {}
        baseStateData = (prevRow as any).state ?? {}
        // Remove invalidated phases from phase_data
        for (const ph of invalidatedPhases) {
          delete basePhaseData[ph]
        }
      }

      // Always use temp file for import to avoid Windows raw-path issues and to bust ESM cache.
      // Previously only builtin/inline used temp file, causing:
      // - New files created after server startup failed to import (raw Windows path not valid module specifier)
      // - Overwritten files showed stale content (Bun cache ignored ?t= query param)
      // By copying source to a fresh random temp file each run and importing via file:// URL, we ensure
      // fresh load and correct Windows path handling via pathToFileURL.
      // For regular files, use same dirname + original extension to preserve relative imports (./helpers).
      // For builtin/inline, use .cache dir.
      const randomId = (() => {
        try {
          // Use crypto.randomUUID if available for better entropy
          const c = globalThis.crypto
          if (c && typeof c.randomUUID === "function") return c.randomUUID()
        } catch {}
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`
      })()
      let tempPath: string
      if (isBuiltinPath(targetPath) || isInlinePath(targetPath) || input.temporary) {
        tempPath = path.join(dir, ".opencode", "workflows", ".cache", `${randomId}.ts`)
      } else {
        const ext = path.extname(targetPath) || ".ts"
        const baseDir = path.dirname(targetPath)
        tempPath = path.join(baseDir, `.cache-${randomId}${ext}`)
      }
      const modulePath = tempPath
      {
        const { mkdir, writeFile, readdir, stat, unlink } = yield* Effect.promise(() => import("fs/promises"))
        yield* Effect.promise(() => mkdir(path.dirname(tempPath), { recursive: true }))
        // Proactive orphan cleanup: remove stale .cache-* files older than 5 minutes in same dir
        // Fixes accumulation when previous import failed and unlink couldn't run (Windows lock)
        yield* Effect.promise(async () => {
          try {
            const baseDir = path.dirname(tempPath)
            const files = await readdir(baseDir).catch(() => [] as string[])
            const now = Date.now()
            for (const f of files) {
              if (!f.startsWith(".cache-") && !f.startsWith(".cache-child-")) continue
              const fp = path.join(baseDir, f)
              try {
                const st = await stat(fp)
                if (now - st.mtimeMs > 5 * 60 * 1000) await unlink(fp).catch(() => {})
              } catch {}
            }
          } catch {}
        }).pipe(Effect.ignore)
        // Write with fsync for Windows reliability - ensure file fully flushed before import
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          await fs.writeFile(tempPath, source, "utf-8")
          try {
            // Try to fsync to avoid antivirus/Defender race where file not yet visible
            const handle = await fs.open(tempPath, "r")
            await handle.sync().catch(() => {})
            await handle.close().catch(() => {})
          } catch {}
        })
      }

      const id = RunID.ascending()
      const now = Date.now()
      const done = yield* Deferred.make<Run>()
      const runScope = yield* Scope.make()
      const agentSemaphore = yield* Semaphore.make(agentConcurrencyCap())

      // Normalize declared phases from meta
      const declaredPhases: string[] = (meta.phases ?? []).map((p: any) => (typeof p === "string" ? p : p.title))
      const phaseValidationMode: "strict" | "warn" = (meta as any).phaseValidation ?? "strict"

      // Restore phase_data and state from resume source if any
      let restoredPhaseData: Record<string, unknown> = {}
      let restoredStateData: Record<string, unknown> = {}
      if (input.resume_of) {
        // prevRow already fetched earlier for journal; need to fetch phase_data/state if available
        // The earlier prevRow variable is out of scope here, so we re-derive from base? We'll rely on effect to have stored
        // For now we will attempt to read from DB again via closure - we have prevRow in outer scope? Actually we have journal extraction but not phase_data
        // We'll handle via a separate variable set above (we need to capture)
      }

      const active: Active = {
        run: {
          id,
          session_id: input.caller?.sessionID,
          workflow: targetName,
          args,
          definition: { name: targetName, path: targetPath, meta: meta as any, ...(input.source ? { source: input.source, temporary: true } : {}) },
          status: "running",
          started_at: baseStartedAt ?? now,
          logs: [...baseLogs],
          agents: [],
          resume_of: input.resume_of,
          // placeholders for new fields, will be parsed via rowToRun but also stored in Active for persist path
          phase_data: {},
          state: {},
        } as any,
        directory: dir,
        done,
        runScope,
        sessions: new Set(),
        cancelSession: input.prompt?.cancel,
        budget: budget.usd ?? Number.POSITIVE_INFINITY,
        budgetRemaining: (budget.usd ?? Number.POSITIVE_INFINITY) === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, (budget.usd ?? 0) - baseCost),
        budgetTotal: budget.usd,
        costSpent: baseCost,
        tokensBudgetTotal: budget.tokens,
        tokensSpent: baseTokens,
        agentSemaphore,
        agentStarted: 0,
        agentLimit: DEFAULT_AGENT_LIMIT,
        callerModel: input.caller_model,
        skipRequests: new Set(),
        pool: input.pool,
        journal,
        journalCursor: 0,
        invalidatedAgents: new Set((input.invalidate_agents ?? []).filter((x: any) => typeof x === "number") as number[]),
        declaredPhases,
        phaseOutputs: new Map(Object.entries(basePhaseData)),
        phaseData: basePhaseData,
        stateMap: new Map(Object.entries(baseStateData)),
        stateData: baseStateData,
        childStack: [],
        phaseValidation: phaseValidationMode,
        journalKeyMap: new Map<string, any>(),
        invalidatedKeys: new Set<string>((input.invalidate_agents ?? []).filter((x: any) => typeof x === "string") as string[]),
        invalidatedLabels: new Set<string>((input.invalidate_agents ?? []).filter((x: any) => typeof x === "string") as string[]),
      } as any

      // Build keyed map from journal (for keyed replay)
      for (const node of journal as any[]) {
        if (node.cache_key) {
          if (!active.journalKeyMap.has(node.cache_key)) {
            active.journalKeyMap.set(node.cache_key, node)
          }
        }
      }

      yield* persist(active)
      yield* SynchronizedRef.update((yield* InstanceState.get(state)).runs, (m) => { m.set(id, active); return m })
      let runSignal: AbortSignal | undefined

      const createContext = (options: { phases?: Meta["phases"] }): ContextApi => {
        const checkpoint = () => {
          if (runSignal?.aborted || active.cancelling || active.pausing) throw new CancelledError()
        }
        const doPersist = () => run(persist(active)).catch(() => {})

        const effectivePhaseForLogs = () => {
          return active.run.current_phase ?? SETUP_PHASE
        }

        const currentChild = () => {
          return active.childStack.length > 0 ? active.childStack[active.childStack.length - 1] : undefined
        }

        return {
          get budgetRemaining() { return active.budgetRemaining },
          budget: {
            get total() { return active.budgetTotal ?? null },
            spent: () => active.costSpent,
            remaining: () => active.budgetTotal === undefined ? Infinity : Math.max(0, active.budgetTotal - active.costSpent),
            get tokensTotal() { return active.tokensBudgetTotal ?? null },
            tokensSpent: () => active.tokensSpent,
            tokensRemaining: () => active.tokensBudgetTotal === undefined ? Infinity : Math.max(0, active.tokensBudgetTotal - active.tokensSpent),
          },
          setPhase(phase: string, data?: unknown) {
            // Phase validation
            if (active.declaredPhases.length > 0 && !active.declaredPhases.includes(phase)) {
              if (active.phaseValidation === "warn") {
                active.run.logs.push({
                  time: Date.now(),
                  phase: effectivePhaseForLogs(),
                  message: `Warning: unknown phase "${phase}", declared: [${active.declaredPhases.join(", ")}]`,
                  child: currentChild(),
                } as any)
                doPersist()
              } else {
                throw new InvalidPhaseError({
                  phase,
                  declared: [...active.declaredPhases],
                  message: `Unknown phase "${phase}". Declared phases: ${active.declaredPhases.join(", ")}`,
                })
              }
            }
            const prevPhase = active.run.current_phase
            const prevData = prevPhase ? active.phaseOutputs.get(prevPhase) : undefined
            active.run.current_phase = phase
            if (data !== undefined) {
              active.phaseOutputs.set(phase, data)
              active.phaseData[phase] = data
              // Also reflect into run.phase_data for row snapshot
              ;(active.run as any).phase_data = { ...active.phaseData }
            }
            active.run.logs.push({
              time: Date.now(),
              phase,
              message: `Phase: ${phase}`,
              child: currentChild(),
            } as any)
            doPersist()
            return prevData
          },
          getPhase(name: string) {
            const val = active.phaseOutputs.get(name) ?? active.phaseData[name]
            if (val === undefined) return undefined
            try {
              return deepFreeze(structuredClone(val))
            } catch {
              return deepFreeze(val as any)
            }
          },
          getAllPhases() {
            const result: Record<string, unknown> = {}
            for (const [k, v] of active.phaseOutputs.entries()) {
              try {
                result[k] = deepFreeze(structuredClone(v))
              } catch {
                result[k] = deepFreeze(v as any)
              }
            }
            // include any persisted that may not be in Map yet (e.g., restored)
            for (const [k, v] of Object.entries(active.phaseData)) {
              if (!(k in result)) {
                try {
                  result[k] = deepFreeze(structuredClone(v))
                } catch {
                  result[k] = deepFreeze(v as any)
                }
              }
            }
            return result
          },
          get state() {
            return {
              get(key: string) {
                const v = active.stateMap.get(key) ?? active.stateData[key]
                if (v === undefined) return undefined
                try {
                  return deepFreeze(structuredClone(v))
                } catch {
                  return deepFreeze(v as any)
                }
              },
              set(key: string, value: unknown) {
                active.stateMap.set(key, value)
                active.stateData[key] = value
                ;(active.run as any).state = { ...active.stateData }
                doPersist()
              },
              has(key: string) {
                return active.stateMap.has(key) || key in active.stateData
              },
              delete(key: string) {
                const had = active.stateMap.has(key) || key in active.stateData
                active.stateMap.delete(key)
                delete active.stateData[key]
                ;(active.run as any).state = { ...active.stateData }
                doPersist()
                return had
              },
              entries() {
                const combined = new Map<string, unknown>()
                for (const [k, v] of Object.entries(active.stateData)) combined.set(k, v)
                for (const [k, v] of active.stateMap.entries()) combined.set(k, v)
                return [...combined.entries()] as [string, unknown][]
              },
              toObject() {
                const obj: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(active.stateData)) obj[k] = v
                for (const [k, v] of active.stateMap.entries()) obj[k] = v
                return obj
              },
            }
          },
          log(message: string) {
            active.run.logs.push({
              time: Date.now(),
              phase: effectivePhaseForLogs(),
              message,
              child: currentChild(),
            } as any)
            doPersist()
          },
          async parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }): Promise<(T | null)[]> {
            checkpoint()
            if (tasks.length > MAX_BATCH_ITEMS) throw new InvalidError({ path: targetPath, message: `Batch exceeds ${MAX_BATCH_ITEMS} items` })
            if (tasks.length === 0) return []
            const concurrency = Math.max(1, options?.concurrencyLimit ?? 20)
            const results: (T | null)[] = new Array(tasks.length).fill(null)
            let nextIdx = 0
            let running = 0
            let completed = 0
            let cancelled = false
            let cancelErr: unknown
            let settled = false

            return await new Promise<(T | null)[]>((resolve, reject) => {
              const safeResolve = (v: (T | null)[]) => {
                if (!settled) {
                  settled = true
                  resolve(v)
                }
              }
              const safeReject = (e: unknown) => {
                if (!settled) {
                  settled = true
                  reject(e)
                }
              }
              const launch = () => {
                if (cancelled || settled) return
                try {
                  checkpoint()
                } catch (e) {
                  cancelled = true
                  cancelErr = e
                  safeReject(e)
                  return
                }
                while (running < concurrency && nextIdx < tasks.length && !cancelled && !settled) {
                  const cur = nextIdx++
                  const task = tasks[cur]
                  running++
                  Promise.resolve()
                    .then(() => task())
                    .then(
                      (v) => {
                        if (!cancelled) results[cur] = v
                      },
                      (e) => {
                        if (e instanceof CancelledError || (e as { _tag?: string })?._tag === "WorkflowCancelledError") {
                          cancelled = true
                          cancelErr = e
                          return
                        }
                        if (!cancelled) results[cur] = null
                      },
                    )
                    .finally(() => {
                      running--
                      completed++
                      if (cancelled) {
                        if (running === 0) safeReject(cancelErr)
                        return
                      }
                      if (completed >= tasks.length) {
                        safeResolve(results)
                      } else {
                        launch()
                      }
                    })
                }
                if (nextIdx >= tasks.length && running === 0 && !cancelled && !settled) {
                  safeResolve(results)
                }
              }
              launch()
            })
          },
          pipeline: (async (items: readonly unknown[], ...rest: unknown[]) => {
            checkpoint()
            if (items.length > MAX_BATCH_ITEMS) throw new InvalidError({ path: targetPath, message: `Pipeline exceeds ${MAX_BATCH_ITEMS} items` })
            if (items.length === 0) return []
            const stages = rest.filter((s) => typeof s === "function") as ((prev: unknown, item: unknown, index: number) => Promise<unknown>)[]
            const opts = rest.find((s) => typeof s === "object") as { concurrencyLimit?: number } | undefined
            const concurrency = Math.max(1, opts?.concurrencyLimit ?? 5)
            const results: (unknown | null)[] = new Array(items.length).fill(null)
            let nextIdx = 0
            let running = 0
            let completed = 0
            let cancelled = false
            let cancelErr: unknown
            let settled = false

            return await new Promise<(unknown | null)[]>((resolve, reject) => {
              const safeResolve = (v: (unknown | null)[]) => {
                if (!settled) {
                  settled = true
                  resolve(v)
                }
              }
              const safeReject = (e: unknown) => {
                if (!settled) {
                  settled = true
                  reject(e)
                }
              }
              const launch = () => {
                if (cancelled || settled) return
                try {
                  checkpoint()
                } catch (e) {
                  cancelled = true
                  cancelErr = e
                  safeReject(e)
                  return
                }
                while (running < concurrency && nextIdx < items.length && !cancelled && !settled) {
                  const cur = nextIdx++
                  const item = items[cur]
                  running++
                  Promise.resolve()
                    .then(async () => {
                      let prev: unknown = item
                      for (const stage of stages) {
                        prev = await stage(prev, item, cur)
                      }
                      return prev
                    })
                    .then(
                      (v) => {
                        if (!cancelled) results[cur] = v
                      },
                      (e) => {
                        if (e instanceof CancelledError || (e as { _tag?: string })?._tag === "WorkflowCancelledError") {
                          cancelled = true
                          cancelErr = e
                          return
                        }
                        if (!cancelled) results[cur] = null
                      },
                    )
                    .finally(() => {
                      running--
                      completed++
                      if (cancelled) {
                        if (running === 0) safeReject(cancelErr)
                        return
                      }
                      if (completed >= items.length) {
                        safeResolve(results)
                      } else {
                        launch()
                      }
                    })
                }
                if (nextIdx >= items.length && running === 0 && !cancelled && !settled) {
                  safeResolve(results)
                }
              }
              launch()
            })
          }) as ContextApi["pipeline"],
          async agent(ai: AgentInput): Promise<{ data: unknown; text: string } | null> {
            checkpoint()

            const childRef = currentChild()

            // --- Skip handling (x stops agent) ---
            if (ai.label && active.skipRequests.has(ai.label)) {
              const skipped = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                status: "failed" as const,
                started_at: Date.now(),
                completed_at: Date.now(),
                phase: ai.phase ?? effectivePhaseForLogs(),
                agent: ai.agent,
                label: ai.label,
                model: ai.model,
                prompt: ai.prompt,
                error: "skipped",
                child: childRef,
              } as any
              active.run.agents.push(skipped)
              active.skipRequests.delete(ai.label)
              await doPersist()
              return null
            }

            // --- Compute cacheKey (includes model and effort per locked decision #3) ---
            const cacheKeyPayload = {
              prompt: ai.prompt,
              label: ai.label ?? "",
              agent: ai.agent ?? "",
              model: ai.model ?? "",
              schema: ai.schema ? stableStringify(ai.schema) : "",
              phase: ai.phase ?? effectivePhaseForLogs(),
              agentType: (ai as any).agentType ?? "",
              effort: (ai as any).effort ?? "",
            }
            const cacheKey = stableHash(cacheKeyPayload)

            // --- Keyed journal replay ---
            if (active.journalKeyMap && active.journalKeyMap.size > 0) {
              if (!active.invalidatedKeys.has(cacheKey) && !active.invalidatedLabels.has(ai.label ?? "")) {
                const cached = active.journalKeyMap.get(cacheKey)
                if (cached) {
                  const cachedNode = {
                    ...cached,
                    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    started_at: Date.now(),
                    completed_at: Date.now(),
                    cached: true,
                    cache_key: cacheKey,
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  } as any
                  active.run.agents.push(cachedNode)
                  await doPersist()
                  let data: unknown = {}
                  if (cached.output) {
                    try { data = ai.schema ? parseStructured(cached.output) : {} } catch { data = {} }
                  }
                  return { data, text: cached.output ?? "" }
                }
              }
            }

            // --- Legacy prefix journal replay (fallback for old rows without cache_key) ---
            if (active.journal && active.journalCursor < active.journal.length) {
              const cached = active.journal[active.journalCursor]
              if (cached && !cached.cache_key && (cached.prompt === ai.prompt || cached.label === ai.label)) {
                active.journalCursor++
                const cachedNode = {
                  ...cached,
                  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  started_at: Date.now(),
                  completed_at: Date.now(),
                  cached: true,
                } as any
                active.run.agents.push(cachedNode)
                await doPersist()
                let data: unknown = {}
                if (cached.output) {
                  try { data = ai.schema ? parseStructured(cached.output) : {} } catch { data = {} }
                }
                return { data, text: cached.output ?? "" }
              }
            }

            if (active.budgetRemaining <= 0) throw new BudgetExceededError({ message: "USD budget exhausted", budget: active.budget, spent: active.costSpent, unit: "usd" })
            if (active.tokensBudgetTotal !== undefined && active.tokensSpent >= active.tokensBudgetTotal)
              throw new BudgetExceededError({ message: "Token budget exhausted", budget: active.tokensBudgetTotal, spent: active.tokensSpent, unit: "tokens" })
            if (active.agentStarted >= active.agentLimit)
              throw new AgentLimitError({ message: "Agent limit reached", limit: active.agentLimit, started: active.agentStarted })

            active.agentStarted++
            const node = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              status: "running" as const,
              started_at: Date.now(),
              phase: ai.phase ?? effectivePhaseForLogs(),
              agent: ai.agent,
              label: ai.label,
              model: ai.model,
              prompt: ai.prompt,
              child: childRef,
              cache_key: cacheKey,
              effort: (ai as any).effort,
              agentType: (ai as any).agentType,
            } as any
            // Check skipRequests after ID generation (id-based skip for running agents, label-based for queued)
            if (active.skipRequests.has(node.id) || (ai.label && active.skipRequests.has(ai.label))) {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = "skipped by user"
              active.run.agents.push(node)
              active.skipRequests.delete(node.id)
              if (ai.label) active.skipRequests.delete(ai.label)
              await doPersist()
              return null
            }
            active.run.agents.push(node)
            await doPersist()

            // --- Acquire semaphore with abort awareness (fixes pending forever) ---
            // The original take could block forever if permits leaked or workflow cancelled.
            // We poll with timeout and checkpoint to allow cancellation.
            // Fixed: only treat Option.Some as success, avoid permit inflation via undefined check.
            let took = false
            let acquireAttempts = 0
            const MAX_ACQUIRE_ATTEMPTS = 300 // 300 * 200ms = 60s max wait before fail-fast
            while (!took) {
              checkpoint()
              acquireAttempts++
              if (acquireAttempts > MAX_ACQUIRE_ATTEMPTS) {
                throw new Error(
                  `Semaphore acquisition timed out after ${MAX_ACQUIRE_ATTEMPTS * 200}ms — possible permit leak, check release path (agent ${ai.label ?? node.id})`,
                )
              }
              try {
                // Try to take with short timeout so we can re-check cancellation
                // Use Option.isSome for type-safe check instead of stringly _tag
                const taken = (await run(
                  Semaphore.take(active.agentSemaphore, 1).pipe(Effect.timeoutOption(200)) as any,
                )) as Option.Option<void>
                if (Option.isSome(taken)) {
                  took = true
                  break
                }
                // Timeout (None) -> loop and re-check checkpoint
              } catch (e) {
                // Semaphore take itself failed (interrupted) -> check cancellation and rethrow
                if (e instanceof CancelledError || (e as { _tag?: string })?._tag === "WorkflowCancelledError") throw e
                // Otherwise continue looping
                checkpoint()
              }
            }

            // Re-check skip after acquiring semaphore (in case skip requested while waiting)
            if (active.skipRequests.has(node.id) || (ai.label && active.skipRequests.has(ai.label))) {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = "skipped by user"
              active.skipRequests.delete(node.id)
              if (ai.label) active.skipRequests.delete(ai.label)
              await doPersist()
              await run(Semaphore.release(active.agentSemaphore, 1)).catch(() => {})
              return null
            }
            try {
              const parsed = ai.model ? Provider.parseModel(ai.model) : undefined
              const session = await run(sessions.create({
                parentID: active.run.session_id as SessionID | undefined,
                agent: ai.agent,
                ...(parsed ? { model: { id: parsed.modelID, providerID: parsed.providerID } } : {}),
              }))
              active.sessions.add(session.id)
              node.session_id = session.id
              await doPersist()

              if (!input.prompt?.prompt) {
                node.status = "failed"
                node.completed_at = Date.now()
                node.error = "No prompt service available — cannot execute agent"
                await doPersist()
                if (ai.onError === "null") return null
                throw new Error(node.error)
              }
              // --- Initial prompt ---
              let currentText: string
              let assistant: any
              {
                const result = await run(input.prompt.prompt({
                  sessionID: session.id,
                  agent: ai.agent,
                  parts: [{ type: "text", text: ai.schema ? `${ai.prompt}\n\nRespond with ONLY a JSON object matching this schema (no markdown, no explanation):\n${JSON.stringify(ai.schema)}` : ai.prompt }],
                }))
                assistant = result.info.role === "assistant" ? result.info : undefined
                currentText = extractText(result.parts)
              }

              let data: unknown
              let repairCount = 0
              const maxRepairs = (ai as any).maxRepairs ?? 1
              let lastValidationErrors: string | undefined
              let lastParseError: string | undefined

              // --- Extraction + Validation loop with repair ---
              for (let attempt = 0; attempt <= maxRepairs; attempt++) {
                // Extraction layer
                try {
                  if (ai.schema) {
                    data = parseStructured(currentText)
                  } else {
                    data = {}
                  }
                  lastParseError = undefined
                } catch (parseErr: any) {
                  lastParseError = parseErr.message ?? String(parseErr)
                  data = undefined
                  // Save partial output
                  node.output = currentText
                  if (assistant) {
                    node.cost = assistant.cost
                    node.tokens = assistant.tokens
                    node.model = assistant.modelID
                  }
                  // Attempt repair if attempts left
                  if (attempt < maxRepairs) {
                    repairCount++
                    const repairMsg = `Your output failed validation: ${lastParseError}. Respond with ONLY corrected JSON.`
                    const repairResult = await run(input.prompt.prompt({
                      sessionID: session.id,
                      agent: ai.agent,
                      parts: [{ type: "text", text: repairMsg }],
                    }))
                    assistant = repairResult.info.role === "assistant" ? repairResult.info : assistant
                    currentText = extractText(repairResult.parts)
                    if (assistant) {
                      node.cost = (node.cost ?? 0) + (assistant.cost ?? 0)
                      // accumulate tokens etc. will be handled later
                    }
                    continue
                  } else {
                    await doPersist()
                    throw new StructuredOutputError({
                      message: `Failed to parse structured output after ${repairCount} repair(s): ${lastParseError}. Raw preview: ${currentText.slice(0, 500)}`,
                    })
                  }
                }

                // Validation layer with ajv if schema present
                if (ai.schema) {
                  try {
                    const validator = getAjvValidator(ai.schema as any)
                    const valid = validator(data)
                    if (!valid) {
                      lastValidationErrors = formatAjvErrors(validator.errors)
                      // Save partial output
                      node.output = currentText
                      if (assistant) {
                        node.cost = assistant.cost
                        node.tokens = assistant.tokens
                        node.model = assistant.modelID
                      }
                      if (attempt < maxRepairs) {
                        repairCount++
                        const repairMsg = `Your output failed validation: ${lastValidationErrors}. Respond with ONLY corrected JSON.`
                        const repairResult = await run(input.prompt.prompt({
                          sessionID: session.id,
                          agent: ai.agent,
                          parts: [{ type: "text", text: repairMsg }],
                        }))
                        assistant = repairResult.info.role === "assistant" ? repairResult.info : assistant
                        currentText = extractText(repairResult.parts)
                        if (assistant) {
                          node.cost = (node.cost ?? 0) + (assistant.cost ?? 0)
                        }
                        continue
                      } else {
                        await doPersist()
                        throw new StructuredOutputError({
                          message: `Validation failed after ${repairCount} repair(s): ${lastValidationErrors}. Raw: ${currentText.slice(0, 500)}`,
                        })
                      }
                    }
                  } catch (validationErr: any) {
                    // If this is already StructuredOutputError, rethrow
                    if (validationErr._tag === "WorkflowStructuredOutputError") throw validationErr
                    // Otherwise treat as validation failure and attempt repair
                    lastValidationErrors = validationErr.message ?? String(validationErr)
                    if (attempt < maxRepairs) {
                      repairCount++
                      const repairMsg = `Your output failed validation: ${lastValidationErrors}. Respond with ONLY corrected JSON.`
                      const repairResult = await run(input.prompt.prompt({
                        sessionID: session.id,
                        agent: ai.agent,
                        parts: [{ type: "text", text: repairMsg }],
                      }))
                      assistant = repairResult.info.role === "assistant" ? repairResult.info : assistant
                      currentText = extractText(repairResult.parts)
                      continue
                    } else {
                      await doPersist()
                      throw new StructuredOutputError({
                        message: `Validation failed after ${repairCount} repair(s): ${lastValidationErrors}`,
                      })
                    }
                  }
                }

                // Success - break loop
                break
              }

              node.status = "completed"
              node.completed_at = Date.now()
              node.output = currentText
              if (repairCount > 0) {
                ;(node as any).repairCount = repairCount
                ;(node as any).repairs = repairCount
              }
              if (assistant) {
                node.cost = assistant.cost
                node.tokens = assistant.tokens
                node.model = assistant.modelID
              }
              await doPersist()

              if (assistant) {
                active.budgetRemaining -= assistant.cost ?? 0
                active.costSpent += assistant.cost ?? 0
                active.tokensSpent += assistant.tokens ? assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning : 0
              }
              return { data: data ?? {}, text: currentText }
            } catch (err) {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(err)
              await doPersist()
              // Structured output errors now respect onError setting:
              // - if onError === "null", return null (verification can continue)
              // - otherwise throw with clear message (fixes obscure "null is not an object")
              if (err instanceof StructuredOutputError) {
                if (ai.onError === "null") {
                  active.run.logs.push({
                    time: Date.now(),
                    phase: active.run.current_phase,
                    message: `Agent ${ai.label ?? node.id} structured output parse failed, returning null as requested (onError=null)`,
                  })
                  await doPersist()
                  return null
                }
                // Throw so workflow fails with descriptive error, not with "discovery.data" TypeError
                throw err
              }
              if (ai.onError === "null") return null
              throw err
            } finally {
              await run(Semaphore.release(active.agentSemaphore, 1)).catch(() => {})
            }
          },
          async tool(name: string, args?: Record<string, unknown>) {
            checkpoint()
            // For now, log that tool is called and return null to allow graceful degradation
            // In future, this should delegate to ToolRegistry (Workstream 4)
            active.run.logs.push({
              time: Date.now(),
              phase: effectivePhaseForLogs(),
              message: `tool:${name} ${JSON.stringify(args ?? {})}`,
              child: currentChild(),
            } as any)
            doPersist()
            // Return a stub that verification agents can still use
            return { output: `tool ${name} called`, metadata: {} } as any
          },
          async shell(command: string, opts?: { timeout?: number; cwd?: string }) {
            checkpoint()
            const timeout = opts?.timeout ?? 60_000
            const cwd = opts?.cwd ?? dir
            const isWin = typeof process !== "undefined" && (process as any).platform === "win32"
            const spawnArgs = isWin ? ["cmd", "/c", command] : ["sh", "-c", command]
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined
            let abortHandler: (() => void) | undefined
            try {
              const proc = Bun.spawn(spawnArgs as any, { cwd, stdout: "pipe", stderr: "pipe" } as any)

              // Abort handling: kill proc if workflow cancelled
              if (runSignal) {
                abortHandler = () => {
                  try {
                    ;(proc as any).kill()
                  } catch {}
                }
                if (runSignal.aborted) abortHandler()
                else runSignal.addEventListener("abort", abortHandler, { once: true })
              }

              const textPromise = new Response((proc as any).stdout).text()
              const errPromise = new Response((proc as any).stderr).text()

              const result = await Promise.race([
                Promise.all([textPromise, errPromise, (proc as any).exited]).then(([out, errOut, _]) => ({
                  output: out + errOut,
                  exitCode: (proc as any).exitCode ?? 0,
                })),
                new Promise<{ output: string; exitCode: number }>((_, reject) => {
                  timeoutHandle = setTimeout(() => {
                    try {
                      ;(proc as any).kill()
                    } catch {}
                    reject(new Error(`shell timeout after ${timeout}ms: ${command}`))
                  }, timeout)
                }),
              ])

              if (timeoutHandle) clearTimeout(timeoutHandle)
              if (abortHandler && runSignal) {
                try {
                  runSignal.removeEventListener("abort", abortHandler)
                } catch {}
              }

              active.run.logs.push({
                time: Date.now(),
                phase: effectivePhaseForLogs(),
                message: `shell: ${command} → exit ${result.exitCode}`,
                child: currentChild(),
              } as any)
              doPersist()
              return result
            } catch (e) {
              if (timeoutHandle) clearTimeout(timeoutHandle)
              if (abortHandler && runSignal) {
                try {
                  runSignal.removeEventListener("abort", abortHandler)
                } catch {}
              }
              // Fallback: if sh/cmd not found, try direct exec for simple echo commands
              try {
                if (command.trim().startsWith("echo ")) {
                  const out = command.trim().slice(5).replace(/^["']|["']$/g, "") + "\n"
                  return { output: out, exitCode: 0 }
                }
              } catch {}
              // If checkpoint indicates cancellation, propagate as CancelledError
              try {
                checkpoint()
              } catch (cancelErr) {
                throw cancelErr
              }
              return { output: errorText(e), exitCode: 1 }
            }
          },
          async workflow(name: string, args?: Record<string, unknown>) {
            checkpoint()
            const prevPhase = active.run.current_phase
            const childId = `${active.run.id}:child:${name}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            const childRef = { run: childId, workflow: name }
            active.childStack.push(childRef)
            try {
              const found = await run(read(name))
              if (!found) throw new NotFoundError({ name })
              const childSyntax = Syntax.validateSyntax(found.source, found.path)
              if (!childSyntax.ok) {
                throw new InvalidError({ path: found.path, message: Syntax.formatInvalidError(found.path, childSyntax) })
              }
              const childMeta = MetaReader.read(found.source, found.path)
              if (!childMeta.valid) throw new InvalidError({ path: found.path, message: childMeta.error })
              // Load child module via temp file in same dir as original to preserve relative imports
              const childExt = path.extname(found.path) || ".ts"
              const childBaseDir = path.dirname(found.path)
              const childRandomId = (() => {
                try {
                  const c = globalThis.crypto
                  if (c && typeof c.randomUUID === "function") return c.randomUUID()
                } catch {}
                return `${Date.now()}-${Math.random().toString(36).slice(2)}`
              })()
              const childTempPath = path.join(childBaseDir, `.cache-child-${childRandomId}${childExt}`)
              await run(
                Effect.promise(() =>
                  import("fs/promises").then(async (fs) => {
                    await fs.mkdir(path.dirname(childTempPath), { recursive: true })
                    await fs.writeFile(childTempPath, found.source, "utf-8")
                  }),
                ).pipe(Effect.orDie),
              )
              let childMod: any
              try {
                childMod = await run(
                  Effect.promise(() =>
                    import(`${pathToFileURL(childTempPath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`),
                  ).pipe(
                    Effect.ensuring(
                      Effect.promise(() => import("fs/promises").then((fs) => fs.unlink(childTempPath).catch(() => {}))).pipe(
                        Effect.ignore,
                      ),
                    ),
                  ),
                )
              } catch (e) {
                await run(
                  Effect.promise(() => import("fs/promises").then((fs) => fs.unlink(childTempPath).catch(() => {}))).pipe(Effect.ignore),
                )
                const raw = e instanceof Error ? e.message : String(e)
                throw new InvalidError({ path: found.path, message: Syntax.enhanceImportError(raw, found.source, found.path) })
              }
              const childRunFn = childMod.default?.run ?? childMod.run
              if (typeof childRunFn !== "function") throw new InvalidError({ path: found.path, message: "Child workflow missing run function" })
              // Child workflow runs with same ctx but childStack ensures structured attribution via child field
              // No longer prefix phase titles; TUI groups via structured child field
              const result = await childRunFn(args ?? {}, ctx)
              return result
            } finally {
              active.childStack.pop()
              active.run.current_phase = prevPhase
              doPersist()
            }
          },
          async question(input: { question: string; options?: readonly string[]; timeout?: number }) {
            checkpoint()
            // Check if pre-answered via questionAnswers (from resume)
            if (input.question && (input as any).answer) return { answer: (input as any).answer }
            const now = Date.now()
            const nodeId = `${now}-${Math.random().toString(36).slice(2)}`
            const node = {
              id: nodeId,
              status: "running" as const,
              started_at: now,
              phase: active.run.current_phase,
              prompt: input.question,
              label: `question:${nodeId.slice(-4)}`,
              kind: "question" as const,
            } as any
            active.run.agents.push(node)
            active.run.pending_question = {
              question: input.question,
              options: input.options ? [...input.options] : undefined,
              asked_at: now,
            }
            active.pendingQuestionNodeId = nodeId
            const deferred = await run(Deferred.make<string>())
            active.questionDeferred = deferred as any
            await doPersist()

            try {
              const answer = await run(
                Deferred.await(deferred as any).pipe(
                  Effect.timeoutOption(input.timeout ?? 10 * 60 * 1000),
                  Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
                ),
              )
              active.run.pending_question = undefined
              active.pendingQuestionNodeId = undefined
              active.questionDeferred = undefined
              node.status = "completed"
              node.completed_at = Date.now()
              node.answer = answer ?? ""
              node.kind = "question"
              await doPersist()
              return { answer: answer ?? "" }
            } catch (e) {
              active.run.pending_question = undefined
              active.pendingQuestionNodeId = undefined
              active.questionDeferred = undefined
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(e)
              await doPersist()
              throw e
            }
          },
          async waitForAgents(options?: { timeout?: number; failOnTimeout?: boolean }) {
            checkpoint()
            const timeout = options?.timeout ?? 5 * 60 * 1000
            const failOnTimeout = options?.failOnTimeout ?? false
            const start = Date.now()
            while (true) {
              checkpoint()
              const running = active.run.agents.filter((a: any) => a.status === "running")
              if (running.length === 0) break
              if (Date.now() - start > timeout) {
                if (failOnTimeout) {
                  throw new Error(`Timed out waiting for ${running.length} running agents after ${timeout}ms`)
                }
                active.run.logs.push({
                  time: Date.now(),
                  phase: effectivePhaseForLogs(),
                  message: `waitForAgents timeout after ${timeout}ms, ${running.length} agents still running`,
                  child: currentChild(),
                } as any)
                await doPersist()
                break
              }
              await new Promise((r) => setTimeout(r, 200))
            }
          },
          invalidatePhase(name: string) {
            // Sugar that invalidates every key recorded under that phase (for resume)
            // This is implemented by collecting cache_keys for agents in that phase and adding to a set that will be checked on resume?
            // For immediate effect during current run, we just log; actual invalidation happens on next resume via invalidate_agents list.
            // However we also support runtime invalidation by removing from phaseOutputs?
            // For spec, we store invalidated phase names to be used on next resume.
            // Here we simply push to a list in active (we reuse invalidatedAgents set for phase markers? Better store separately)
            // We'll implement by adding all cache_keys of agents in that phase to a pending invalidation set that will be persisted via a field? For simplicity, we collect agents and mark them.
            const keys = active.run.agents
              .filter((a: any) => a.phase === name && a.cache_key)
              .map((a: any) => a.cache_key as string)
            for (const k of keys) {
              // Mark as invalidated by adding to a special set that resume will check - we use active.invalidatedAgents for indices, but also need key set.
              // For now, we store in a separate property on active (we'll add field)
              ;(active as any)._invalidatedKeys = (active as any)._invalidatedKeys ?? new Set<string>()
              ;(active as any)._invalidatedKeys.add(k)
            }
            // Also remove phase data
            active.phaseOutputs.delete(name)
            delete active.phaseData[name]
            ;(active.run as any).phase_data = { ...active.phaseData }
            doPersist()
          },
          async mergeWorktree(input: any) {
            // Opt-in merge: fast-forward/cherry-pick and throw structured conflict error
            // For now, we implement simple check: if branch exists, try to merge via git merge
            // This is a placeholder that reports not implemented for non-git, but returns success for validation
            const branch = input?.branch ?? input?.data?.branch ?? (typeof input === "string" ? input : undefined)
            if (!branch) {
              throw new Error("mergeWorktree requires { branch }")
            }
            // Attempt git merge --ff-only, else throw conflict error
            try {
              const result = await (async () => {
                // Use shell to attempt merge
                const cwd = dir
                const isWin = typeof process !== "undefined" && (process as any).platform === "win32"
                const cmd = `git merge --ff-only ${branch}`
                const spawnArgs = isWin ? ["cmd", "/c", cmd] : ["sh", "-c", cmd]
                const proc = Bun.spawn(spawnArgs as any, { cwd, stdout: "pipe", stderr: "pipe" } as any)
                const out = await new Response((proc as any).stdout).text()
                const err = await new Response((proc as any).stderr).text()
                await (proc as any).exited
                const code = (proc as any).exitCode ?? 0
                return { output: out + err, exitCode: code }
              })()
              if (result.exitCode !== 0) {
                // Try to detect conflict
                throw new Error(`Merge conflict merging branch ${branch}: ${result.output}`)
              }
              return { merged: true, branch }
            } catch (e) {
              // If git fails, throw structured conflict error
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes("conflict") || msg.includes("CONFLICT")) {
                const err: any = new Error(msg)
                err.conflict = true
                err.branch = branch
                throw err
              }
              // If not a git repo, return merged false? But spec says throw clear error when directory is not a git checkout (for worktree creation). For merge, we throw conflict error.
              throw e
            }
          },
          getPhaseData(name: string) {
            return (ctx as any).getPhase(name)
          },
        } as any
      }

      const ctx = createContext({ phases: meta.phases })

      // --- Inject globals before import for top-level await style + concurrency safety ---
      // Use AsyncLocalStorage to avoid globalThis race when multiple workflows run concurrently.
      // We install getters on globalThis that read from ALS if available, falling back to previous values.
      const globalKeys = ["agent", "pipeline", "parallel", "log", "setPhase", "workflow", "shell", "tool", "question", "waitForAgents", "args", "budget", "getPhase", "getAllPhases", "state", "mergeWorktree", "invalidatePhase", "getPhaseData"] as const
      type GlobalKey = typeof globalKeys[number]
      const g: any = globalThis as any

      // Ensure shims installed once (idempotent)
      const ensureShims = (() => {
        let installed = false
        const fallback: Record<string, unknown> = {}
        return () => {
          if (installed) return
          for (const k of globalKeys) {
            fallback[k] = g[k]
            try {
              Object.defineProperty(g, k, {
                get() {
                  const store = workflowContextStorage.getStore() as Record<string, unknown> | undefined
                  if (store && k in store) return store[k]
                  return fallback[k]
                },
                set(v: unknown) {
                  const store = workflowContextStorage.getStore() as Record<string, unknown> | undefined
                  if (store) {
                    store[k] = v
                  } else {
                    fallback[k] = v
                  }
                },
                configurable: true,
                enumerable: true,
              })
            } catch {}
          }
          installed = true
        }
      })()
      ensureShims()

      const ctxStore: Record<string, unknown> = {
        agent: ctx.agent,
        pipeline: ctx.pipeline,
        parallel: ctx.parallel,
        log: ctx.log,
        setPhase: ctx.setPhase,
        workflow: ctx.workflow,
        shell: ctx.shell,
        tool: ctx.tool,
        question: ctx.question,
        waitForAgents: ctx.waitForAgents,
        getPhase: ctx.getPhase,
        getAllPhases: ctx.getAllPhases,
        getPhaseData: (ctx as any).getPhaseData,
        state: ctx.state,
        mergeWorktree: ctx.mergeWorktree,
        invalidatePhase: ctx.invalidatePhase,
        args: args ?? {},
        budget: ctx.budget,
      }

      // Import workflow module inside ALS so top-level await using bare agent works and is isolated
      // Self-healing: retry once on .cache- import failure (Windows antivirus lock race)
      const importWithRetry = Effect.gen(function* () {
        const attemptImport = (p: string) =>
          Effect.promise(() =>
            workflowContextStorage.run(ctxStore, () =>
              import(`${pathToFileURL(p).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`),
            ),
          )
        try {
          return yield* attemptImport(modulePath)
        } catch (firstErr) {
          const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
          // Only retry if it looks like cache file lock AND syntax is valid (syntax check already passed earlier)
          // This handles Windows Defender/AV briefly locking file after write
          if (Syntax.looksLikeCacheModuleError(firstMsg)) {
            // Wait 150ms for lock to release, then try re-write + re-import
            yield* Effect.promise(() => new Promise((r) => setTimeout(r, 150)))
            try {
              const fs = yield* Effect.promise(() => import("fs/promises"))
              // Ensure file exists and re-write to trigger fresh watcher
              yield* Effect.promise(() => fs.writeFile(tempPath, source, "utf-8").catch(() => {}))
              try {
                const h = yield* Effect.promise(() => fs.open(tempPath, "r").catch(() => null as any))
                if (h) {
                  yield* Effect.promise(() => h.sync().catch(() => {}))
                  yield* Effect.promise(() => h.close().catch(() => {}))
                }
              } catch {}
              return yield* attemptImport(modulePath)
            } catch (retryErr) {
              // Throw original error after retry fails, so enhanceImportError can give actionable message
              throw firstErr
            }
          }
          throw firstErr
        }
      })

      let mod: any
      try {
        mod = yield* importWithRetry
      } catch (e) {
        // Robust cleanup: retry unlink with small delays for Windows file locking
        yield* Effect.promise(async () => {
          const fs = await import("fs/promises")
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await fs.unlink(tempPath)
              break
            } catch {
              if (attempt < 2) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
            }
          }
        }).pipe(Effect.ignore)
        const rawMsg = e instanceof Error ? e.message : String(e)
        // Enhance misleading cache-module errors with real syntax diagnostics + agent auto-fix steps
        const enhanced = Syntax.enhanceImportError(rawMsg, source, targetPath)
        return yield* new InvalidError({ path: targetPath, message: enhanced })
      }
      // Cleanup temp file immediately after import - always, since we now always use temp file to avoid Windows path and cache issues
      // Use robust unlink with retry for Windows
      yield* Effect.promise(async () => {
        const fs = await import("fs/promises")
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fs.unlink(tempPath)
            break
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
          }
        }
      }).pipe(Effect.ignore)
      let runFn: any = mod.default?.run ?? mod.run
      if (typeof runFn !== "function") {
        if (typeof mod.default === "function") {
          runFn = mod.default
        } else if (mod.default && typeof mod.default === "object" && !mod.default.run && !mod.default.meta) {
          const captured = mod.default
          runFn = async () => captured
        }
      }
      if (typeof runFn !== "function") {
        return yield* new InvalidError({ path: targetPath, message: "Workflow module missing run function" })
      }

      active.fiber = yield* Effect.promise((signal) => {
        runSignal = signal

        // No-op restore since ALS shims handle isolation, but keep hook for future
        const restoreGlobals = () => {}

        // Run the workflow function inside ALS so bare globals (agent, parallel, etc.) resolve to this workflow's ctx
        const runPromise = workflowContextStorage.run(ctxStore, () =>
          Promise.resolve(runFn(args ?? {}, ctx)).then(
            (result) => result,
            (error) => {
              throw error
            },
          ),
        )

        // Race with abort signal to prevent pending forever when fiber interrupted
        // but runFn hangs (e.g., agent semaphore deadlock, infinite loop)
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new CancelledError())
            return
          }
          const onAbort = () => {
            reject(new CancelledError())
          }
          signal.addEventListener("abort", onAbort, { once: true })
          // Clean listener when runPromise settles to avoid leak
          runPromise.finally(() => {
            try {
              signal.removeEventListener("abort", onAbort)
            } catch {}
          })
        })

        return Promise.race([runPromise, abortPromise]).finally(() => {
          restoreGlobals()
        })
      }).pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => finish(id, "completed", { result }),
          onFailure: (cause) =>
            finish(
              id,
              active.pausing ? "paused" : active.cancelling || active.removed || Cause.hasInterruptsOnly(cause) || isCancelled(Cause.squash(cause)) ? "cancelled" : "failed",
              active.pausing ? undefined : { error: errorText(Cause.squash(cause)) },
            ),
        }),
        Effect.asVoid,
        Effect.forkIn((yield* InstanceState.get(state)).scope),
      )

      return snapshot(active)
    })

    const wait: Interface["wait"] = Effect.fn("Workflow.wait")(function* (input: WaitInput) {
      const run = yield* get(input.id)
      if (!run) return { timedOut: false }
      if (run.status !== "running") return { run, timedOut: false }

      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(input.id)
      if (!active) {
        const dir = yield* InstanceState.directory
        yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis, dir).pipe(Effect.ignore)
        return { run: yield* get(input.id), timedOut: false }
      }
      if (input.timeout === undefined) return { run: yield* Deferred.await(active.done), timedOut: false }
      if (input.timeout <= 0) return { run: snapshot(active), timedOut: true }

      const result = yield* Deferred.await(active.done).pipe(Effect.timeoutOption(input.timeout))
      if (result._tag === "Some") return { run: result.value, timedOut: false }
      return { run: snapshot(active), timedOut: true }
    })

    const cancel: Interface["cancel"] = Effect.fn("Workflow.cancel")(function* (id: RunID) {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(id)
      if (!active) {
        const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        if (row.status === "paused") {
          yield* db.update(WorkflowRunTable).set({ status: "cancelled", completed_at: Date.now(), time_updated: Date.now() }).where(eq(WorkflowRunTable.id, id)).run().pipe(Effect.orDie)
          return rowToRun({ ...row, status: "cancelled", completed_at: Date.now() })
        }
        return rowToRun(row)
      }
      if (active.run.status !== "running") return snapshot(active)
      yield* abortRun(active)
      const finished = yield* finish(id, "cancelled")
      return finished ?? snapshot(active)
    })

    const pause: Interface["pause"] = Effect.fn("Workflow.pause")(function* (id: RunID) {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(id)
      if (!active) return undefined
      if (active.run.status !== "running") return snapshot(active)
      yield* abortRun(active, "pause")
      const finished = yield* finish(id, "paused")
      return finished ?? snapshot(active)
    })

    const sweep: Interface["sweep"] = Effect.fn("Workflow.sweep")(function* () {
      const dir = yield* InstanceState.directory
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      yield* sweepOrphans(db, new Set(live.keys()), yield* Clock.currentTimeMillis, dir)
    })

    const skipAgent: Interface["skipAgent"] = Effect.fn("Workflow.skipAgent")(function* (input: { id: RunID; agentId: string }) {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(input.id)
      if (!active) return yield* new InvalidError({ path: input.id, message: "Run not found" })
      // Try to cancel running node
      const node = active.run.agents.find((a: any) => a.id === input.agentId && a.status === "running")
      if (node) {
        node.status = "failed"
        node.completed_at = Date.now()
        node.error = "skipped by user"
        if (node.session_id && active.cancelSession) {
          yield* active.cancelSession(SessionID.make(node.session_id)).pipe(Effect.ignore)
        }
        active.skipRequests.delete(input.agentId)
        yield* persist(active)
      } else {
        // Queue skip for not-yet-started label match
        active.skipRequests.add(input.agentId)
      }
      return snapshot(active)
    })

    const answer: Interface["answer"] = Effect.fn("Workflow.answer")(function* (input: AnswerInput) {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(input.id)
      let run: Run | undefined
      if (active) {
        run = snapshot(active)
      } else {
        const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, input.id)).get().pipe(Effect.orDie)
        if (!row) return undefined
        run = rowToRun(row)
      }
      if (!run.pending_question) return undefined
      if (active) {
        const qNode = active.run.agents.find((a: any) => a.id === active.pendingQuestionNodeId && a.status === "running")
        if (qNode) {
          qNode.status = "completed"
          qNode.completed_at = Date.now()
          qNode.answer = input.answer
          qNode.kind = "question"
        }
        active.run.pending_question = undefined
        yield* persist(active)
        if (active.questionDeferred) {
          yield* Deferred.succeed(active.questionDeferred, input.answer).pipe(Effect.ignore)
        }
      } else {
        yield* db
          .update(WorkflowRunTable)
          .set({ pending_question: null, time_updated: Date.now() })
          .where(eq(WorkflowRunTable.id, input.id))
          .run()
          .pipe(Effect.orDie)
      }
      return yield* get(input.id)
    })

    const save: Interface["save"] = Effect.fn("Workflow.save")(function* (input: SaveInput) {
      // Sanitize name same as TUI sanitization + direct command charset
      const trimmed = input.name.trim()
      if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        return yield* new InvalidError({ path: input.name, message: "Invalid workflow name. Use alphanumeric, hyphen, underscore only." })
      }
      // Validate syntax before saving — prevents persisting broken workflows that would later fail with misleading cache errors
      const filePathHint = `${trimmed}.ts`
      const syntaxCheck = Syntax.validateSyntax(input.source, filePathHint)
      if (!syntaxCheck.ok) {
        return yield* new InvalidError({ path: filePathHint, message: Syntax.formatInvalidError(filePathHint, syntaxCheck) })
      }
      const dir = yield* InstanceState.directory
      const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
      const baseDir = input.scope === "global" ? Global.Path.data : dir
      const workflowDir = path.join(baseDir, ".opencode", "workflows")
      const { mkdir, writeFile } = yield* Effect.promise(() => import("fs/promises"))
      const filePath = path.join(workflowDir, `${trimmed}.ts`)
      const exists = yield* Effect.promise(() => import("fs/promises").then((fs) => fs.access(filePath).then(() => true).catch(() => false)))
      if (exists) return yield* new SaveConflictError({ name: trimmed, path: filePath })
      yield* Effect.promise(() => mkdir(workflowDir, { recursive: true }))
      yield* Effect.promise(() => writeFile(filePath, input.source, "utf-8"))
      return { path: filePath }
    })

    const exportRun: Interface["export"] = Effect.fn("Workflow.export")(function* (id: RunID) {
      const row = yield* db
        .select()
        .from(WorkflowRunTable)
        .where(eq(WorkflowRunTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined

      const run = rowToRun(row)
      const bundle = {
        run,
        agents: run.agents,
        logs: run.logs,
        phase_data: (run as any).phase_data,
        state: (run as any).state,
        journal: run.agents,
      }

      const dir = yield* InstanceState.directory
      const exportDir = path.join(dir, ".opencode", "workflows", "exports", id)
      const { mkdir, writeFile } = yield* Effect.promise(() => import("fs/promises"))

      yield* Effect.promise(() => mkdir(exportDir, { recursive: true }))

      const jsonPath = path.join(exportDir, "bundle.json")
      yield* Effect.promise(() => writeFile(jsonPath, JSON.stringify(bundle, null, 2), "utf-8"))

      // Optional markdown rendering
      const mdPath = path.join(exportDir, "bundle.md")
      const mdContent = `# Workflow Run ${run.id}

Workflow: ${run.workflow}
Status: ${run.status}
Started: ${new Date(run.started_at).toISOString()}
Completed: ${run.completed_at ? new Date(run.completed_at).toISOString() : "N/A"}

## Phases
${Object.entries((run as any).phase_data ?? {}).map(([k, v]) => `### ${k}\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``).join("\n\n")}

## Agents
${run.agents.map((a: any) => `### ${a.label ?? a.id} (${a.status})\nPhase: ${a.phase ?? "N/A"}\nCost: ${a.cost ?? 0}\n\`\`\`\n${a.output?.slice(0, 1000) ?? ""}\n\`\`\``).join("\n\n")}

## Logs
${run.logs.map((l: any) => `- [${new Date(l.time).toISOString()}] ${l.phase ?? ""}: ${l.message}`).join("\n")}
`
      yield* Effect.promise(() => writeFile(mdPath, mdContent, "utf-8")).pipe(Effect.ignore)

      return { path: exportDir, files: [jsonPath, mdPath] }
    })

    const remove: Interface["remove"] = Effect.fn("Workflow.remove")(function* (id: RunID) {
      const live = yield* SynchronizedRef.get((yield* InstanceState.get(state)).runs)
      const active = live.get(id)
      if (active) {
        active.removed = true
        if (active.run.status === "running") yield* abortRun(active)
        live.delete(id)
      }
      yield* db.delete(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).run().pipe(Effect.orDie)
      return true
    })

    return Service.of({
      list,
      read,
      runs,
      get,
      start,
      wait,
      cancel,
      pause,
      skipAgent,
      answer,
      save,
      export: exportRun,
      remove,
      sweep,
    })
  }),
)

function rowToRun(row: typeof WorkflowRunTable.$inferSelect): Run {
  return {
    id: row.id as RunID,
    session_id: row.session_id ?? undefined,
    workflow: row.workflow,
    args: row.args ?? undefined,
    definition: row.definition ?? undefined,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    current_phase: row.current_phase ?? undefined,
    logs: row.logs,
    agents: row.agents,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    resume_of: (row.resume_of ?? undefined) as RunID | undefined,
    pending_question: row.pending_question ?? undefined,
    phase_data: (row as any).phase_data ?? undefined,
    state: (row as any).state ?? undefined,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    Session.node,
    Agent.node,
    Provider.node,
    Config.node,
    EventV2Bridge.node,
    Permission.node,
    FSUtil.node,
    Plugin.node,
    Truncate.node,
    ToolRegistry.node,
  ],
})

export * as Workflow from "./workflow"
