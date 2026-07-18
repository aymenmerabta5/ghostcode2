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
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Workflow as WorkflowSchema } from "@opencode-ai/schema/workflow"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
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
import { BUILTIN_WORKFLOWS, builtinPath, inlinePath, isBuiltinPath, isInlinePath } from "./builtin"
import { TurnBudget } from "./turn-budget"
import {
  AgentLimitError,
  BudgetExceededError,
  CancelledError,
  InvalidError,
  NotFoundError,
  SaveConflictError,
  StructuredOutputError,
} from "./errors"
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

function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
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
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = match ? match[1].trim() : text.trim()
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1))
    }
    throw new Error("No JSON found")
  }
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
          current_phase: active.run.current_phase ?? null,
          args: active.run.args ?? null,
          definition: active.run.definition ? (encodeDefinitionForRow(active.run.definition) as any) : null,
          logs: active.run.logs as any,
          agents: active.run.agents as any,
          result: active.run.result === undefined ? null : JSON.stringify(active.run.result),
          error: active.run.error ?? null,
          resume_of: active.run.resume_of ?? null,
          pending_question: active.run.pending_question ? { question: active.run.pending_question.question, options: active.run.pending_question.options ? [...active.run.pending_question.options] : undefined, asked_at: active.run.pending_question.asked_at } : null,
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
        active.run.status = status as Run["status"]
        active.run.completed_at = Date.now()
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
            const cacheDir = path.join(active.directory, ".opencode", "workflows", ".cache")
            const files = await fs.readdir(cacheDir).catch(() => [] as string[])
            const now = Date.now()
            for (const f of files) {
              const fp = path.join(cacheDir, f)
              try {
                const stat = await fs.stat(fp)
                if (now - stat.mtimeMs > 60 * 60 * 1000) await fs.unlink(fp).catch(() => {})
              } catch {}
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
      for (const dir of allDirs) {
        const matches = Glob.scanSync("{workflow,workflows}/*.{js,ts,mjs,cjs}", {
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
        const metaResult = MetaReader.read(source, builtinPath(name))
        results.push({
          name,
          path: builtinPath(name),
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
        const matches = Glob.scanSync("{workflow,workflows}/*.{js,ts,mjs,cjs}", {
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

      const metaResult = MetaReader.read(source, targetPath)
      if (!metaResult.valid) return yield* new InvalidError({ path: targetPath, message: metaResult.error })

      const meta = metaResult.meta
      const args = coerceArgs(meta, input.args)

      // --- Resume journal handling (cached completed agents) ---
      let journal: Run["agents"] = []
      let baseLogs: Run["logs"] = []
      let baseCost = 0
      let baseTokens = 0
      let baseStartedAt: number | undefined
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
        const invalidated = new Set(input.invalidate_agents ?? [])
        // Keep only completed agents not invalidated, preserve order
        journal = prevRow.agents.filter((a: any, idx: number) => a.status === "completed" && !invalidated.has(idx))
        baseLogs = prevRow.logs
        baseCost = prevRow.agents.reduce((s: number, a: any) => s + (a.cost ?? 0), 0)
        baseTokens = prevRow.agents.reduce(
          (s: number, a: any) => s + (a.tokens ? a.tokens.input + a.tokens.output + a.tokens.reasoning : 0),
          0,
        )
        baseStartedAt = prevRow.started_at
      }

      const tempPath = path.join(dir, ".opencode", "workflows", ".cache", `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
      const modulePath = isBuiltinPath(targetPath) || isInlinePath(targetPath) || input.temporary ? tempPath : targetPath
      if (isBuiltinPath(targetPath) || isInlinePath(targetPath) || input.temporary) {
        const { mkdir, writeFile } = yield* Effect.promise(() => import("fs/promises"))
        yield* Effect.promise(() => mkdir(path.dirname(tempPath), { recursive: true }))
        yield* Effect.promise(() => writeFile(tempPath, source, "utf-8"))
      }

      const id = RunID.ascending()
      const now = Date.now()
      const done = yield* Deferred.make<Run>()
      const runScope = yield* Scope.make()
      const agentSemaphore = yield* Semaphore.make(agentConcurrencyCap())

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
        },
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
        invalidatedAgents: new Set(input.invalidate_agents ?? []),
      }

      yield* persist(active)
      yield* SynchronizedRef.update((yield* InstanceState.get(state)).runs, (m) => { m.set(id, active); return m })
      let runSignal: AbortSignal | undefined

      const createContext = (options: { phases?: Meta["phases"] }): ContextApi => {
        const checkpoint = () => {
          if (runSignal?.aborted || active.cancelling || active.pausing) throw new CancelledError()
        }
        const doPersist = () => run(persist(active)).catch(() => {})
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
          setPhase(phase: string) {
            active.run.current_phase = phase
            active.run.logs.push({ time: Date.now(), phase, message: `Phase: ${phase}` })
            doPersist()
          },
          log(message: string) {
            active.run.logs.push({ time: Date.now(), phase: active.run.current_phase, message })
            doPersist()
          },
          async parallel<T>(tasks: readonly (() => Promise<T>)[], options?: { concurrencyLimit?: number }): Promise<(T | null)[]> {
            checkpoint()
            if (tasks.length > MAX_BATCH_ITEMS) throw new InvalidError({ path: targetPath, message: `Batch exceeds ${MAX_BATCH_ITEMS} items` })
            const concurrency = Math.max(1, options?.concurrencyLimit ?? 20)
            const results: (T | null)[] = new Array(tasks.length).fill(null)
            const executing = new Set<Promise<void>>()
            for (let i = 0; i < tasks.length; i++) {
              const task = tasks[i]
              const p = Promise.resolve().then(() => task()).then(
                (v) => { results[i] = v },
                (e) => { if (e instanceof CancelledError) throw e; results[i] = null },
              )
              executing.add(p)
              p.finally(() => executing.delete(p))
              if (executing.size >= concurrency) await Promise.race(executing)
            }
            await Promise.all(executing)
            return results
          },
          pipeline: (async (items: readonly unknown[], ...rest: unknown[]) => {
            checkpoint()
            if (items.length > MAX_BATCH_ITEMS) throw new InvalidError({ path: targetPath, message: `Pipeline exceeds ${MAX_BATCH_ITEMS} items` })
            const stages = rest.filter((s) => typeof s === "function") as ((prev: unknown, item: unknown, index: number) => Promise<unknown>)[]
            const opts = rest.find((s) => typeof s === "object") as { concurrencyLimit?: number } | undefined
            const concurrency = Math.max(1, opts?.concurrencyLimit ?? 5)
            const results: (unknown | null)[] = new Array(items.length).fill(null)
            const executing = new Set<Promise<void>>()
            for (let i = 0; i < items.length; i++) {
              const item = items[i]
              const p = Promise.resolve().then(async () => {
                let prev: unknown = item
                for (const stage of stages) {
                  prev = await stage(prev, item, i)
                }
                results[i] = prev
              }).catch((e) => { if (e instanceof CancelledError) throw e; results[i] = null })
              executing.add(p)
              p.finally(() => executing.delete(p))
              if (executing.size >= concurrency) await Promise.race(executing)
            }
            await Promise.all(executing)
            return results
          }) as ContextApi["pipeline"],
          async agent(ai: AgentInput): Promise<{ data: unknown; text: string } | null> {
            checkpoint()

            // --- Skip handling (x stops agent) ---
            if (ai.label && active.skipRequests.has(ai.label)) {
              const skipped = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                status: "failed" as const,
                started_at: Date.now(),
                completed_at: Date.now(),
                phase: ai.phase ?? active.run.current_phase,
                agent: ai.agent,
                label: ai.label,
                model: ai.model,
                prompt: ai.prompt,
                error: "skipped",
              } as any
              active.run.agents.push(skipped)
              active.skipRequests.delete(ai.label)
              await doPersist()
              return null
            }

            // --- Journal replay (pause/resume) ---
            if (active.journal && active.journalCursor < active.journal.length) {
              const cached = active.journal[active.journalCursor]
              // Simple heuristic: match by prompt or label; for prefix replay we just return in order
              // More advanced keyed replay could match by label, but prefix is safe for sequential pipelines
              if (cached && (cached.prompt === ai.prompt || cached.label === ai.label || input.invalidate_agents === undefined)) {
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
              phase: ai.phase ?? active.run.current_phase,
              agent: ai.agent,
              label: ai.label,
              model: ai.model,
              prompt: ai.prompt,
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

            await run(Semaphore.take(active.agentSemaphore, 1))
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
                return null
              }
              const result = await run(input.prompt.prompt({
                sessionID: session.id,
                agent: ai.agent,
                parts: [{ type: "text", text: ai.schema ? `${ai.prompt}\n\nRespond with ONLY a JSON object matching this schema (no markdown, no explanation):\n${JSON.stringify(ai.schema)}` : ai.prompt }],
              }))

              const assistant = result.info.role === "assistant" ? result.info : undefined
              const text = extractText(result.parts)
              let data: unknown
              if (ai.schema) {
                try { data = parseStructured(text) }
                catch { throw new StructuredOutputError({ message: "Failed to parse structured output" }) }
              }

              node.status = "completed"
              node.completed_at = Date.now()
              node.output = text
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
              return { data: data ?? {}, text }
            } catch (err) {
              node.status = "failed"
              node.completed_at = Date.now()
              node.error = errorText(err)
              await doPersist()
              if (ai.onError === "null") return null
              throw err
            } finally {
              await run(Semaphore.release(active.agentSemaphore, 1)).catch(() => {})
            }
          },
          async tool(name: string, args?: Record<string, unknown>) {
            checkpoint()
            // For now, log that tool is called and return null to allow graceful degradation
            // In future, this should delegate to ToolRegistry
            active.run.logs.push({ time: Date.now(), phase: active.run.current_phase, message: `tool:${name} ${JSON.stringify(args ?? {})}` })
            doPersist()
            // Return a stub that verification agents can still use
            return { output: `tool ${name} called`, metadata: {} } as any
          },
          async shell(command: string, opts?: { timeout?: number; cwd?: string }) {
            checkpoint()
            const timeout = opts?.timeout ?? 60_000
            const cwd = opts?.cwd ?? dir
            try {
              const proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
              const textPromise = new Response(proc.stdout).text()
              const errPromise = new Response(proc.stderr).text()
              const result = await Promise.race([
                Promise.all([textPromise, errPromise, proc.exited]).then(([out, errOut, _]) => ({
                  output: out + errOut,
                  exitCode: proc.exitCode ?? 0,
                })),
                new Promise<{ output: string; exitCode: number }>((_, reject) =>
                  setTimeout(() => {
                    proc.kill()
                    reject(new Error(`shell timeout after ${timeout}ms: ${command}`))
                  }, timeout),
                ),
              ])
              active.run.logs.push({
                time: Date.now(),
                phase: active.run.current_phase,
                message: `shell: ${command} → exit ${result.exitCode}`,
              })
              doPersist()
              return result
            } catch (e) {
              return { output: errorText(e), exitCode: 1 }
            }
          },
          async workflow(name: string, args?: Record<string, unknown>) {
            checkpoint()
            // Child workflow: run inline sharing same context (prefixes phases with "<name>: ")
            const prevPhase = active.run.current_phase
            try {
              const found = await run(read(name))
              if (!found) throw new NotFoundError({ name })
              const childMeta = MetaReader.read(found.source, found.path)
              if (!childMeta.valid) throw new InvalidError({ path: found.path, message: childMeta.error })
              // Load child module
              const childModulePath = found.path
              const childMod = await Effect.promise(() =>
                import(`${pathToFileURL(childModulePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`),
              ).pipe(Effect.orDie, run) as any
              const childRunFn = childMod.default?.run ?? childMod.run
              if (typeof childRunFn !== "function") throw new InvalidError({ path: found.path, message: "Child workflow missing run function" })
              // Prefix phase for child visibility (heuristic used in TUI mergeObservedPhases)
              const childCtx: ContextApi = {
                ...ctx,
                setPhase: (phase: string) => {
                  const prefixed = `${name}: ${phase}`
                  active.run.current_phase = prefixed
                  active.run.logs.push({ time: Date.now(), phase: prefixed, message: `Phase: ${prefixed}` })
                  doPersist()
                },
                log: (msg: string) => {
                  active.run.logs.push({ time: Date.now(), phase: active.run.current_phase, message: `[${name}] ${msg}` })
                  doPersist()
                },
              } as any
              // Restore original ctx methods that rely on active (parallel, agent, etc) remain same
              Object.setPrototypeOf(childCtx, ctx)
              const result = await childRunFn(args ?? {}, childCtx)
              return result
            } finally {
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
        }
      }

      const ctx = createContext({ phases: meta.phases })

      // --- Inject globals before import for top-level await style ---
      const globalKeys = ["agent", "pipeline", "parallel", "log", "setPhase", "workflow", "shell", "tool", "question", "args", "budget"]
      const g: any = globalThis as any
      const prevGlobalsBeforeImport: any = {}
      for (const k of globalKeys) prevGlobalsBeforeImport[k] = g[k]
      g.agent = ctx.agent
      g.pipeline = ctx.pipeline
      g.parallel = ctx.parallel
      g.log = ctx.log
      g.setPhase = ctx.setPhase
      g.workflow = ctx.workflow
      g.shell = ctx.shell
      g.tool = ctx.tool
      g.question = ctx.question
      g.args = args ?? {}
      g.budget = ctx.budget

      // Import workflow module AFTER globals are set so top-level await using bare agent works
      let mod: any
      try {
        mod = yield* Effect.promise(() => import(`${pathToFileURL(modulePath).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`))
      } catch (e) {
        // Restore globals on import failure to avoid leak
        for (const k of globalKeys) {
          if (prevGlobalsBeforeImport[k] === undefined) delete g[k]
          else g[k] = prevGlobalsBeforeImport[k]
        }
        return yield* new InvalidError({ path: targetPath, message: `Failed to import workflow: ${e instanceof Error ? e.message : String(e)}` })
      }
      // Cleanup temp file immediately after import
      if (isBuiltinPath(targetPath) || isInlinePath(targetPath) || input.temporary) {
        yield* Effect.promise(() => import("fs/promises").then((fs) => fs.unlink(tempPath).catch(() => {}))).pipe(Effect.ignore)
      }
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
        // Restore globals before throwing
        for (const k of globalKeys) {
          if (prevGlobalsBeforeImport[k] === undefined) delete g[k]
          else g[k] = prevGlobalsBeforeImport[k]
        }
        return yield* new InvalidError({ path: targetPath, message: "Workflow module missing run function" })
      }

      active.fiber = yield* Effect.promise((signal) => {
        runSignal = signal
        // Globals already set, but ensure they stay set for runFn execution
        g.agent = ctx.agent
        g.pipeline = ctx.pipeline
        g.parallel = ctx.parallel
        g.log = ctx.log
        g.setPhase = ctx.setPhase
        g.workflow = ctx.workflow
        g.shell = ctx.shell
        g.tool = ctx.tool
        g.question = ctx.question
        g.args = args ?? {}
        g.budget = ctx.budget
        return Promise.resolve(runFn(args ?? {}, ctx))
          .then(
            (result) => result,
            (error) => { throw error },
          )
          .finally(() => {
            for (const k of globalKeys) {
              if (prevGlobalsBeforeImport[k] === undefined) delete g[k]
              else g[k] = prevGlobalsBeforeImport[k]
            }
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
      return undefined
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
  ],
})

export * as Workflow from "./workflow"
