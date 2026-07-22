import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/background"

export const BackgroundJobStatus = Schema.Literals(["running", "completed", "error", "cancelled"])

export const BackgroundJobInfo = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  status: BackgroundJobStatus,
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const BackgroundPaths = {
  list: root,
  get: `${root}/:id`,
  cancel: `${root}/:id/cancel`,
} as const

export const BackgroundApi = HttpApi.make("background")
  .add(
    HttpApiGroup.make("background")
      .add(
        HttpApiEndpoint.get("list", BackgroundPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(BackgroundJobInfo), "List of background jobs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.list",
            summary: "List background jobs",
            description:
              "List all running background jobs (task subagents and shell dev servers) from BackgroundJob.Service.",
          }),
        ),
        HttpApiEndpoint.get("get", BackgroundPaths.get, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(BackgroundJobInfo, "Background job info"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.get",
            summary: "Get background job",
            description: "Get a background job by id, including output and status.",
          }),
        ),
        HttpApiEndpoint.post("cancel", BackgroundPaths.cancel, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Cancelled"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "background.cancel",
            summary: "Cancel background job",
            description: "Cancel a running background job (task subagent or shell).",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "background", description: "Background jobs observation." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
