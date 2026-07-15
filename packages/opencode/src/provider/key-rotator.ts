import fs from "fs"
import path from "path"
import crypto from "crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Clock, Semaphore } from "effect"
import { Global } from "@opencode-ai/core/global"

export type KeyEntry = string | { accountId: string; apiKey: string } | { apiKey: string; apiUrl: string }

export type CooldownKind = "transient" | "exhausted"
export type CooldownEntry = { expiry: number; kind: CooldownKind }

type Pool = {
  keys: KeyEntry[]
  current: number
  cooldowns: Map<number, CooldownEntry>
  defaultCooldownMs?: number
}

const STATE_FILE = path.join(Global.Path.state, "key-rotator-cooldowns.json")

type PersistedCooldown = { expiry: number; kind: CooldownKind }
type PersistedPool = Record<string, PersistedCooldown>
type PersistedState = Record<string, PersistedPool>

export function keyIdentity(entry: KeyEntry): string {
  const value = typeof entry === "string" ? entry : entry.apiKey
  return crypto.createHash("sha256").update(value).digest("hex")
}

function readPersistedState(): PersistedState | undefined {
  try {
    const data = fs.readFileSync(STATE_FILE, "utf-8")
    const json = JSON.parse(data)
    if (typeof json !== "object" || json === null) return undefined
    return json as PersistedState
  } catch {
    return undefined
  }
}

function getNextMidnightUTC(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
}

export interface Interface {
  readonly init: (providerID: string, keys: KeyEntry[], defaultCooldownMs?: number) => void
  readonly getNext: (providerID: string) => Effect.Effect<{ entry: KeyEntry; index: number; status: "available" | "cooldown" }>
  readonly markRateLimited: (
    providerID: string,
    index: number,
    opts?: { retryAfterMs?: number; exhausted?: boolean },
  ) => Effect.Effect<void>
  readonly hasPool: (providerID: string) => boolean
  readonly getPoolSize: (providerID: string) => number
  readonly hasAvailableKeys: (providerID: string) => Effect.Effect<boolean>
  readonly getAvailableCount: (providerID: string) => Effect.Effect<number>
  readonly getWaitTime: (providerID: string) => Effect.Effect<number>
  readonly getRotation: (providerID: string) => Effect.Effect<{ total: number; available: number; waitMs: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/KeyRotator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pools = new Map<string, Pool>()
    let persistedCache: PersistedState | undefined | null = null
    const writer = Semaphore.makeUnsafe(1)

    function getPersisted(): PersistedState | undefined {
      if (persistedCache !== null) return persistedCache
      persistedCache = readPersistedState()
      return persistedCache
    }

    function writeCooldownsFile(now: number): Effect.Effect<void> {
      return writer.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const state: PersistedState = {}
            for (const [providerID, pool] of pools.entries()) {
              const active: PersistedPool = {}
              for (const [index, entry] of pool.cooldowns.entries()) {
                if (entry.expiry <= now) continue
                active[keyIdentity(pool.keys[index])] = { expiry: entry.expiry, kind: entry.kind }
              }
              if (Object.keys(active).length > 0) state[providerID] = active
            }
            await fs.promises.mkdir(path.dirname(STATE_FILE), { recursive: true }).catch(() => {})
            await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2))
          },
          catch: () => undefined,
        }).pipe(Effect.ignore),
      )
    }

    return Service.of({
      init(providerID, keys, defaultCooldownMs?) {
        const pool: Pool = { keys, current: 0, cooldowns: new Map(), defaultCooldownMs }

        const persistedState = getPersisted()
        if (persistedState && persistedState[providerID]) {
          const now = Date.now()
          const indexByIdentity = new Map<string, number>()
          for (let i = 0; i < keys.length; i++) indexByIdentity.set(keyIdentity(keys[i]), i)
          for (const [identity, cd] of Object.entries(persistedState[providerID])) {
            if (cd.kind !== "transient" && cd.kind !== "exhausted") continue
            if (cd.expiry <= now) continue
            const index = indexByIdentity.get(identity)
            if (index === undefined) continue
            pool.cooldowns.set(index, { expiry: cd.expiry, kind: cd.kind })
          }
        }

        pools.set(providerID, pool)

        if (persistedState && persistedState[providerID]) {
          const now = Date.now()
          const hasExpired = Object.values(persistedState[providerID]).some((cd: any) => cd.expiry <= now)
          if (hasExpired) {
            Effect.runPromise(writeCooldownsFile(now)).catch(() => {})
          }
        }
      },

      getNext(providerID) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) throw new Error(`No key pool for provider: ${providerID}`)
          if (pool.keys.length === 0) throw new Error(`Empty key pool for provider: ${providerID}`)

          const now = yield* Clock.currentTimeMillis

          pool.cooldowns = new Map(
            Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
          )

          if (!pool.cooldowns.has(pool.current)) {
            return { entry: pool.keys[pool.current], index: pool.current, status: "available" as const }
          }

          const available = pool.keys
            .map((entry, i) => ({ entry, i }))
            .filter(({ i }) => !pool.cooldowns.has(i))

          if (available.length > 0) {
            const best = available.reduce((a, b) => (a.i < b.i ? a : b))
            pool.current = best.i
            return { entry: best.entry, index: best.i, status: "available" as const }
          }

          const earliest = Array.from(pool.cooldowns.entries()).reduce((a, b) => (a[1].expiry <= b[1].expiry ? a : b))
          pool.current = earliest[0]
          return { entry: pool.keys[pool.current], index: pool.current, status: "cooldown" as const }
        })
      },

      markRateLimited(providerID, index, opts?) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) return
          if (index < 0 || index >= pool.keys.length) return

          const now = yield* Clock.currentTimeMillis
          const kind: CooldownKind = opts?.exhausted === true ? "exhausted" : "transient"
          const expiry =
            kind === "exhausted"
              ? getNextMidnightUTC(now)
              : now + (opts?.retryAfterMs ?? pool.defaultCooldownMs ?? 60_000)

          const alreadyCooled = pool.cooldowns.has(index)
          pool.cooldowns.set(index, { expiry, kind })

          if (!alreadyCooled) {
            const available = pool.keys.map((_, i) => i).filter((i) => !pool.cooldowns.has(i))
            if (available.length > 0) pool.current = available.reduce((a, b) => (a < b ? a : b))
          }

          yield* writeCooldownsFile(now)
        })
      },

      hasPool(providerID) {
        return pools.has(providerID)
      },

      getPoolSize(providerID) {
        return pools.get(providerID)?.keys.length ?? 0
      },

      hasAvailableKeys(providerID) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) return false
          if (pool.keys.length === 0) return false
          const now = yield* Clock.currentTimeMillis
          return pool.keys.some((_, i) => {
            const c = pool.cooldowns.get(i)
            return !c || c.expiry <= now
          })
        })
      },

      getAvailableCount(providerID) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) return 0
          if (pool.keys.length === 0) return 0
          const now = yield* Clock.currentTimeMillis
          return pool.keys.filter((_, i) => {
            const c = pool.cooldowns.get(i)
            return !c || c.expiry <= now
          }).length
        })
      },

      getWaitTime(providerID) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) return 0
          if (pool.keys.length === 0) return 0
          const now = yield* Clock.currentTimeMillis
          const available = pool.keys.some((_, i) => {
            const c = pool.cooldowns.get(i)
            return !c || c.expiry <= now
          })
          if (available) return 0
          if (pool.cooldowns.size === 0) return 0
          let earliest = Number.MAX_SAFE_INTEGER
          for (const c of pool.cooldowns.values()) earliest = Math.min(earliest, c.expiry)
          return Math.max(earliest - now, 0)
        })
      },

      getRotation(providerID) {
        return Effect.gen(function* () {
          const pool = pools.get(providerID)
          if (!pool) return { total: 0, available: 0, waitMs: 0 }
          const now = yield* Clock.currentTimeMillis
          const available = pool.keys.filter((_, i) => {
            const c = pool.cooldowns.get(i)
            return !c || c.expiry <= now
          }).length
          let waitMs = 0
          if (available === 0 && pool.cooldowns.size > 0) {
            let earliest = Number.MAX_SAFE_INTEGER
            for (const c of pool.cooldowns.values()) earliest = Math.min(earliest, c.expiry)
            waitMs = Math.max(earliest - now, 0)
          }
          return { total: pool.keys.length, available, waitMs }
        })
      },
    })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as KeyRotator from "./key-rotator"
