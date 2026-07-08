import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Service, layer, keyIdentity } from "@/provider/key-rotator"
import { testEffect } from "../lib/effect"

const stateFilePath = path.join(Global.Path.state, "key-rotator-cooldowns.json")

const it = testEffect(layer)

describe("KeyRotator", () => {
  it.live("sticks to the same key until rate-limited", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("test", ["key1", "key2", "key3"])

      const r1 = yield* svc.getNext("test")
      expect(r1.entry).toBe("key1")
      expect(r1.index).toBe(0)
      expect(r1.status).toBe("available")

      const r2 = yield* svc.getNext("test")
      expect(r2.entry).toBe("key1")
      expect(r2.index).toBe(0)

      const r3 = yield* svc.getNext("test")
      expect(r3.entry).toBe("key1")
      expect(r3.index).toBe(0)
    }),
  )

  it.live("works with tuple keys (Cloudflare-style)", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("cf", [
        { accountId: "acc1", apiKey: "key1" },
        { accountId: "acc2", apiKey: "key2" },
      ])

      const r1 = yield* svc.getNext("cf")
      expect(r1.entry).toEqual({ accountId: "acc1", apiKey: "key1" })
      expect(r1.index).toBe(0)

      const r2 = yield* svc.getNext("cf")
      expect(r2.entry).toEqual({ accountId: "acc1", apiKey: "key1" })
      expect(r2.index).toBe(0)
    }),
  )

  it.live("markRateLimited moves to next key", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("mark-test", ["key1", "key2", "key3"], 60000)

      const first = yield* svc.getNext("mark-test")
      yield* svc.markRateLimited("mark-test", first.index)

      const r = yield* svc.getNext("mark-test")
      expect(r.entry).toBe("key2")
      expect(r.index).toBe(1)
    }),
  )

  it.live("skips keys that are on cooldown", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("skip-test", ["key1", "key2", "key3"], 60000)

      const a = yield* svc.getNext("skip-test")
      yield* svc.markRateLimited("skip-test", a.index)
      const b = yield* svc.getNext("skip-test")
      yield* svc.markRateLimited("skip-test", b.index)

      const r = yield* svc.getNext("skip-test")
      expect(r.entry).toBe("key3")
      expect(r.index).toBe(2)
    }),
  )

  it.live("markRateLimited on an already-cooled key does not cool another key (dedup)", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("dedup-test", ["key1", "key2", "key3"], 60000)

      const a = yield* svc.getNext("dedup-test")
      yield* svc.markRateLimited("dedup-test", a.index)
      yield* svc.markRateLimited("dedup-test", a.index)

      const r = yield* svc.getNext("dedup-test")
      expect(r.entry).toBe("key2")
      expect(r.index).toBe(1)
      expect(r.status).toBe("available")
    }),
  )

  it.live("exhausted keys are permanently cooled for the session", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("exhaust-test", ["key1", "key2"], 60000)

      const a = yield* svc.getNext("exhaust-test")
      yield* svc.markRateLimited("exhaust-test", a.index, { exhausted: true })

      yield* Effect.sleep(10)
      const r1 = yield* svc.getNext("exhaust-test")
      expect(r1.entry).toBe("key2")

      const r2 = yield* svc.getNext("exhaust-test")
      expect(r2.entry).toBe("key2")
    }),
  )

  it.live("single key always returns the same key", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("test", ["only-key"])

      const r1 = yield* svc.getNext("test")
      expect(r1.entry).toBe("only-key")
      expect(r1.index).toBe(0)

      const r2 = yield* svc.getNext("test")
      expect(r2.entry).toBe("only-key")
      expect(r2.index).toBe(0)

      const r3 = yield* svc.getNext("test")
      expect(r3.entry).toBe("only-key")
      expect(r3.index).toBe(0)
    }),
  )

  it.live("hasPool returns false for unknown, true for initialized", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      expect(svc.hasPool("unknown")).toBe(false)
      svc.init("test", ["key1"])
      expect(svc.hasPool("test")).toBe(true)
    }),
  )

  it.live("getPoolSize returns 0 for unknown, correct count for initialized", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      expect(svc.getPoolSize("unknown")).toBe(0)
      svc.init("test", ["key1", "key2", "key3"])
      expect(svc.getPoolSize("test")).toBe(3)
    }),
  )

  it.live("returns soonest-expiring key with cooldown status when all on cooldown", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("soonest-test", ["key1", "key2"], 60000)

      const a = yield* svc.getNext("soonest-test")
      yield* svc.markRateLimited("soonest-test", a.index, { retryAfterMs: 200 })
      const b = yield* svc.getNext("soonest-test")
      yield* svc.markRateLimited("soonest-test", b.index, { retryAfterMs: 60000 })

      const r = yield* svc.getNext("soonest-test")
      expect(r.entry).toBe("key1")
      expect(r.index).toBe(0)
      expect(r.status).toBe("cooldown")
    }),
  )

  it.live("key re-enters pool after cooldown expires", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("reenter-test", ["key1", "key2"], 100)

      const a = yield* svc.getNext("reenter-test")
      yield* svc.markRateLimited("reenter-test", a.index)

      const r1 = yield* svc.getNext("reenter-test")
      expect(r1.entry).toBe("key2")

      yield* svc.markRateLimited("reenter-test", r1.index)

      yield* Effect.sleep(150)

      const r2 = yield* svc.getNext("reenter-test")
      expect(r2.entry).toBe("key2")
      expect(r2.index).toBe(1)
    }),
  )

  it.live("restores persisted cooldowns on init", () =>
    Effect.gen(function* () {
      const providerID = `restore-${Math.random().toString(36).slice(2)}`
      const idKey = keyIdentity("key1")

      yield* Effect.promise(async () => {
        await fs.mkdir(Global.Path.state, { recursive: true })
        await Bun.write(
          stateFilePath,
          JSON.stringify({ [providerID]: { [idKey]: { expiry: Date.now() + 60000, kind: "transient" } } }),
        )
      })

      const svc = yield* Service
      svc.init(providerID, ["key1", "key2", "key3"], 60000)

      const r = yield* svc.getNext(providerID)
      expect(r.entry).toBe("key2")
      expect(r.index).toBe(1)
    }),
  )

  it.live("drops persisted cooldowns whose key no longer exists (identity-validated)", () =>
    Effect.gen(function* () {
      const providerID = `removed-${Math.random().toString(36).slice(2)}`
      const idKey = keyIdentity("ghost")

      yield* Effect.promise(async () => {
        await fs.mkdir(Global.Path.state, { recursive: true })
        await Bun.write(
          stateFilePath,
          JSON.stringify({ [providerID]: { [idKey]: { expiry: Date.now() + 60000, kind: "transient" } } }),
        )
      })

      const svc = yield* Service
      svc.init(providerID, ["key1", "key2"], 60000)

      const r = yield* svc.getNext(providerID)
      expect(r.entry).toBe("key1")
      expect(r.index).toBe(0)
    }),
  )

  it.live("ignores expired cooldowns from file", () =>
    Effect.gen(function* () {
      const providerID = `expired-${Math.random().toString(36).slice(2)}`
      const idKey = keyIdentity("key1")

      yield* Effect.promise(async () => {
        await fs.mkdir(Global.Path.state, { recursive: true })
        await Bun.write(
          stateFilePath,
          JSON.stringify({ [providerID]: { [idKey]: { expiry: Date.now() - 1000, kind: "transient" } } }),
        )
      })

      const svc = yield* Service
      svc.init(providerID, ["key1", "key2"], 60000)

      const r = yield* svc.getNext(providerID)
      expect(r.entry).toBe("key1")
      expect(r.index).toBe(0)
    }),
  )

  it.live("persists new cooldowns to file", () =>
    Effect.gen(function* () {
      const providerID = `write-${Math.random().toString(36).slice(2)}`

      yield* Effect.promise(async () => {
        await fs.mkdir(Global.Path.state, { recursive: true })
        await fs.rm(stateFilePath, { force: true })
      })

      const svc = yield* Service
      svc.init(providerID, ["key1", "key2"], 60000)

      const a = yield* svc.getNext(providerID)
      yield* svc.markRateLimited(providerID, a.index)

      const file = Bun.file(stateFilePath)
      const exists = yield* Effect.promise(() => file.exists())
      expect(exists).toBe(true)

      const json = yield* Effect.promise(() => file.json())
      expect(json[providerID]).toBeDefined()
      const idKey = keyIdentity("key1")
      expect(json[providerID][idKey]).toBeDefined()
      expect(json[providerID][idKey].expiry).toBeGreaterThan(Date.now())
      expect(json[providerID][idKey].kind).toBe("transient")
    }),
  )

  it.live("cools down to next UTC midnight when no defaultCooldownMs is set", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("utc-test", ["key1", "key2"])

      const a = yield* svc.getNext("utc-test")
      yield* svc.markRateLimited("utc-test", a.index)

      const now = Date.now()
      const expectedMidnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
        0, 0, 0, 0,
      )

      const file = Bun.file(stateFilePath)
      const exists = yield* Effect.promise(() => file.exists())
      expect(exists).toBe(true)

      const json = yield* Effect.promise(() => file.json())
      const expiry = json["utc-test"][keyIdentity("key1")].expiry
      expect(expiry).toBe(expectedMidnight)
    }),
  )

  it.live("getAvailableCount returns 0 for unknown provider", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      const count = yield* svc.getAvailableCount("unknown")
      expect(count).toBe(0)
    }),
  )

  it.live("getAvailableCount returns 0 for empty pool", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("empty-pool", [])
      const count = yield* svc.getAvailableCount("empty-pool")
      expect(count).toBe(0)
    }),
  )

  it.live("getAvailableCount returns pool size when all keys are available", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("all-available", ["key1", "key2", "key3"])
      const count = yield* svc.getAvailableCount("all-available")
      expect(count).toBe(3)
    }),
  )

  it.live("getAvailableCount returns partial count when some keys are rate-limited", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("partial", ["key1", "key2", "key3"], 60000)

      const a = yield* svc.getNext("partial")
      yield* svc.markRateLimited("partial", a.index)

      const count = yield* svc.getAvailableCount("partial")
      expect(count).toBe(2)
    }),
  )

  it.live("getAvailableCount returns 0 when all keys are on cooldown", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("all-cooldown", ["key1", "key2"], 60000)

      const a = yield* svc.getNext("all-cooldown")
      yield* svc.markRateLimited("all-cooldown", a.index)
      const b = yield* svc.getNext("all-cooldown")
      yield* svc.markRateLimited("all-cooldown", b.index)

      const count = yield* svc.getAvailableCount("all-cooldown")
      expect(count).toBe(0)
    }),
  )

  it.live("getWaitTime returns 0 when pool has no cooldowns (empty-reduce guard)", () =>
    Effect.gen(function* () {
      const svc = yield* Service
      svc.init("wait-empty", ["key1", "key2"])
      const wait = yield* svc.getWaitTime("wait-empty")
      expect(wait).toBe(0)
    }),
  )
})
