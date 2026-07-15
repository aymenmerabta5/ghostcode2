import { SessionID } from "@/session/schema"
import { Workflow } from "@/workflow/workflow"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError, ConflictError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/workflow"

export const StartPayload = Schema.Struct({
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  budget: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  budget_tokens: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  permissionSessionID: Schema.optional(SessionID),
  resume_of: Schema.optional(Workflow.RunID),
  invalidate_agents: Schema.optional(Schema.Array(Schema.Int)),
  replay: Schema.optional(Schema.Literals(["prefix", "keyed"])),
}).annotate({ identifier: "WorkflowStartPayload" })
export type StartPayload = Schema.Schema.Type<typeof StartPayload>

export const SavePayload = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  scope: Schema.optional(Schema.Literals(["project", "global"])),
}).annotate({ identifier: "WorkflowSavePayload" })
export type SavePayload = Schema.Schema.Type<typeof SavePayload>

export const SaveResult = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "WorkflowSaveResult" })
export type SaveResult = Schema.Schema.Type<typeof SaveResult>

export const AnswerPayload = Schema.Struct({
  answer: Schema.String,
  permissionSessionID: Schema.optional(SessionID),
}).annotate({ identifier: "WorkflowAnswerPayload" })
export type AnswerPayload = Schema.Schema.Type<typeof AnswerPayload>

export class WorkflowApiError extends Schema.TaggedErrorClass<WorkflowApiError>()(
  "WorkflowApiError",
  {
    message: Schema.String,
    workflow: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export const WorkflowPaths = {
  list: root,
  runs: `${root}/run`,
  save: `${root}/save`,
  get: `${root}/run/:id`,
  source: `${root}/:name/source`,
  start: `${root}/:name/start`,
  cancel: `${root}/run/:id/cancel`,
  pause: `${root}/run/:id/pause`,
  skip: `${root}/run/:id/agent/:agentId/skip`,
  answer: `${root}/run/:id/answer`,
  export: `${root}/run/:id/export`,
  remove: `${root}/run/:id`,
} as const

export const ExportResult = Schema.Struct({
  path: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "WorkflowExportResult" })
export type ExportResult = Schema.Schema.Type<typeof ExportResult>

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.get("list", WorkflowPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workflow.Info), "List of workflows"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.list",
            summary: "List workflows",
            description: "List discovered workflow definitions.",
          }),
        ),
        HttpApiEndpoint.get("runs", WorkflowPaths.runs, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Workflow.Run), "List of workflow runs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.runs",
            summary: "List workflow runs",
            description: "List persisted workflow execution runs for this instance.",
          }),
        ),
        HttpApiEndpoint.post("save", WorkflowPaths.save, {
          query: WorkspaceRoutingQuery,
          payload: SavePayload,
          success: described(SaveResult, "Workflow saved to disk"),
          error: [WorkflowApiError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.save",
            summary: "Save workflow",
            description: "Save a workflow source string as a discoverable workflow file.",
          }),
        ),
        HttpApiEndpoint.get("get", WorkflowPaths.get, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          success: described(Workflow.Run, "Workflow run"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.get",
            summary: "Get workflow run",
            description: "Get details for a workflow execution run.",
          }),
        ),
        HttpApiEndpoint.get("source", WorkflowPaths.source, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Workflow.Source, "Workflow source"),
          error: [ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.source",
            summary: "Read workflow source",
            description: "Resolve a named workflow's module source for the pre-run approval preview.",
          }),
        ),
        HttpApiEndpoint.post("start", WorkflowPaths.start, {
          params: { name: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.optional(StartPayload),
          success: described(Workflow.Run, "Workflow run started"),
          error: [WorkflowApiError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.start",
            summary: "Start workflow",
            description: "Start a workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("cancel", WorkflowPaths.cancel, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          success: described(Workflow.Run, "Workflow run cancelled"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.cancel",
            summary: "Cancel workflow run",
            description: "Cancel a running workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("pause", WorkflowPaths.pause, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          success: described(Workflow.Run, "Workflow run paused"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.pause",
            summary: "Pause workflow run",
            description: "Pause a running workflow execution run.",
          }),
        ),
        HttpApiEndpoint.post("skip", WorkflowPaths.skip, {
          params: { id: Workflow.RunID, agentId: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Workflow.Run, "Workflow run after requesting the skip"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.skip",
            summary: "Skip workflow agent step",
            description: "Skip one in-flight agent step of a live workflow run.",
          }),
        ),
        HttpApiEndpoint.post("answer", WorkflowPaths.answer, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          payload: AnswerPayload,
          success: described(Workflow.Run, "Workflow run after answering its open question"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, ConflictError, WorkflowApiError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.answer",
            summary: "Answer workflow question",
            description: "Answer a run's open human-in-the-loop question.",
          }),
        ),
        HttpApiEndpoint.post("export", WorkflowPaths.export, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          success: described(ExportResult, "Workflow run transcripts exported"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.export",
            summary: "Export workflow run transcripts",
            description: "Export a run's transcripts as JSONL files.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkflowPaths.remove, {
          params: { id: Workflow.RunID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workflow run deleted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "workflow.delete",
            summary: "Delete workflow run",
            description: "Delete a workflow run from persisted history.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workflow",
          description: "Workflow routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
