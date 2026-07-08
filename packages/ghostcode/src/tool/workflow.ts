import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Workflow } from "@/workflow/workflow"
import type { TaskPromptOps } from "@/tool/task"
import { SessionID } from "@/session/schema"
import DESCRIPTION from "./workflow.txt"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["read", "start", "wait", "list", "inspect", "cancel", "create"]).annotate({
    description:
      "read: get a workflow's source. start: run a workflow by name with optional args/budget. wait: block until a run finishes or timeout. list: list available workflows. inspect: get run status/details. cancel: cancel a running workflow. create: save a new workflow source.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Workflow name (for read/start/create).",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Arguments object for the workflow run (action=start).",
  }),
  budget: Schema.optional(Schema.Union([Schema.Number, Schema.Struct({
    usd: Schema.optional(Schema.Number),
    tokens: Schema.optional(Schema.Number),
  })])).annotate({
    description: "USD or token budget cap for the run (action=start).",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Run ID (action=wait/inspect/cancel).",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Max seconds to wait (action=wait). Omit for no timeout.",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "Workflow source code (action=create or action=start with inline source).",
  }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description: "Save scope (action=create). Defaults to project.",
  }),
})

type Metadata = {
  runID?: string
  workflow?: string
  status?: string
}

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, Workflow.Service>(
  "workflow",
  Effect.gen(function* () {
    const workflows = yield* Workflow.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const items = yield* workflows.list()
            const valid = items.filter((w) => w.valid)
            const invalid = items.filter((w) => !w.valid)
            const lines = [
              valid.length ? `Available workflows (${valid.length}):` : "No valid workflows found.",
              ...valid.map((w) => `- ${w.name}: ${w.meta.description ?? "(no description)"}`),
              ...(invalid.length ? [`\nInvalid workflows (${invalid.length}):`, ...invalid.map((w) => `- ${w.name}: ${w.error}`)] : []),
            ]
            return {
              title: `${items.length} workflow(s)`,
              output: lines.join("\n"),
              metadata: {},
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "read") {
            if (!params.name) return { title: "error", output: "name required for read", metadata: {} }
            const source = yield* workflows.read(params.name)
            if (!source) return { title: "not found", output: `Workflow '${params.name}' not found`, metadata: {} }
            return {
              title: source.name,
              output: source.source,
              metadata: {},
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "start") {
            const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
            const result = yield* Effect.result(workflows.start({
              name: params.name,
              args: params.args,
              budget: params.budget,
              source: params.source,
              caller: { sessionID: ctx.sessionID },
              prompt: promptOps ? {
                prompt: (input) => promptOps.prompt(input),
                cancel: (sessionID) => promptOps.cancel(sessionID),
              } : undefined,
            }))
            if (result._tag === "Failure") {
              const err = result.failure
              return { title: "error", output: err instanceof Error ? err.message : String(err), metadata: {} } satisfies Tool.ExecuteResult<Metadata>
            }
            const run = result.success
            return {
              title: `${run.workflow} started`,
              output: `Started workflow '${run.workflow}' — run ID: ${run.id}\nStatus: ${run.status}\nPhases: ${run.definition?.meta.phases?.map((p: any) => typeof p === "string" ? p : p.title).join(" → ") ?? "(none)"}`,
              metadata: { runID: run.id, workflow: run.workflow, status: run.status },
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "wait") {
            if (!params.id) return { title: "error", output: "id required for wait", metadata: {} }
            const result = yield* workflows.wait({
              id: params.id as Workflow.RunID,
              timeout: params.timeout ? params.timeout * 1000 : undefined,
            })
            return {
              title: result.timedOut ? "timeout" : (result.run?.status ?? "unknown"),
              output: result.run
                ? `Run ${result.run.id}: ${result.run.status}\nWorkflow: ${result.run.workflow}\nPhase: ${result.run.current_phase ?? "(none)"}\nAgents: ${result.run.agents.length} (${result.run.agents.filter((a) => a.status === "completed").length} completed, ${result.run.agents.filter((a) => a.status === "failed").length} failed)\n${result.run.error ? `Error: ${result.run.error}` : ""}${result.run.result !== undefined ? `\nResult: ${JSON.stringify(result.run.result, null, 2)}` : ""}`
                : "Run not found",
              metadata: { runID: result.run?.id, status: result.run?.status },
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "inspect") {
            if (!params.id) return { title: "error", output: "id required for inspect", metadata: {} }
            const run = yield* workflows.get(params.id as Workflow.RunID)
            if (!run) return { title: "not found", output: `Run '${params.id}' not found`, metadata: {} }
            return {
              title: run.status,
              output: JSON.stringify(run, null, 2),
              metadata: { runID: run.id, status: run.status },
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "cancel") {
            if (!params.id) return { title: "error", output: "id required for cancel", metadata: {} }
            const run = yield* workflows.cancel(params.id as Workflow.RunID)
            return {
              title: run?.status ?? "not found",
              output: run ? `Cancelled run ${run.id} — status: ${run.status}` : `Run '${params.id}' not found`,
              metadata: { runID: run?.id, status: run?.status },
            } satisfies Tool.ExecuteResult<Metadata>
          }

          if (params.action === "create") {
            if (!params.name) return { title: "error", output: "name required for create", metadata: {} }
            if (!params.source) return { title: "error", output: "source required for create", metadata: {} }
            const result = yield* Effect.result(workflows.save({
              name: params.name,
              source: params.source,
              scope: params.scope,
            }))
            if (result._tag === "Failure") {
              const err = result.failure
              return { title: "error", output: err instanceof Error ? err.message : String(err), metadata: {} } satisfies Tool.ExecuteResult<Metadata>
            }
            return {
              title: "saved",
              output: `Saved workflow '${params.name}' to ${result.success.path}`,
              metadata: {},
            } satisfies Tool.ExecuteResult<Metadata>
          }

          return { title: "error", output: `Unknown action: ${params.action}`, metadata: {} }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
