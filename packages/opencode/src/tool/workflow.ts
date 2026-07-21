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

export const WorkflowTool = Tool.define<typeof Parameters, Metadata, never>(
  "workflow",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: ((params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const workflows = yield* Workflow.Service
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
            if (!result.run) {
              return {
                title: result.timedOut ? "timeout" : "not found",
                output: "Run not found",
                metadata: {},
              } satisfies Tool.ExecuteResult<Metadata>
            }
            const run = result.run
            const completed = run.agents.filter((a) => a.status === "completed").length
            const failed = run.agents.filter((a) => a.status === "failed").length
            let resultSection = ""
            if (run.result !== undefined) {
              const res: unknown = run.result
              if (typeof res === "string") {
                const cap = 100_000
                resultSection = `\nResult (string, ${res.length} chars):\n${res.slice(0, cap)}${res.length > cap ? `\n... truncated ${res.length - cap} chars ...` : ""}\n`
              } else if (res !== null && typeof res === "object" && !Array.isArray(res)) {
                const obj = res as Record<string, unknown>
                const finalReport = [obj.finalReport, obj.report, obj.summary].find(
                  (v): v is string => typeof v === "string" && v.length > 0,
                )
                if (finalReport) {
                  const cap = 100_000
                  resultSection = `\nFinal Report (${finalReport.length} chars):\n${finalReport.slice(0, cap)}${finalReport.length > cap ? `\n... truncated ${finalReport.length - cap} chars ...` : ""}\n`
                  const otherKeys = Object.keys(obj).filter((k) => !["finalReport", "report", "summary"].includes(k))
                  if (otherKeys.length > 0) {
                    const other = Object.fromEntries(otherKeys.map((k) => [k, obj[k]]))
                    const j = JSON.stringify(other, null, 2)
                    resultSection += `\nOther fields: ${j.slice(0, 5000)}${j.length > 5000 ? " ... truncated" : ""}\n`
                  }
                } else {
                  const json = JSON.stringify(res, null, 2)
                  resultSection = `\nResult: ${json.slice(0, 15000)}${json.length > 15000 ? `\n... truncated ${json.length - 15000} chars ...` : ""}`
                }
              } else {
                const json = JSON.stringify(res, null, 2)
                resultSection = `\nResult: ${json.slice(0, 15000)}${json.length > 15000 ? `\n... truncated ${json.length - 15000} chars ...` : ""}`
              }
            }
            // List agents to help debugging when result is large
            const agentList = run.agents
              .map((a: any) => {
                const err = a.error ? ` err:${a.error.slice(0, 120)}` : ""
                return `- ${a.label ?? a.id.slice(-6)} [${a.status}] ${a.output ? `(${a.output.length} chars)` : ""}${err}`
              })
              .join("\n")
            return {
              title: result.timedOut ? "timeout" : (run.status ?? "unknown"),
              output: `Run ${run.id}: ${run.status}\nWorkflow: ${run.workflow}\nPhase: ${run.current_phase ?? "(none)"}\nAgents: ${run.agents.length} (${completed} completed, ${failed} failed)\n${run.error ? `Error: ${run.error}\n` : ""}${agentList ? `\nAgents:\n${agentList}\n` : ""}${resultSection}${result.timedOut ? "\nTimed out waiting for completion" : ""}`,
              metadata: { runID: run.id, status: run.status },
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
        })) as any,
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
