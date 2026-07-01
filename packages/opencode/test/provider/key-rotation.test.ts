import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Service as RotatorService, layer as rotatorLayer, type KeyEntry } from "@/provider/key-rotator"
import { testEffect } from "../lib/effect"

const it = testEffect(rotatorLayer)

describe("Key rotation integration", () => {
  it.live("initializes pool with Cloudflare-style apiKeys config", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      const keys: KeyEntry[] = [
        { accountId: "acc1", apiKey: "key1" },
        { accountId: "acc2", apiKey: "key2" },
        { accountId: "acc3", apiKey: "key3" },
      ]
      svc.init("cloudflare-workers-ai", keys)

      expect(svc.hasPool("cloudflare-workers-ai")).toBe(true)
      expect(svc.getPoolSize("cloudflare-workers-ai")).toBe(3)

      const r1 = yield* svc.getNext("cloudflare-workers-ai")
      expect(r1.entry).toEqual({ accountId: "acc1", apiKey: "key1" })

      const r2 = yield* svc.getNext("cloudflare-workers-ai")
      expect(r2.entry).toEqual({ accountId: "acc1", apiKey: "key1" })
    }),
  )

  it.live("rotates past rate-limited key on 429", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("cloudflare-workers-ai", [
        { accountId: "acc1", apiKey: "key1" },
        { accountId: "acc2", apiKey: "key2" },
        { accountId: "acc3", apiKey: "key3" },
      ])

      const first = yield* svc.getNext("cloudflare-workers-ai")
      yield* svc.markRateLimited("cloudflare-workers-ai", first.index, { retryAfterMs: 86400000 })

      const next = yield* svc.getNext("cloudflare-workers-ai")
      expect(next.entry).toEqual({ accountId: "acc2", apiKey: "key2" })

      const r3 = yield* svc.getNext("cloudflare-workers-ai")
      expect(r3.entry).toEqual({ accountId: "acc2", apiKey: "key2" })
    }),
  )

  it.live("uses cooldownMs from config when no retry-after header", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("test", ["key1", "key2"], 60000)

      const first = yield* svc.getNext("test")
      yield* svc.markRateLimited("test", first.index)

      const next = yield* svc.getNext("test")
      expect(next.entry).toBe("key2")
    }),
  )

  it.live("sticks to same key without rate-limit", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("string-provider", ["alpha", "beta", "gamma"], 30000)

      expect(svc.hasPool("string-provider")).toBe(true)
      expect(svc.getPoolSize("string-provider")).toBe(3)

      const r1 = yield* svc.getNext("string-provider")
      expect(r1.entry).toBe("alpha")

      const r2 = yield* svc.getNext("string-provider")
      expect(r2.entry).toBe("alpha")

      const r3 = yield* svc.getNext("string-provider")
      expect(r3.entry).toBe("alpha")
    }),
  )

  it.live("rate-limited key is skipped after markRateLimited", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("skip-test", [
        { accountId: "a", apiKey: "1" },
        { accountId: "b", apiKey: "2" },
      ], 60000)

      const first = yield* svc.getNext("skip-test")
      yield* svc.markRateLimited("skip-test", first.index, { retryAfterMs: 60000 })

      const r1 = yield* svc.getNext("skip-test")
      expect(r1.entry).toEqual({ accountId: "b", apiKey: "2" })

      const r2 = yield* svc.getNext("skip-test")
      expect(r2.entry).toEqual({ accountId: "b", apiKey: "2" })
    }),
  )

  it.live("throws for unknown provider", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      expect(svc.hasPool("nonexistent")).toBe(false)
      expect(svc.getPoolSize("nonexistent")).toBe(0)

      const result = yield* Effect.exit(svc.getNext("nonexistent"))
      expect(Exit.isFailure(result)).toBe(true)
    }),
  )

  it.live("single key always returns same key", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("single", ["only-key"], 30000)

      const r1 = yield* svc.getNext("single")
      expect(r1.entry).toBe("only-key")

      const r2 = yield* svc.getNext("single")
      expect(r2.entry).toBe("only-key")
    }),
  )

  it.live("multiple independent pools do not interfere", () =>
    Effect.gen(function* () {
      const svc = yield* RotatorService
      svc.init("pool-a", ["a1", "a2"], 30000)
      svc.init("pool-b", ["b1", "b2", "b3"], 30000)

      const a = yield* svc.getNext("pool-a")
      expect(a.entry).toBe("a1")

      const b = yield* svc.getNext("pool-b")
      expect(b.entry).toBe("b1")

      const a2 = yield* svc.getNext("pool-a")
      expect(a2.entry).toBe("a1")

      const b2 = yield* svc.getNext("pool-b")
      expect(b2.entry).toBe("b1")
    }),
  )
})
