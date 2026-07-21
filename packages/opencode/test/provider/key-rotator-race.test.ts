import { describe, expect, test, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyRotator } from "@/provider/key-rotator"

const PROVIDER = "test-provider"

function makeLayer() {
  return KeyRotator.layer
}

function run<E, A>(effect: Effect.Effect<A, E, KeyRotator.Service>, layer = makeLayer()): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe("key-rotator race conditions", () => {
  test("parallel getNext round-robin distributes keys (no thundering herd)", async () => {
    const layer = makeLayer()
    const effect = Effect.gen(function* () {
      const rotator = yield* KeyRotator.Service
      rotator.init(PROVIDER, ["k0", "k1", "k2", "k3", "k4", "k5"])

      // 6 parallel getNext should give 6 distinct indices due to round-robin
      const results = yield* Effect.all(
        Array.from({ length: 6 }, () => rotator.getNext(PROVIDER)),
        { concurrency: "unbounded" },
      )

      const indices = results.map((r) => r.index).sort((a, b) => a - b)
      // All 6 should be distinct
      expect(new Set(indices).size).toBe(6)
      expect(indices).toEqual([0, 1, 2, 3, 4, 5])

      // Identities should also be distinct
      const identities = results.map((r) => r.identity)
      expect(new Set(identities).size).toBe(6)
    })

    await run(effect, layer)
  })

  test("billing error race: 3 parallel agents with same bad key remove only 1 key", async () => {
    const layer = makeLayer()
    const effect = Effect.gen(function* () {
      const rotator = yield* KeyRotator.Service
      const keys = ["BAD_KEY", "good1", "good2", "good3", "good4", "good5"]
      rotator.init(PROVIDER, keys)

      // Simulate old thundering-herd scenario: 3 fibers all captured index 0 + identity of BAD_KEY
      // They all hit billing error at same time and call removeKey concurrently
      const first = yield* rotator.getNext(PROVIDER)
      expect(first.index).toBe(0)
      const badIdentity = first.identity

      // 3 parallel removals with same identity
      yield* Effect.all(
        [
          rotator.removeKey(PROVIDER, 0, { expectedIdentity: badIdentity }),
          rotator.removeKey(PROVIDER, 0, { expectedIdentity: badIdentity }),
          rotator.removeKey(PROVIDER, 0, { expectedIdentity: badIdentity }),
        ],
        { concurrency: "unbounded" },
      )

      // Only 1 key should be removed
      const size = rotator.getPoolSize(PROVIDER)
      expect(size).toBe(5)

      // Pool should NOT contain BAD_KEY, should contain all good keys
      // Verify by draining pool
      const remaining: string[] = []
      for (let i = 0; i < 5; i++) {
        const r = yield* rotator.getNext(PROVIDER)
        remaining.push(r.entry as string)
      }
      expect(remaining).not.toContain("BAD_KEY")
      expect(remaining.sort()).toEqual(["good1", "good2", "good3", "good4", "good5"].sort())

      console.log("PASS: 3 parallel removals of same key -> only 1 removed, pool size:", size)
    })

    await run(effect, layer)
  })

  test("stale index after concurrent removal does not delete innocent key", async () => {
    const layer = makeLayer()
    const effect = Effect.gen(function* () {
      const rotator = yield* KeyRotator.Service
      rotator.init(PROVIDER, ["K0", "K1", "K2"])

      // Get identities
      const r0 = yield* rotator.getNext(PROVIDER) // K0, advances to 1
      const r1 = yield* rotator.getNext(PROVIDER) // K1, advances to 2
      // Reset current to 0 for test: we want to test stale index mapping
      // r0.index=0 identity=K0, r1.index=1 identity=K1

      // Simulate: K0 is bad, K1 is bad, but they get removed concurrently
      // Old buggy code: splice(0) then splice(1) would delete K0 and K2 (K1 shifts to 0, K2 to 1)
      // Fixed code: should delete K0 and K1, leaving K2
      yield* Effect.all(
        [
          rotator.removeKey(PROVIDER, r0.index, { expectedIdentity: r0.identity }),
          rotator.removeKey(PROVIDER, r1.index, { expectedIdentity: r1.identity }),
        ],
        { concurrency: "unbounded" },
      )

      const size = rotator.getPoolSize(PROVIDER)
      expect(size).toBe(1)

      const remaining = yield* rotator.getNext(PROVIDER)
      expect(remaining.entry).toBe("K2")
      console.log("PASS: stale index test -> only targeted keys removed, remaining:", remaining.entry)
    })

    await run(effect, layer)
  })

  test("removeKey idempotent when key already removed", async () => {
    const layer = makeLayer()
    const effect = Effect.gen(function* () {
      const rotator = yield* KeyRotator.Service
      rotator.init(PROVIDER, ["K0", "K1"])

      const r = yield* rotator.getNext(PROVIDER)
      yield* rotator.removeKey(PROVIDER, r.index, { expectedIdentity: r.identity })
      expect(rotator.getPoolSize(PROVIDER)).toBe(1)

      // Second removal with same identity should be no-op, not crash or remove innocent
      yield* rotator.removeKey(PROVIDER, r.index, { expectedIdentity: r.identity })
      expect(rotator.getPoolSize(PROVIDER)).toBe(1)

      console.log("PASS: idempotent removal")
    })

    await run(effect, layer)
  })

  test("6 parallel agents all hitting billing error on same key -> only 1 removed", async () => {
    const layer = makeLayer()
    const effect = Effect.gen(function* () {
      const rotator = yield* KeyRotator.Service
      rotator.init(PROVIDER, ["BAD", "g1", "g2", "g3", "g4", "g5"])

      const first = yield* rotator.getNext(PROVIDER)
      const badId = first.identity

      // Simulate 6 agents all holding index 0 due to old thundering herd (worst case)
      // Even with new round-robin, test the worst case: 6 parallel identical removals
      yield* Effect.all(
        Array.from({ length: 6 }, () => rotator.removeKey(PROVIDER, 0, { expectedIdentity: badId })),
        { concurrency: "unbounded" },
      )

      expect(rotator.getPoolSize(PROVIDER)).toBe(5)
      console.log("PASS: 6 agents same bad key -> only 1 removed")
    })

    await run(effect, layer)
  })
})
