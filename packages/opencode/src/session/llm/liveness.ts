import { Cause, Duration, Effect, Queue, Ref } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import { ProviderError } from "@/provider/error"

export const DEFAULTS = { ttftMs: 90_000, contentMs: 60_000 }

export const PROVIDER_DEFAULTS: Record<string, { ttftMs: number; contentMs: number }> = {
  meta: { ttftMs: 120_000, contentMs: 90_000 },
  "cloudflare-workers-ai": { ttftMs: 45_000, contentMs: 45_000 },
  "cloudflare-ai-gateway": { ttftMs: 45_000, contentMs: 45_000 },
  openrouter: { ttftMs: 60_000, contentMs: 60_000 },
  default: DEFAULTS,
}

export function resolveLiveness(
  providerID: string,
  testOverrides?: { ttftMs?: number; contentMs?: number },
) {
  const base = PROVIDER_DEFAULTS[providerID] ?? PROVIDER_DEFAULTS.default
  if (!testOverrides) return base
  return {
    ttftMs: testOverrides.ttftMs ?? base.ttftMs,
    contentMs: testOverrides.contentMs ?? base.contentMs,
  }
}

type LivenessOptsBase = {
  ttftMs: number
  contentMs: number
  providerID: string
  modelID: string
  sessionID: string
  ctrl: AbortController
  getKeyIndex?: () => number | undefined
  keyIndexRef?: Ref.Ref<number | undefined>
}

type LivenessOptsWithStream<E = LLMEvent> = LivenessOptsBase & {
  stream: Stream.Stream<E, any, any>
}

type LivenessOptsWithoutStream = LivenessOptsBase

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError"
}

function extractCauseError(cause: Cause.Cause<unknown>): unknown | undefined {
  const fail = cause.reasons.find(Cause.isFailReason)
  if (fail) return fail.error
  const die = cause.reasons.find(Cause.isDieReason)
  if (die) return die.defect
  return undefined
}

function buildStalledError(
  phase: "ttft" | "content",
  elapsedMs: number,
  timeoutMs: number,
  ctx: { providerID: string; modelID: string; sessionID: string; keyIndex?: number },
) {
  return new ProviderError.StalledStreamError(phase, elapsedMs, timeoutMs, ctx)
}

function makeStream<E>(opts: LivenessOptsWithStream<E>): Stream.Stream<E, unknown, never> {
  const inner = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<E, unknown>()
        const lastMsRef = yield* Ref.make(Date.now())
        const gotFirstRef = yield* Ref.make(false)
        const doneRef = yield* Ref.make(false)
        const stallErrorRef = yield* Ref.make<ProviderError.StalledStreamError | undefined>(undefined)

        const initialKeyIndex = opts.getKeyIndex?.() ?? (opts.keyIndexRef ? yield* Ref.get(opts.keyIndexRef) : undefined)
        yield* Effect.logInfo("liveness armed", {
          providerID: opts.providerID,
          modelID: opts.modelID,
          sessionID: opts.sessionID,
          ttftMs: opts.ttftMs.toString(),
          contentMs: opts.contentMs.toString(),
          keyIndex: initialKeyIndex !== undefined ? initialKeyIndex.toString() : undefined,
        })

        yield* Effect.forkScoped(
          Stream.runForEach(opts.stream, (event) =>
            Effect.gen(function* () {
              const now = Date.now()
              yield* Ref.set(lastMsRef, now)
              const wasFirst = yield* Ref.get(gotFirstRef)
              if (!wasFirst) {
                yield* Ref.set(gotFirstRef, true)
                const ki = opts.getKeyIndex?.() ?? (opts.keyIndexRef ? yield* Ref.get(opts.keyIndexRef) : undefined)
                yield* Effect.logInfo("liveness firstEvent", {
                  providerID: opts.providerID,
                  modelID: opts.modelID,
                  sessionID: opts.sessionID,
                  elapsedMs: "0",
                  keyIndex: ki !== undefined ? ki.toString() : undefined,
                })
              }
              yield* Queue.offer(queue, event)
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Ref.set(doneRef, true)
                const hasInterrupt = cause.reasons.some(Cause.isInterruptReason)
                if (hasInterrupt) {
                  yield* Queue.end(queue)
                  return
                }
                const maybe = extractCauseError(cause)
                if (isAbortError(maybe)) {
                  yield* Queue.end(queue)
                  return
                }
                yield* Queue.failCause(queue, cause)
              }),
            ),
            Effect.tap(() =>
              Effect.gen(function* () {
                yield* Ref.set(doneRef, true)
                yield* Queue.end(queue)
              }),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                const done = yield* Ref.get(doneRef)
                if (!done) {
                  yield* Ref.set(doneRef, true)
                  yield* Queue.end(queue)
                }
              }),
            ),
          ),
        )

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(Duration.millis(200)).pipe(Effect.catchCause(() => Effect.void))
              const done = yield* Ref.get(doneRef)
              if (done) break
              const stallErr = yield* Ref.get(stallErrorRef)
              if (stallErr) break
              if (opts.ctrl.signal.aborted) {
                yield* Queue.shutdown(queue)
                break
              }
              const lastMs = yield* Ref.get(lastMsRef)
              const gotFirst = yield* Ref.get(gotFirstRef)
              const now = Date.now()
              const elapsed = now - lastMs
              const timeout = gotFirst ? opts.contentMs : opts.ttftMs
              if (elapsed > timeout) {
                const stillDone = yield* Ref.get(doneRef)
                if (stillDone) break
                const phase = gotFirst ? ("content" as const) : ("ttft" as const)
                const keyIndex = opts.getKeyIndex?.() ?? (opts.keyIndexRef ? yield* Ref.get(opts.keyIndexRef) : undefined)
                const ctx: { providerID: string; modelID: string; sessionID: string; keyIndex?: number } = {
                  providerID: opts.providerID,
                  modelID: opts.modelID,
                  sessionID: opts.sessionID,
                  ...(keyIndex !== undefined ? { keyIndex } : {}),
                }
                const err = buildStalledError(phase, elapsed, timeout, ctx)
                yield* Effect.logError("liveness fired", {
                  providerID: opts.providerID,
                  modelID: opts.modelID,
                  sessionID: opts.sessionID,
                  phase,
                  elapsedMs: elapsed.toString(),
                  timeoutMs: timeout.toString(),
                  keyIndex: keyIndex !== undefined ? keyIndex.toString() : undefined,
                })
                yield* Ref.set(stallErrorRef, err)
                try {
                  opts.ctrl.abort(err)
                } catch {}
                yield* Ref.set(doneRef, true)
                yield* Queue.fail(queue, err)
                break
              }
            }
          }).pipe(Effect.catchCause(() => Effect.void)),
        )

        return Stream.fromQueue(queue).pipe(
          Stream.ensuring(
            Effect.gen(function* () {
              const done = yield* Ref.get(doneRef)
              if (!done) {
                yield* Ref.set(doneRef, true)
                yield* Queue.end(queue)
              }
            }),
          ),
        )
      }),
    ),
  )
  return inner as unknown as Stream.Stream<E, unknown, never>
}

export function withLivenessEventStream<E>(
  opts: LivenessOptsWithStream<E>,
): Stream.Stream<E, unknown, never>

export function withLivenessEventStream(
  opts: LivenessOptsWithoutStream,
): <E>(stream: Stream.Stream<E, any, any>) => Stream.Stream<E, unknown, never>

export function withLivenessEventStream(
  opts: LivenessOptsWithStream | LivenessOptsWithoutStream,
): any {
  const hasStream = (opts as any).stream !== undefined
  if (hasStream) {
    return makeStream(opts as LivenessOptsWithStream)
  }
  return <E>(stream: Stream.Stream<E, unknown, any>) =>
    makeStream({ ...(opts as LivenessOptsWithoutStream), stream } as LivenessOptsWithStream<E>)
}

export * as LLMLiveness from "./liveness"
