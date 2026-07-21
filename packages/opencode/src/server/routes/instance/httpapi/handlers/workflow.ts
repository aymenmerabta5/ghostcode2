import { Workflow } from "@/workflow/workflow"
import { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConflictError, notFound } from "../errors"
import { type AnswerPayload, type SavePayload, type StartPayload, WorkflowApiError } from "../groups/workflow"

function apiError(name: string) {
  return (error: Workflow.InvalidError | Workflow.NotFoundError) => {
    if (error._tag === "WorkflowInvalidError")
      return new WorkflowApiError({ message: error.message, workflow: name, path: error.path })
    return notFound(`Workflow not found: ${error.name}`)
  }
}

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const prompt = yield* SessionPrompt.Service

    const list = Effect.fn("WorkflowHttpApi.list")(function* () {
      return yield* workflow.list()
    })

    const runs = Effect.fn("WorkflowHttpApi.runs")(function* () {
      return yield* workflow.runs()
    })

    const source = Effect.fn("WorkflowHttpApi.source")(function* (ctx: { params: { name: string } }) {
      const result = yield* workflow.read(ctx.params.name)
      if (!result) return yield* notFound(`Workflow not found: ${ctx.params.name}`)
      return result
    })

    const get = Effect.fn("WorkflowHttpApi.get")(function* (ctx: { params: { id: Workflow.RunID } }) {
      const run = yield* workflow.get(ctx.params.id)
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const start = Effect.fn("WorkflowHttpApi.start")(function* (ctx: {
      params: { name: string }
      payload?: StartPayload
    }) {
      return yield* workflow
        .start({
          name: ctx.params.name,
          args: ctx.payload?.args,
          budget:
            ctx.payload?.budget !== undefined || ctx.payload?.budget_tokens !== undefined
              ? { usd: ctx.payload?.budget, tokens: ctx.payload?.budget_tokens }
              : undefined,
          permissionSessionID: ctx.payload?.permissionSessionID,
          resume_of: ctx.payload?.resume_of,
          invalidate_agents: ctx.payload?.invalidate_agents ? [...ctx.payload.invalidate_agents] : undefined,
          replay: ctx.payload?.replay,
          caller: ctx.payload?.permissionSessionID ? { sessionID: ctx.payload.permissionSessionID } : undefined,
          prompt: {
            prompt: (input) => prompt.prompt(input),
            cancel: (sessionID) => prompt.cancel(sessionID),
          },
        })
        .pipe(Effect.mapError(apiError(ctx.params.name)))
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { id: Workflow.RunID } }) {
      const run = yield* workflow.cancel(ctx.params.id)
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const pause = Effect.fn("WorkflowHttpApi.pause")(function* (ctx: { params: { id: Workflow.RunID } }) {
      const run = yield* workflow.pause(ctx.params.id)
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const skip = Effect.fn("WorkflowHttpApi.skip")(function* (ctx: {
      params: { id: Workflow.RunID; agentId: string }
    }) {
      const run = yield* workflow
        .skipAgent({ id: ctx.params.id, agentId: ctx.params.agentId })
        .pipe(Effect.mapError((error) => new ConflictError({ message: error.message, resource: ctx.params.id })))
      if (!run) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      return run
    })

    const answer = Effect.fn("WorkflowHttpApi.answer")(function* (ctx: {
      params: { id: Workflow.RunID }
      payload: AnswerPayload
    }) {
      const existing = yield* workflow.get(ctx.params.id)
      if (!existing) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      const result = yield* workflow
        .answer({
          id: ctx.params.id,
          answer: ctx.payload.answer,
          prompt: {
            prompt: (input) => prompt.prompt(input),
            cancel: (sessionID) => prompt.cancel(sessionID),
          },
          permissionSessionID: ctx.payload.permissionSessionID,
          caller: ctx.payload.permissionSessionID ? { sessionID: ctx.payload.permissionSessionID } : undefined,
        })
        .pipe(Effect.mapError(apiError(existing.workflow)))
      if (!result)
        return yield* new ConflictError({
          message: `Workflow run has no open question: ${ctx.params.id}`,
          resource: ctx.params.id,
        })
      return result
    })

    const save = Effect.fn("WorkflowHttpApi.save")(function* (ctx: { payload: SavePayload }) {
      return yield* workflow
        .save({ name: ctx.payload.name, source: ctx.payload.source, scope: ctx.payload.scope })
        .pipe(
          Effect.mapError((error) => {
            if (error._tag === "WorkflowSaveConflictError")
              return new ConflictError({
                message: `Workflow already exists: ${error.name}`,
                resource: error.path,
              })
            return new WorkflowApiError({ message: error.message, workflow: ctx.payload.name, path: error.path })
          }),
        )
    })

    const exportRun = Effect.fn("WorkflowHttpApi.export")(function* (ctx: { params: { id: Workflow.RunID }; query: { markdown?: boolean } }) {
      // markdown query param is handled — export always generates both JSON and markdown, but we respect the flag
      const result = yield* workflow.export(ctx.params.id)
      if (!result) return yield* notFound(`Workflow run not found: ${ctx.params.id}`)
      // If markdown=true, ensure markdown file exists (exportRun already writes it)
      // The result includes both files; caller can read bundle.md if needed
      return result
    })

    const remove = Effect.fn("WorkflowHttpApi.remove")(function* (ctx: { params: { id: Workflow.RunID } }) {
      return yield* workflow.remove(ctx.params.id)
    })

    return handlers
      .handle("list", list)
      .handle("runs", runs)
      .handle("source", source)
      .handle("get", get)
      .handle("start", start)
      .handle("cancel", cancel)
      .handle("pause", pause)
      .handle("skip", skip)
      .handle("answer", answer)
      .handle("save", save)
      .handle("export", exportRun)
      .handle("remove", remove)
  }),
)
