import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(LayerNode.compile(LayerNode.group([SessionStatus.node, CrossSpawnSpawner.node])))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.constants", () => {
  test("fixed delay is 500ms", () => {
    expect(SessionRetry.RETRY_FIXED_DELAY).toBe(500)
  })

  test("max retries is 3", () => {
    expect(SessionRetry.MAX_RETRIES).toBe(3)
  })

  test("rate-limit max retries is 20 (keep rotating across keys)", () => {
    expect(SessionRetry.MAX_RETRIES_RATE_LIMIT).toBe(20)
  })

  test("rotate cooldown is 60s", () => {
    expect(SessionRetry.ROTATE_COOLDOWN_MS).toBe(60_000)
  })

  test("rotate delay floor is 50ms", () => {
    expect(SessionRetry.ROTATE_DELAY_FLOOR_MS).toBe(50)
  })
})

describe("session.retry.policy", () => {
  it.instance("updates retry status and increments attempts for non-rate-limit errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  test("rate-limit fires onRateLimited and marks the decision isRateLimit when keys can rotate", async () => {
    let onRateLimitedCalls = 0
    let setInfo: { isRateLimit: boolean; message: string } | undefined
    const step = await Effect.runPromise(
      Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: (e) => e as SessionV1.APIError,
          set: (info) => Effect.sync(() => (setInfo = info)),
          onRateLimited: () => Effect.sync(() => onRateLimitedCalls++),
          canRotateKey: () => Effect.succeed(true),
        }),
      ),
    )
    const rateLimited = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Too many requests", isRetryable: true, statusCode: 429 }).toObject(),
    )
    await Effect.runPromise(step(rateLimited))
    // The policy reports a rate-limit decision and cools the failed key; the processor is what
    // suppresses the TUI status while other keys remain available.
    expect(onRateLimitedCalls).toBe(1)
    expect(setInfo?.isRateLimit).toBe(true)
    expect(setInfo?.message).toBe("Too many requests")
  })

  test("'used up your' is treated as permanent exhaustion and fires onKeyExhausted", async () => {
    let onKeyExhaustedCalls = 0
    let onRateLimitedCalls = 0
    const step = await Effect.runPromise(
      Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: (e) => e as SessionV1.APIError,
          set: () => Effect.void,
          onRateLimited: () => Effect.sync(() => onRateLimitedCalls++),
          onKeyExhausted: () => Effect.sync(() => onKeyExhaustedCalls++),
          canRotateKey: () => Effect.succeed(true),
        }),
      ),
    )
    const exhausted = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: 'Too Many Requests: {"errors":[{"message":"you have used up your daily allotment"}]}',
        isRetryable: false,
        statusCode: 429,
      }).toObject(),
    )
    await Effect.runPromise(step(exhausted))
    expect(onKeyExhaustedCalls).toBe(1)
    expect(onRateLimitedCalls).toBe(0)
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests", isRateLimit: true })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "Provider is overloaded",
      isRateLimit: false,
    })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg, isRateLimit: true })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg, isRateLimit: true })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg, isRateLimit: true })
  })

  test("marks 'used up your' as permanent exhaustion (not transient rate limit)", () => {
    const msg = 'Too Many Requests: {"errors":[{"message":"AiError: you have used up your daily token allotment"}]}'
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: msg,
      isRateLimit: false,
      isExhaustion: true,
    })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
      isRateLimit: false,
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
      isRateLimit: false,
    })
  })

  test("retries 'stream ended without finish' plain error (dropped-stream adapter signal)", () => {
    const error = wrap("stream ended without finish")
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "stream ended without finish",
      isRateLimit: false,
    })
  })

  test("retries 'stream ended without content' plain error (silent-stop adapter signal)", () => {
    const error = wrap("stream ended without content")
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "stream ended without content",
      isRateLimit: false,
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error", isRateLimit: false })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway", isRateLimit: false })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable", isRateLimit: false })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed", isRateLimit: false })
  })

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      isRateLimit: false,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
        label: "subscribe",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")).toEqual({
      message:
        "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      isRateLimit: false,
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
        message:
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        label: "open settings",
        link: "https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("detects Cloudflare Workers AI auth error (code 10000) in APIError responseBody", () => {
    const responseBody = JSON.stringify({
      result: null,
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
      messages: [],
    })
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Unauthorized",
        isRetryable: false,
        statusCode: 401,
        responseBody,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "Cloudflare authentication error — rotating key",
      isRateLimit: true,
    })
  })

  test("detects Cloudflare auth error (code 10000) in plain JSON message", () => {
    const error = wrap(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "Cloudflare authentication error — rotating key",
      isRateLimit: true,
    })
  })

  test("detects Cloudflare auth error with code 10000 in errors array", () => {
    const error = wrap(
      JSON.stringify({
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: "Cloudflare authentication error — rotating key",
      isRateLimit: true,
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")?.action?.message).toBe(
      "Usage limit reached. It will reset in 15 minutes. To continue using this model now, enable usage from your available balance",
    )
  })
})

describe("session.retry.rotate-trigger", () => {
  // isRotateTrigger is module-private, so we verify through the policy: when canRotateKey
  // returns true and the error is a rotate trigger, treatAsRateLimit becomes true — which
  // fires onRateLimited and sets isRateLimit on the status info.
  async function stepFor(
    error: SessionRetry.Err,
    canRotate: boolean,
  ): Promise<{ onRateLimitedCalls: number; onKeyExhaustedCalls: number; isRateLimit: boolean | undefined }> {
    let onRateLimitedCalls = 0
    let onKeyExhaustedCalls = 0
    let isRateLimit: boolean | undefined
    const step = await Effect.runPromise(
      Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: (e) => e as SessionRetry.Err,
          set: (info) => Effect.sync(() => (isRateLimit = info.isRateLimit)),
          onRateLimited: () => Effect.sync(() => onRateLimitedCalls++),
          onKeyExhausted: () => Effect.sync(() => onKeyExhaustedCalls++),
          canRotateKey: () => Effect.succeed(canRotate),
        }),
      ),
    )
    await Effect.runPromise(step(error))
    return { onRateLimitedCalls, onKeyExhaustedCalls, isRateLimit }
  }

  test("'stream ended without finish' triggers key rotation", async () => {
    const result = await stepFor(wrap("stream ended without finish"), true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })

  test("'stream ended without content' triggers key rotation", async () => {
    const result = await stepFor(wrap("stream ended without content"), true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })

  test("SSE read timeout triggers key rotation", async () => {
    const error = MessageV2.fromError(new ProviderError.ResponseStreamError("sse read timed out"), { providerID })
    expect(SessionV1.APIError.isInstance(error)).toBe(true)
    const result = await stepFor(error, true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })

  test("response headers timeout triggers key rotation", async () => {
    const error = MessageV2.fromError(new ProviderError.HeaderTimeoutError(120_000), { providerID })
    expect(SessionV1.APIError.isInstance(error)).toBe(true)
    const result = await stepFor(error, true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })

  test("rotate-trigger errors do NOT rotate when canRotateKey is false", async () => {
    const result = await stepFor(wrap("stream ended without finish"), false)
    expect(result.onRateLimitedCalls).toBe(0)
    expect(result.isRateLimit).toBe(false)
  })

  test("Cloudflare auth error (code 10000) triggers key rotation", async () => {
    const error = wrap(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
    )
    const result = await stepFor(error, true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })

  test("Cloudflare auth error in APIError responseBody triggers key rotation", async () => {
    const responseBody = JSON.stringify({
      result: null,
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
      messages: [],
    })
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Unauthorized",
        isRetryable: false,
        statusCode: 401,
        responseBody,
      }).toObject(),
    )
    const result = await stepFor(error, true)
    expect(result.onRateLimitedCalls).toBe(1)
    expect(result.onKeyExhaustedCalls).toBe(0)
    expect(result.isRateLimit).toBe(true)
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server", isRateLimit: false })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
      isRateLimit: false,
    })
  })
})
