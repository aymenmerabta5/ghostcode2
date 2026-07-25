import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: SessionV1.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

type WithoutId<T> = T extends { id: any } ? Omit<T, "id"> : T

type UnwrapInfo<T> = T extends Info<infer P, any> ? P : never
type UnwrapInfoDeep<T> = T extends Effect.Effect<infer I, any, any>
  ? I extends Info<infer P, any>
    ? P
    : I extends Def<infer P, any>
      ? P
      : never
  : never

type UnwrapMetadata<T> = T extends Info<any, infer M> ? M : never
type UnwrapMetadataDeep<T> = T extends Effect.Effect<infer I, any, any>
  ? I extends Info<any, infer M>
    ? M
    : I extends Def<any, infer M>
      ? M
      : never
  : never

type UnwrapDefP<T> = T extends Info<infer P, any> ? P : never
type UnwrapDefM<T> = T extends Info<any, infer M> ? M : never
type UnwrapDefPDeep<T> = T extends Effect.Effect<infer I, any, any>
  ? I extends Info<infer P, any>
    ? P
    : I extends Def<infer P, any>
      ? P
      : never
  : never
type UnwrapDefMDeep<T> = T extends Effect.Effect<infer I, any, any>
  ? I extends Info<any, infer M>
    ? M
    : I extends Def<any, infer M>
      ? M
      : never
  : never

// Fallback to any when inference fails — ensures Partial<any> is any and allows property access.
export type InferParameters<T> =
  UnwrapInfo<T> extends never
    ? UnwrapInfoDeep<T> extends never
      ? UnwrapInfo<WithoutId<T>> extends never
        ? UnwrapInfoDeep<WithoutId<T>> extends never
          ? any
          : Schema.Schema.Type<UnwrapInfoDeep<WithoutId<T>>>
        : Schema.Schema.Type<UnwrapInfo<WithoutId<T>>>
      : Schema.Schema.Type<UnwrapInfoDeep<T>>
    : Schema.Schema.Type<UnwrapInfo<T>>

export type InferMetadata<T> =
  UnwrapMetadata<T> extends never
    ? UnwrapMetadataDeep<T> extends never
      ? UnwrapMetadata<WithoutId<T>> extends never
        ? UnwrapMetadataDeep<WithoutId<T>> extends never
          ? any
          : UnwrapMetadataDeep<WithoutId<T>>
        : UnwrapMetadata<WithoutId<T>>
      : UnwrapMetadataDeep<T>
    : UnwrapMetadata<T>

export type InferDef<T> =
  UnwrapDefP<T> extends never
    ? UnwrapDefPDeep<T> extends never
      ? UnwrapDefP<WithoutId<T>> extends never
        ? UnwrapDefPDeep<WithoutId<T>> extends never
          ? Def<any, any>
          : Def<UnwrapDefPDeep<WithoutId<T>>, UnwrapDefMDeep<WithoutId<T>>>
        : Def<UnwrapDefP<WithoutId<T>>, UnwrapDefM<WithoutId<T>>>
      : Def<UnwrapDefPDeep<T>, UnwrapDefMDeep<T>>
    : Def<UnwrapDefP<T>, UnwrapDefM<T>>

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(
          Effect.catchTag("ToolInvalidArgumentsError", (err) =>
            Effect.succeed({
              title: id,
              metadata: { error: true },
              output: err.message,
            } as any),
          ),
          Effect.catch((error: any) =>
            Effect.succeed({
              title: id,
              metadata: { error: true },
              output: error instanceof Error ? error.message : String(error),
            } as any),
          ),
          Effect.orDie,
          Effect.withSpan("Tool.execute", { attributes: attrs }),
        )
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
