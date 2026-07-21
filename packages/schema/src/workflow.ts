export * as Workflow from "./workflow"

import { Schema, SchemaGetter } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { optional, statics } from "./schema"

export const RunID = Schema.String.check(Schema.isStartsWith("job")).pipe(
  Schema.brand("WorkflowRunID"),
  statics((schema) => ({
    ascending: (id?: string) => (id === undefined ? schema.make("job_" + ascending()) : schema.make(id)),
  })),
)
export type RunID = typeof RunID.Type

export const Argument = Schema.Struct({
  type: optional(Schema.String),
  default: optional(Schema.Unknown),
  description: optional(Schema.String),
}).annotate({ identifier: "WorkflowArgument" })
export interface Argument extends Schema.Schema.Type<typeof Argument> {}

export const PhaseBudget = Schema.Struct({
  usd: optional(Schema.Finite),
  tokens: optional(Schema.Finite),
})
export type PhaseBudget = Schema.Schema.Type<typeof PhaseBudget>

export const Phase = Schema.Struct({
  title: Schema.String,
  detail: optional(Schema.String),
  model: optional(Schema.String),
  budget: optional(Schema.Union([Schema.Finite, PhaseBudget])),
}).annotate({ identifier: "WorkflowPhase" })
export interface Phase extends Schema.Schema.Type<typeof Phase> {}

const PhaseEntry = Schema.Union([Schema.String, Phase])

const Phases = Schema.Array(PhaseEntry).pipe(
  Schema.decodeTo(Schema.Array(Phase), {
    decode: SchemaGetter.transform((entries) =>
      entries.map((entry) => (typeof entry === "string" ? { title: entry } : entry)),
    ),
    encode: SchemaGetter.transform((phases) =>
      phases.map((phase) =>
        phase.detail === undefined && phase.model === undefined && phase.budget === undefined ? phase.title : phase,
      ),
    ),
  }),
)

export const Meta = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  whenToUse: optional(Schema.String),
  phases: optional(Phases),
  arguments: optional(Schema.Record(Schema.String, Argument)),
  phaseValidation: optional(Schema.Literals(["strict", "warn"])),
  allowNondeterminism: optional(Schema.Boolean),
  tools: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "WorkflowMeta" })
export interface Meta extends Schema.Schema.Type<typeof Meta> {}

export function encodePhase(phase: Phase): string | Phase {
  return phase.detail === undefined && phase.model === undefined ? phase.title : phase
}

export const Info = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  meta: Meta,
  valid: Schema.Boolean,
  error: optional(Schema.String),
  source_kind: optional(Schema.Literals(["builtin"])),
}).annotate({ identifier: "WorkflowInfo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Source = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  source: Schema.String,
  source_kind: optional(Schema.Literals(["builtin"])),
}).annotate({ identifier: "WorkflowSource" })
export interface Source extends Schema.Schema.Type<typeof Source> {}

export const Definition = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  meta: Meta,
  source: optional(Schema.String),
  temporary: optional(Schema.Boolean),
}).annotate({ identifier: "WorkflowDefinition" })
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

export const Status = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "paused",
])
export type Status = Schema.Schema.Type<typeof Status>

export const ChildRef = Schema.Struct({
  run: Schema.String,
  workflow: Schema.String,
})

export const LogEntry = Schema.Struct({
  time: Schema.Finite,
  phase: optional(Schema.String),
  message: Schema.String,
  child: optional(ChildRef),
}).annotate({ identifier: "WorkflowLogEntry" })
export interface LogEntry extends Schema.Schema.Type<typeof LogEntry> {}

export const AgentRun = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "skipped"]),
  started_at: Schema.Finite,
  completed_at: optional(Schema.Finite),
  phase: optional(Schema.String),
  agent: optional(Schema.String),
  label: optional(Schema.String),
  model: optional(Schema.String),
  session_id: optional(Schema.String),
  message_id: optional(Schema.String),
  worktree: optional(Schema.String),
  prompt: Schema.String,
  output: optional(Schema.String),
  cost: optional(Schema.Finite),
  tokens: optional(
    Schema.Struct({
      total: optional(Schema.Finite),
      input: Schema.Finite,
      output: Schema.Finite,
      reasoning: Schema.Finite,
      cache: Schema.Struct({
        read: Schema.Finite,
        write: Schema.Finite,
      }),
    }),
  ),
  error: optional(Schema.String),
  cached: optional(Schema.Boolean),
  kind: optional(Schema.Literals(["agent", "question", "tool"])),
  answer: optional(Schema.String),
  cache_key: optional(Schema.String),
  child: optional(ChildRef),
  branch: optional(Schema.String),
  effort: optional(Schema.String),
  agentType: optional(Schema.String),
}).annotate({ identifier: "WorkflowAgentRun" })
export interface AgentRun extends Schema.Schema.Type<typeof AgentRun> {}

export const Run = Schema.Struct({
  id: RunID,
  session_id: optional(Schema.String),
  workflow: Schema.String,
  args: optional(Schema.Record(Schema.String, Schema.Unknown)),
  definition: optional(Definition),
  status: Status,
  started_at: Schema.Number,
  completed_at: optional(Schema.Number),
  current_phase: optional(Schema.String),
  logs: Schema.Array(LogEntry),
  agents: Schema.Array(AgentRun),
  result: optional(Schema.Unknown),
  error: optional(Schema.String),
  resume_of: optional(RunID),
  pending_question: optional(
    Schema.Struct({
      question: Schema.String,
      options: optional(Schema.Array(Schema.String)),
      asked_at: Schema.Number,
    }),
  ),
  phase_data: optional(Schema.Record(Schema.String, Schema.Unknown)),
  state: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "WorkflowRun" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

const RunEventData = {
  id: Schema.String,
  workflow: Schema.String,
  status: Status,
  current_phase: Schema.NullOr(Schema.String),
  directory: Schema.String,
  agents: Schema.Struct({
    total: Schema.Number,
    running: Schema.Number,
    failed: Schema.Number,
  }),
  pending_question: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
}

const Updated = define({
  type: "workflow.run.updated",
  schema: RunEventData,
})

const Finished = define({
  type: "workflow.run.finished",
  schema: RunEventData,
})

export const Event = { Updated, Finished, Definitions: inventory(Updated, Finished) }
