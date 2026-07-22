import { BackgroundJob } from "@/background/job"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"

export const backgroundHandlers = HttpApiBuilder.group(InstanceHttpApi, "background", (handlers) =>
  Effect.gen(function* () {
    const bg = yield* BackgroundJob.Service

    const list = Effect.fn("BackgroundHttpApi.list")(function* (_ctx: { query: typeof WorkspaceRoutingQuery.Type }) {
      return yield* bg.list()
    })

    const get = Effect.fn("BackgroundHttpApi.get")(function* (ctx: {
      params: { id: string }
      query: typeof WorkspaceRoutingQuery.Type
    }) {
      const job = yield* bg.get(ctx.params.id)
      if (!job) return yield* new HttpApiError.NotFound({})
      return job
    })

    const cancel = Effect.fn("BackgroundHttpApi.cancel")(function* (ctx: {
      params: { id: string }
      query: typeof WorkspaceRoutingQuery.Type
    }) {
      const info = yield* bg.cancel(ctx.params.id)
      return !!info
    })

    return handlers.handle("list", list).handle("get", get).handle("cancel", cancel)
  }),
)
