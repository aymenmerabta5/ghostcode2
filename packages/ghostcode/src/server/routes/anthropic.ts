import { Context, Effect, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { generateText, jsonSchema, streamText, tool, type ToolSet } from "ai"
import { z } from "zod"
import { Provider, type Model } from "@/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Resume } from "@/session/resume"
import { AppRuntime } from "@/effect/app-runtime"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ROTATE_COOLDOWN_MS = 60_000

const messageParamSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(z.any())]),
})

type MessageParam = z.infer<typeof messageParamSchema>

const thinkingSchema = z.object({
  type: z.enum(["enabled", "disabled", "adaptive"]).optional(),
  budget_tokens: z.number().optional(),
})

const messagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(messageParamSchema),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  thinking: z.union([z.boolean(), thinkingSchema]).optional(),
})

function exposedModelID(providerID: string, modelID: string): string {
  if (modelID.startsWith(`${providerID}/`)) return modelID
  return `${providerID}/${modelID}`
}

function toolResultOutput(part: any): any {
  const content = part.content
  if (typeof content === "string") {
    return part.is_error ? { type: "error-text", value: content } : { type: "text", value: content }
  }
  const blocks = Array.isArray(content) ? content : []
  if (part.is_error) {
    return { type: "error-text", value: blocks.map((b: any) => b.text ?? "").join("") }
  }
  return {
    type: "content",
    value: blocks.map((b: any): any => {
      if (b.type === "image") return { type: "media", data: b.source?.data ?? "", mediaType: b.source?.media_type ?? "" }
      return { type: "text", text: b.text ?? "" }
    }),
  }
}

function toModelMessages(input: MessageParam[]): any[] {
  const toolNameById = new Map<string, string>()
  for (const m of input) {
    if (typeof m.content !== "string") {
      for (const part of m.content) {
        if ((part as any).type === "tool_use") toolNameById.set((part as any).id, (part as any).name)
      }
    }
  }

  return input.flatMap((m): any[] => {
    const role = m.role === "system" ? "system" : m.role
    if (typeof m.content === "string") {
      return [{ role, content: m.content }]
    }
    const parts = m.content.map((part: any): any => {
      if (part.type === "text") return { type: "text", text: part.text }
      if (part.type === "image") {
        return { type: "image", image: part.source.data, mimeType: part.source.media_type }
      }
      if (part.type === "tool_use") {
        return { type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input ?? {} }
      }
      if (part.type === "tool_result") {
        return {
          type: "tool-result",
          toolCallId: part.tool_use_id,
          toolName: toolNameById.get(part.tool_use_id) ?? "",
          output: toolResultOutput(part),
        }
      }
      return { type: "text", text: "" }
    })
    if (m.role === "user" && parts.some((p: any) => p.type === "tool-result")) {
      const toolResults = parts.filter((p: any) => p.type === "tool-result")
      const rest = parts.filter((p: any) => p.type !== "tool-result")
      const messages: any[] = [{ role: "tool", content: toolResults }]
      if (rest.length > 0) messages.push({ role: "user", content: rest })
      return messages
    }
    return [{ role, content: parts }]
  })
}

function parseModelID(raw: string): { providerID: string; modelID: string } | undefined {
  const parts = raw.split("/")
  if (parts.length < 2) return undefined
  const providerID = parts[0]
  const modelID = parts.slice(1).join("/")
  return { providerID, modelID }
}

function toAnthropicToolChoice(input: any): any {
  if (!input) return undefined
  if (input.type === "auto") return "auto"
  if (input.type === "any") return "required"
  if (input.type === "tool") return { type: "tool", toolName: input.name }
  return undefined
}

function toAITools(input: any[] | undefined): ToolSet | undefined {
  if (!input || input.length === 0) return undefined
  const result: ToolSet = {}
  for (const item of input) {
    result[item.name] = tool({
      description: item.description,
      inputSchema: jsonSchema(item.input_schema as any),
    })
  }
  return result
}

function toolInput(toolCall: any): unknown {
  return toolCall.args ?? toolCall.input ?? {}
}

function systemText(system: string | any[] | undefined): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.map((p: any) => (p.type === "text" ? p.text : "")).join("")
}

function estimateTokens(messages: MessageParam[], system?: string | any[]): number {
  let text = systemText(system)
  for (const m of messages) {
    if (typeof m.content === "string") {
      text += m.content
    } else {
      text += m.content.map((p: any) => (p.type === "text" ? p.text : "")).join("")
    }
  }
  return Math.ceil(text.length / 4)
}

function toAnthropicStopReason(finishReason: string | undefined): string {
  switch (finishReason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool-calls":
      return "tool_use"
    default:
      return "end_turn"
  }
}

type RouteErrorKind = "ratelimit" | "exhausted"
type RouteError = { kind: RouteErrorKind; retryAfterMs?: number }

function apiErrorDetails(error: unknown): {
  statusCode?: number
  message: string
  body: string
  headers?: Record<string, string>
} {
  if (error && typeof error === "object") {
    const e = error as Record<string, any>
    const statusCode =
      typeof e.statusCode === "number"
        ? e.statusCode
        : typeof e.responseStatus === "number"
          ? e.responseStatus
          : undefined
    const message = typeof e.message === "string" ? e.message : ""
    const body =
      typeof e.responseBody === "string"
        ? e.responseBody
        : e.data && typeof e.data === "object"
          ? JSON.stringify(e.data)
          : ""
    const headers =
      e.responseHeaders && typeof e.responseHeaders === "object"
        ? (e.responseHeaders as Record<string, string>)
        : undefined
    if (statusCode !== undefined || message || body) {
      return { statusCode, message, body, headers }
    }
  }
  return { message: error instanceof Error ? error.message : String(error), body: "" }
}

function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined
  const lower: Record<string, string> = {}
  for (const k in headers) lower[k.toLowerCase()] = headers[k]
  const ms = lower["retry-after-ms"]
  if (ms !== undefined) {
    const n = Number(ms)
    if (!Number.isNaN(n)) return n
  }
  const s = lower["retry-after"]
  if (s !== undefined) {
    const n = Number(s)
    if (!Number.isNaN(n)) return n * 1000
  }
  return undefined
}

export function isConnectionLevelFailure(error: unknown): boolean {
  const { statusCode, message } = apiErrorDetails(error)
  if (statusCode !== undefined) return false
  const msg = message.toLowerCase()
  return (
    msg.includes("stream ended without finish") ||
    msg.includes("econnreset") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection was closed unexpectedly") ||
    msg.includes("the connection was closed") ||
    msg.includes("sse stalled") ||
    msg.includes("aborted")
  )
}

export function classifyRouteError(error: unknown): RouteError | undefined {
  const { statusCode, message, body, headers } = apiErrorDetails(error)
  const lowerMessage = message.toLowerCase()
  const lowerBody = body.toLowerCase()
  const retryAfterMs = parseRetryAfterMs(headers)
  if (lowerBody.includes("used up your") || lowerMessage.includes("used up your")) {
    return { kind: "exhausted", retryAfterMs }
  }
  if (
    statusCode === 429 ||
    body.includes("rate_limit") ||
    body.includes("too_many_requests") ||
    lowerBody.includes("too many requests") ||
    lowerBody.includes("rate limit") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("rate limit")
  ) {
    return { kind: "ratelimit", retryAfterMs }
  }
  if (statusCode === 500 || statusCode === 502 || statusCode === 503) {
    return { kind: "ratelimit", retryAfterMs }
  }
  if (isConnectionLevelFailure(error)) {
    return { kind: "ratelimit" }
  }
  return undefined
}

function routeCooldownOpts(cls: RouteError): { retryAfterMs?: number; exhausted?: boolean } {
  if (cls.kind === "exhausted") {
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
    return { retryAfterMs: midnight.getTime() - now.getTime() }
  }
  return { retryAfterMs: Math.max(cls.retryAfterMs ?? 0, ROTATE_COOLDOWN_MS) }
}

export async function warmupAnthropicProvider(directory: string): Promise<void> {
  const ctx = await AppRuntime.runPromise(InstanceStore.use.load({ directory }))
  const providers = await AppRuntime.runPromise(
    Provider.use.list().pipe(Effect.provideService(InstanceRef, ctx)),
  )
  for (const info of Object.values(providers)) {
    const apiKeys = (info.options as Record<string, unknown> | undefined)?.apiKeys
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) continue
    const firstModelID = Object.keys(info.models)[0]
    if (!firstModelID) continue
    await AppRuntime.runPromise(
      Provider.use.getLanguage(info.models[firstModelID]).pipe(Effect.provideService(InstanceRef, ctx)),
    ).catch((e) => {
      console.error(
        `[anthropic-api] warmup: getLanguage failed for ${info.id}:`,
        e instanceof Error ? e.message : e,
      )
    })
  }
}

function handleModels(directory: string) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const providers = yield* Provider.use.list()
      const data = Object.values(providers).flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          type: "model" as const,
          id: exposedModelID(provider.id, model.id),
          display_name: model.name,
          created_at: "1970-01-01T00:00:00Z",
        })),
      )
      return HttpServerResponse.jsonUnsafe({
        data,
        has_more: false,
        first_id: data[0]?.id,
        last_id: data[data.length - 1]?.id,
      })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleCountTokens(directory: string, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const body = messagesRequestSchema.parse(yield* request.json)
      return HttpServerResponse.jsonUnsafe({ input_tokens: estimateTokens(body.messages, body.system) })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleMessages(directory: string, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const ctx = yield* InstanceStore.use.load({ directory })
    return yield* Effect.gen(function* () {
      const body = messagesRequestSchema.parse(yield* request.json)
      const parsed = parseModelID(body.model)
      if (!parsed) {
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "invalid_request_error", message: "Invalid model ID" } },
          { status: 400 },
        )
      }
      const providerID = ProviderV2.ID.make(parsed.providerID)
      const modelObj = yield* Provider.use.getModel(providerID, ModelV2.ID.make(parsed.modelID))
      const system = systemText(body.system)
      const coreMessages = toModelMessages(body.messages)
      if (body.stream) {
        return yield* handleStream(body, modelObj, providerID, system, coreMessages)
      }
      return yield* handleNonStream(body, modelObj, providerID, system, coreMessages)
    }).pipe(Effect.provideService(InstanceRef, ctx))
  })
}

function handleStream(
  body: z.infer<typeof messagesRequestSchema>,
  modelObj: Model,
  providerID: ProviderV2.ID,
  system: string,
  coreMessages: any[],
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context()
    const run = Effect.runPromiseWith(context) as <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
    const encoder = new TextEncoder()
    const messageId = `msg_${crypto.randomUUID()}`
    const abortController = new AbortController()
    let clientGone = false

    const readableStream = new ReadableStream({
      async start(controller: ReadableStreamDefaultController) {
        let messageStarted = false
        let blockIndex = 0
        let blockType: "text" | "thinking" | "tool_use" | null = null
        let finishReason: string | undefined
        let hadToolCall = false
        let lastError: unknown
        let contentStarted = false
        let resumeContent = ""
        let partialReasoning = ""
        let partialText = ""
        let dedupChecked = false

        const send = (s: string) => {
          if (clientGone) return
          try {
            controller.enqueue(encoder.encode(s))
          } catch {
            clientGone = true
          }
        }
        const safeClose = () => {
          try {
            controller.close()
          } catch {}
        }

        const startMessage = () => {
          if (messageStarted) return
          messageStarted = true
          send(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: messageId,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 1 },
              },
            })}\n\n`,
          )
        }

        const closeBlock = () => {
          if (!blockType) return
          send(
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
          )
          blockIndex++
          blockType = null
        }
        const openTextBlock = () => {
          if (blockType === "text") return
          closeBlock()
          send(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`,
          )
          blockType = "text"
        }
        const openThinkingBlock = () => {
          if (blockType === "thinking") return
          closeBlock()
          send(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "thinking", thinking: "" },
            })}\n\n`,
          )
          blockType = "thinking"
        }
        const emitTextDelta = (text: string) => {
          if (!text) return
          openTextBlock()
          send(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text },
            })}\n\n`,
          )
        }
        const emitThinkingDelta = (thinking: string) => {
          if (!thinking) return
          openThinkingBlock()
          send(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "thinking_delta", thinking },
            })}\n\n`,
          )
        }

        try {
          let attempt = 0
          for (;;) {
            if (clientGone) return
            const rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
            if (rotation && rotation.total > 0 && rotation.available === 0) {
              console.error("[anthropic-api] BREAK - all keys exhausted or on cooldown", {
                total: rotation.total,
                available: rotation.available,
              })
              if (!lastError) lastError = new Error("All keys exhausted or on cooldown")
              break
            }

            let keyIndex: number | undefined
            const language = await run(
              Provider.use.getLanguage(modelObj, (index: number) => {
                keyIndex = index
              }),
            )

            let streamError: unknown
            partialReasoning = ""
            partialText = ""
            const messages = resumeContent
              ? [...coreMessages, { role: "assistant" as const, content: resumeContent }]
              : coreMessages
            if (resumeContent) {
              console.log("[anthropic-api] RESUME inject", {
                resumeChars: resumeContent.length,
                keyIndex,
              })
            }
            const result = streamText({
              model: language,
              system,
              messages,
              temperature: body.temperature,
              maxOutputTokens: body.max_tokens,
              topP: body.top_p,
              topK: body.top_k,
              stopSequences: body.stop_sequences,
              tools: toAITools(body.tools),
              toolChoice: toAnthropicToolChoice(body.tool_choice),
              abortSignal: abortController.signal,
              maxRetries: 0,
              onError(error: any) {
                streamError = error.error
                console.error("[anthropic-api] streamText error", {
                  keyIndex,
                  message: error.error instanceof Error ? error.error.message : String(error.error),
                })
              },
            })

            const attemptStart = Date.now()
            let gotFirstContent = false
            console.log("[anthropic-api] streamText start", { keyIndex, attempt, resumeChars: resumeContent.length })

            try {
              startMessage()
              finishReason = undefined
              hadToolCall = false
              dedupChecked = false

              for await (const part of result.fullStream) {
                if (clientGone) break
                if (
                  !gotFirstContent &&
                  (part.type === "text-delta" || part.type === "reasoning-start" || part.type === "reasoning-delta")
                ) {
                  gotFirstContent = true
                  console.log("[anthropic-api] TTFT", {
                    keyIndex,
                    attempt,
                    ttftMs: Date.now() - attemptStart,
                    partType: part.type,
                  })
                }
                if (part.type === "text-delta") {
                  contentStarted = true
                  let text = (part as any).text
                  if (resumeContent && !dedupChecked) {
                    dedupChecked = true
                    text = Resume.stripOverlap(resumeContent, text)
                    if (!text) continue
                  }
                  partialText += text
                  emitTextDelta(text)
                } else if (part.type === "reasoning-start") {
                  contentStarted = true
                  openThinkingBlock()
                } else if (part.type === "reasoning-delta") {
                  const reasoning = (part as any).text ?? (part as any).delta ?? (part as any).reasoning ?? ""
                  partialReasoning += reasoning
                  emitThinkingDelta(reasoning)
                } else if (part.type === "reasoning-end") {
                  closeBlock()
                } else if (part.type === "finish-step" || part.type === "finish") {
                  finishReason = (part as any).finishReason
                } else if (part.type === "error") {
                  closeBlock()
                  throw (part as any).error
                } else if (part.type === "tool-call") {
                  hadToolCall = true
                  closeBlock()
                  const input = JSON.stringify(toolInput(part))
                  send(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: {
                        type: "tool_use",
                        id: (part as any).toolCallId,
                        name: (part as any).toolName,
                        input: {},
                      },
                    })}\n\n`,
                  )
                  send(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: blockIndex,
                      delta: { type: "input_json_delta", partial_json: input },
                    })}\n\n`,
                  )
                  send(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: blockIndex,
                    })}\n\n`,
                  )
                  blockIndex++
                }
              }

              if (clientGone) {
                console.log("[anthropic-api] streamText ended - client gone during stream", {
                  keyIndex,
                  attempt,
                  durationMs: Date.now() - attemptStart,
                })
                return
              }

              console.log("[anthropic-api] streamText success", {
                keyIndex,
                attempt,
                durationMs: Date.now() - attemptStart,
                finishReason,
                hadToolCall,
                textChars: partialText.length,
                reasoningChars: partialReasoning.length,
              })
              closeBlock()
              const usage = await result.usage
              send(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: {
                    stop_reason: toAnthropicStopReason(finishReason ?? (hadToolCall ? "tool-calls" : undefined)),
                    stop_sequence: null,
                  },
                  usage: { output_tokens: usage.outputTokens },
                })}\n\n`,
              )
              send(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
              safeClose()
              return
            } catch (error) {
              const actual = streamError ?? error
              const errMsg = actual instanceof Error ? actual.message : String(actual ?? "")
              if (clientGone || abortController.signal.aborted) {
                console.log("[anthropic-api] client disconnected - aborting silently", {
                  errorMessage: errMsg,
                  contentStarted,
                  keyIndex,
                  attempt,
                })
                return
              }
              const cls = classifyRouteError(actual)
              console.log("[anthropic-api] catch", {
                errorMessage: errMsg,
                classified: cls?.kind ?? "unclassified (terminal)",
                contentStarted,
                hasRotation: !!rotation,
                resumeContentLen: resumeContent.length,
                keyIndex,
                attempt,
                durationMs: Date.now() - attemptStart,
              })
              if (cls && rotation) {
                await run(
                  Provider.use.markRateLimited(providerID, keyIndex, routeCooldownOpts(cls)),
                ).catch(() => undefined)
                if (contentStarted) {
                  const chunk = partialReasoning + (partialText ? "\n\n" + partialText : "")
                  if (chunk)
                    resumeContent = Resume.compactResume(resumeContent + (resumeContent ? "\n\n" : "") + chunk)
                }
                if (blockType) closeBlock()
                lastError = actual
                attempt++
                continue
              }
              lastError = actual
              console.error("[anthropic-api] TERMINAL - error not rotatable, breaking", {
                errorMessage: errMsg,
                contentStarted,
              })
              break
            }
          }

          const actual = lastError
          if (clientGone) return
          if (blockType) closeBlock()
          send(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: actual instanceof Error ? actual.message : String(actual ?? "stream failed"),
              },
            })}\n\n`,
          )
          safeClose()
        } catch (outerError) {
          if (clientGone) return
          if (blockType) closeBlock()
          send(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: outerError instanceof Error ? outerError.message : String(outerError),
              },
            })}\n\n`,
          )
          safeClose()
        }
      },
      cancel() {
        clientGone = true
        abortController.abort()
      },
    })

    const stream = Stream.fromReadableStream({ evaluate: () => readableStream, onError: (e) => e })
    return HttpServerResponse.stream(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  })
}

function handleNonStream(
  body: z.infer<typeof messagesRequestSchema>,
  modelObj: Model,
  providerID: ProviderV2.ID,
  system: string,
  coreMessages: any[],
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context()
    const run = Effect.runPromiseWith(context) as <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>

    return yield* Effect.promise(async () => {
      try {
        for (;;) {
          const rotation = await run(Provider.use.getRotation(providerID)).catch(() => undefined)
          if (rotation && rotation.total > 0 && rotation.available === 0) {
            return HttpServerResponse.jsonUnsafe(
              { type: "error", error: { type: "api_error", message: "All keys exhausted or on cooldown" } },
              { status: 500 },
            )
          }

          let keyIndex: number | undefined
          const language = await run(
            Provider.use.getLanguage(modelObj, (index: number) => {
              keyIndex = index
            }),
          )

          try {
            const result = await generateText({
              model: language,
              system,
              messages: coreMessages,
              temperature: body.temperature,
              maxOutputTokens: body.max_tokens,
              topP: body.top_p,
              topK: body.top_k,
              stopSequences: body.stop_sequences,
              tools: toAITools(body.tools),
              toolChoice: toAnthropicToolChoice(body.tool_choice),
              maxRetries: 0,
            })

            return HttpServerResponse.jsonUnsafe({
              id: `msg_${crypto.randomUUID()}`,
              type: "message",
              role: "assistant",
              model: body.model,
              content: result.text
                ? [{ type: "text", text: result.text }]
                : result.toolCalls.map((tc) => ({
                    type: "tool_use",
                    id: tc.toolCallId,
                    name: tc.toolName,
                    input: toolInput(tc),
                  })),
              stop_reason: toAnthropicStopReason(result.finishReason),
              stop_sequence: null,
              usage: {
                input_tokens: result.usage.inputTokens,
                output_tokens: result.usage.outputTokens,
              },
            })
          } catch (error) {
            const cls = classifyRouteError(error)
            if (cls && rotation) {
              await run(Provider.use.markRateLimited(providerID, keyIndex, routeCooldownOpts(cls)))
              continue
            }
            return HttpServerResponse.jsonUnsafe(
              {
                type: "error",
                error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
              },
              { status: 500 },
            )
          }
        }
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "api_error", message: "All rotation attempts exhausted" } },
          { status: 500 },
        )
      } catch (error) {
        return HttpServerResponse.jsonUnsafe(
          { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } },
          { status: 500 },
        )
      }
    })
  })
}

export function anthropicRoute(directory: string) {
  return HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("GET", "/api/anthropic/v1/models", () => handleModels(directory))
      yield* router.add(
        "POST",
        "/api/anthropic/v1/messages",
        (request: HttpServerRequest.HttpServerRequest) => handleMessages(directory, request),
      )
      yield* router.add(
        "POST",
        "/api/anthropic/v1/messages/count_tokens",
        (request: HttpServerRequest.HttpServerRequest) => handleCountTokens(directory, request),
      )
    }),
  )
}

export * as Anthropic from "./anthropic"
