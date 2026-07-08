import { Effect, Schema } from "effect"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type {
  WorkflowContext,
  WorkflowParallelOptions,
  WorkflowPipelineFn,
  WorkflowPipelineOptions,
  WorkflowPipelineStage,
  WorkflowToolFn,
} from "@opencode-ai/plugin/workflow"
import type { Info, Run, RunID, Source } from "@opencode-ai/schema/workflow"
import type { InvalidError, NotFoundError, SaveConflictError } from "./errors"
import type { TurnBudget } from "./turn-budget"

const NonNegFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const BudgetInput = Schema.Union([
  NonNegFinite,
  Schema.Struct({
    usd: Schema.optional(NonNegFinite),
    tokens: Schema.optional(NonNegFinite),
  }),
])

export const StartInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  budget: Schema.optional(BudgetInput),
}).annotate({ identifier: "WorkflowStartInput" })
export type StartInput = Schema.Schema.Type<typeof StartInput>

export type PromptOps = {
  prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts, unknown>
  cancel?: (sessionID: SessionID) => Effect.Effect<void>
  currentModel?: (
    sessionID: SessionID,
  ) => Effect.Effect<{ providerID: string; modelID: string; variant?: string }, unknown>
}

export type StartOptions = StartInput & {
  prompt?: PromptOps
  source?: string
  temporary?: boolean
  permissionSessionID?: SessionID
  caller?: { sessionID: SessionID; agent?: string }
  pool?: TurnBudget.Pool
  caller_model?: { providerID: string; modelID: string }
  resume_of?: RunID
  replay?: "prefix" | "keyed"
  invalidate_agents?: number[]
  questionAnswers?: Record<string, string>
}

export type WaitInput = { id: RunID; timeout?: number }
export type WaitResult = { run?: Run; timedOut: boolean }

export type AnswerInput = {
  id: RunID
  answer: string
  prompt?: PromptOps
  permissionSessionID?: SessionID
  caller?: { sessionID: SessionID; agent?: string }
  budget?: number | { usd?: number; tokens?: number }
}

export type SaveScope = "project" | "global"
export type SaveInput = { name: string; source: string; scope?: SaveScope }

export type AgentInput = {
  agent?: string
  prompt: string
  model?: string
  variant?: string
  tools?: Record<string, boolean>
  skills?: string[]
  files?: string[]
  schema?: Record<string, unknown>
  permissionSessionID?: SessionID
  phase?: string
  label?: string
  isolation?: "worktree"
  onError?: "fail" | "null"
}

export type ToolInput = {
  timeout?: number
  onError?: "fail" | "null"
}

export type ParallelOptions = WorkflowParallelOptions
export type PipelineOptions = WorkflowPipelineOptions
export type PipelineStage<Prev, Item, Next> = WorkflowPipelineStage<Prev, Item, Next>
export type PipelineFn = WorkflowPipelineFn

export type ContextApi = {
  readonly budgetRemaining: number
  readonly budget: {
    readonly total: number | null
    spent(): number
    remaining(): number
    readonly tokensTotal: number | null
    tokensSpent(): number
    tokensRemaining(): number
  }
  readonly setPhase: (phase: string) => void
  readonly log: (message: string) => void
  readonly parallel: <T>(
    tasks: readonly (() => Promise<T>)[],
    options?: ParallelOptions,
  ) => Promise<(T | null)[]>
  readonly pipeline: PipelineFn
  readonly agent: (input: AgentInput) => Promise<{ data: unknown; text: string } | null>
  readonly tool: WorkflowToolFn
  readonly shell: (
    command: string,
    opts?: { timeout?: number; cwd?: string },
  ) => Promise<{ output: string; exitCode: number }>
  readonly workflow: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  readonly question: (input: {
    question: string
    options?: readonly string[]
    timeout?: number
  }) => Promise<{ answer: string }>
}

type _ContextApiSatisfiesWorkflowContext = ContextApi extends WorkflowContext ? true : never
const _contextApiCheck: _ContextApiSatisfiesWorkflowContext = true
void _contextApiCheck

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly read: (name: string) => Effect.Effect<Source | undefined>
  readonly runs: () => Effect.Effect<Run[]>
  readonly get: (id: RunID) => Effect.Effect<Run | undefined>
  readonly start: (input: StartOptions) => Effect.Effect<Run, InvalidError | NotFoundError>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly cancel: (id: RunID) => Effect.Effect<Run | undefined>
  readonly pause: (id: RunID) => Effect.Effect<Run | undefined>
  readonly skipAgent: (input: { id: RunID; agentId: string }) => Effect.Effect<Run | undefined, InvalidError>
  readonly answer: (input: AnswerInput) => Effect.Effect<Run | undefined, InvalidError | NotFoundError>
  readonly save: (input: SaveInput) => Effect.Effect<{ path: string }, InvalidError | SaveConflictError>
  readonly export: (id: RunID) => Effect.Effect<{ path: string; files: string[] } | undefined>
  readonly remove: (id: RunID) => Effect.Effect<boolean>
  readonly sweep: () => Effect.Effect<void>
}
