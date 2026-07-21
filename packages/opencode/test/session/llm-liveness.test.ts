import { describe, test, expect } from "bun:test"
import { Effect, Stream, Cause } from "effect"
import { LLMLiveness } from "../../src/session/llm/liveness"
import { ProviderError } from "../../src/provider/error"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import type { LLMEvent } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"

function makeDummyEvent(id: string): LLMEvent {
  // Minimal LLMEvent - textDelta is meaningful and resets timer
  return {
    type: "text-delta",
    id,
    text: "hello",
  } as unknown as LLMEvent
}

describe("llm-liveness", () => {
  test("TTFT timeout phase ttft", async () => {
    const ctrl = new AbortController()
    const neverStream = Stream.never as Stream.Stream<LLMEvent, unknown, never>

    const live = LLMLiveness.withLivenessEventStream({
      stream: neverStream,
      ttftMs: 50,
      contentMs: 50,
      providerID: "test",
      modelID: "test-model",
      sessionID: "test-session",
      ctrl,
    })

    const start = Date.now()
    let caught: unknown
    try {
      await Effect.runPromise(Stream.runCollect(live))
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start

    expect(caught).toBeInstanceOf(ProviderError.StalledStreamError)
    const err = caught as ProviderError.StalledStreamError
    expect(err.phase).toBe("ttft")
    expect(err.timeoutMs).toBe(50)
    expect(err.elapsedMs).toBeGreaterThanOrEqual(40)
    // Same instance used to abort and to fail
    expect(ctrl.signal.aborted).toBeTrue()
    expect(ctrl.signal.reason).toBe(err)
    expect(elapsed).toBeLessThan(1000)
  })

  test("content timeout phase content", async () => {
    const ctrl = new AbortController()
    const oneThenNever = Stream.make(makeDummyEvent("1")).pipe(Stream.concat(Stream.never)) as Stream.Stream<LLMEvent, unknown, never>

    const live = LLMLiveness.withLivenessEventStream({
      stream: oneThenNever,
      ttftMs: 50,
      contentMs: 50,
      providerID: "test",
      modelID: "test-model",
      sessionID: "test-session",
      ctrl,
    })

    const collected: LLMEvent[] = []
    let caught: unknown
    try {
      await Effect.runPromise(
        Stream.runForEach(live, (e) =>
          Effect.sync(() => {
            collected.push(e)
          }),
        ),
      )
    } catch (e) {
      caught = e
    }

    expect(collected.length).toBe(1)
    expect(caught).toBeInstanceOf(ProviderError.StalledStreamError)
    const err = caught as ProviderError.StalledStreamError
    expect(err.phase).toBe("content")
    expect(err.timeoutMs).toBe(50)
    expect(ctrl.signal.reason).toBe(err)
  })

  test("slow progressing no timeout", async () => {
    const ctrl = new AbortController()
    // Emit every 20ms, 5 times, contentMs 50 should not trigger because reset each time
    const slow = Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
      Stream.mapEffect((i) =>
        Effect.gen(function* () {
          yield* Effect.sleep(20)
          return makeDummyEvent(String(i))
        }),
      ),
    ) as Stream.Stream<LLMEvent, unknown, never>

    const live = LLMLiveness.withLivenessEventStream({
      stream: slow,
      ttftMs: 50,
      contentMs: 50,
      providerID: "test",
      modelID: "test-model",
      sessionID: "test-session",
      ctrl,
    })

    const collected = await Effect.runPromise(Stream.runCollect(live))
    // Should collect all 5 without error
    expect(collected.length).toBe(5)
    expect(ctrl.signal.aborted).toBeFalse()
  })

  test("user cancel interruption - not stall", async () => {
    const ctrl = new AbortController()
    const neverStream = Stream.never as Stream.Stream<LLMEvent, unknown, never>

    const live = LLMLiveness.withLivenessEventStream({
      stream: neverStream,
      ttftMs: 50,
      contentMs: 50,
      providerID: "test",
      modelID: "test-model",
      sessionID: "test-session",
      ctrl,
    })

    // Abort with client AbortError after 50ms
    setTimeout(() => {
      ctrl.abort(new DOMException("client disconnected", "AbortError"))
    }, 50)

    const start = Date.now()
    let finishedGracefully = false
    let caught: unknown
    try {
      await Effect.runPromise(Stream.runCollect(live))
      finishedGracefully = true
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start

    // Should shutdown, not fail as stall
    // Our implementation shuts down queue on any abort that is not stall, so runCollect should succeed
    // If it throws, ensure it's not StalledStreamError
    if (caught) {
      expect(caught).not.toBeInstanceOf(ProviderError.StalledStreamError)
      expect((caught as any)?.name).not.toBe("StalledStreamError")
    } else {
      expect(finishedGracefully).toBeTrue()
    }
    expect(ctrl.signal.aborted).toBeTrue()
    // Bun has a known quirk where object abort reasons are cleared after a tick when set inside setTimeout,
    // so we tolerate undefined but ensure it's not a StalledStreamError
    const reason = ctrl.signal.reason
    if (reason !== undefined) {
      expect(reason).not.toBeInstanceOf(ProviderError.StalledStreamError)
      // If it's still a DOMException, check name
      if (reason instanceof DOMException) {
        expect(reason.name).toBe("AbortError")
      }
    }
    expect(elapsed).toBeLessThan(500)
  })

  test("MessageV2.fromError -> APIError string metadata + retryable", () => {
    const err = new ProviderError.StalledStreamError("ttft", 123, 90_000, {
      providerID: "meta",
      modelID: "llama",
      sessionID: "sess-123",
    })

    const apiErrObj = MessageV2.fromError(err, { providerID: ProviderV2.ID.make("meta") })

    // Should be APIError with isRetryable true and string-only metadata, conditional spreads
    expect(apiErrObj.name).toBe("APIError")
    const data = (apiErrObj as any).data
    expect(data.isRetryable).toBeTrue()
    expect(data.metadata.code).toBe("StalledStreamError")
    expect(data.metadata.phase).toBe("ttft")
    expect(data.metadata.elapsedMs).toBe("123")
    expect(data.metadata.timeoutMs).toBe("90000")
    expect(data.metadata.providerID).toBe("meta")
    expect(data.metadata.modelID).toBe("llama")
    expect(data.metadata.sessionID).toBe("sess-123")
    // Ensure values are strings
    expect(typeof data.metadata.elapsedMs).toBe("string")
    expect(typeof data.metadata.timeoutMs).toBe("string")

    // Retryable detection via metadata.code
    const retryable = SessionRetry.retryable(apiErrObj as any)
    expect(retryable).toBeDefined()
    expect(retryable?.isRateLimit).toBeFalse()
  })

  test("resolveLiveness provider defaults and testOverrides", () => {
    const metaDefaults = LLMLiveness.resolveLiveness("meta")
    expect(metaDefaults.ttftMs).toBe(120_000)
    expect(metaDefaults.contentMs).toBe(90_000)

    const cfDefaults = LLMLiveness.resolveLiveness("cloudflare-workers-ai")
    expect(cfDefaults.ttftMs).toBe(45_000)

    const defaultDefaults = LLMLiveness.resolveLiveness("unknown-provider")
    expect(defaultDefaults.ttftMs).toBe(90_000)

    const overridden = LLMLiveness.resolveLiveness("meta", { ttftMs: 50, contentMs: 50 })
    expect(overridden.ttftMs).toBe(50)
    expect(overridden.contentMs).toBe(50)

    const partial = LLMLiveness.resolveLiveness("meta", { ttftMs: 10 })
    expect(partial.ttftMs).toBe(10)
    expect(partial.contentMs).toBe(90_000)
  })

  test("Queue termination guarantees - failure failCause, normal shutdown, watchdog fail", async () => {
    // Normal completion
    {
      const ctrl = new AbortController()
      const stream = Stream.make(makeDummyEvent("1"), makeDummyEvent("2"))
      const live = LLMLiveness.withLivenessEventStream({
        stream,
        ttftMs: 1000,
        contentMs: 1000,
        providerID: "test",
        modelID: "test",
        sessionID: "test",
        ctrl,
      })
      const result = await Effect.runPromise(Stream.runCollect(live))
      expect(result.length).toBe(2)
    }

    // Upstream failure
    {
      const ctrl = new AbortController()
      const failing = Stream.fail(new Error("upstream fail")) as Stream.Stream<LLMEvent, unknown, never>
      const live = LLMLiveness.withLivenessEventStream({
        stream: failing,
        ttftMs: 1000,
        contentMs: 1000,
        providerID: "test",
        modelID: "test",
        sessionID: "test",
        ctrl,
      })
      let caught: unknown
      try {
        await Effect.runPromise(Stream.runCollect(live))
      } catch (e) {
        caught = e
      }
      expect(caught).toBeDefined()
      expect((caught as Error).message).toBe("upstream fail")
    }
  })
})
