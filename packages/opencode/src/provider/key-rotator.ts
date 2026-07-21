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

export type RemoveKeyOpts = { expectedIdentity?: string }
export type MarkRateLimitedOpts = { retryAfterMs?: number; exhausted?: boolean; expectedIdentity?: string }

export interface Interface {
  readonly init: (providerID: string, keys: KeyEntry[], defaultCooldownMs?: number) => void
  readonly getNext: (
    providerID: string,
  ) => Effect.Effect<{ entry: KeyEntry; index: number; identity: string; status: "available" | "cooldown" }>
  readonly markRateLimited: (
    providerID: string,
    index: number,
    opts?: MarkRateLimitedOpts,
  ) => Effect.Effect<void>
  readonly removeKey: (providerID: string, index: number, opts?: RemoveKeyOpts) => Effect.Effect<void>
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
    const poolLock = yield* Semaphore.make(1)

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
                if (index < 0 || index >= pool.keys.length) continue
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

    function resolveEffectiveIndex(pool: Pool, index: number, expectedIdentity?: string): number | undefined {
      if (expectedIdentity) {
        // If index is in bounds and matches, use it
        if (index >= 0 && index < pool.keys.length) {
          try {
            if (keyIdentity(pool.keys[index]) === expectedIdentity) return index
          } catch {}
        }
        // Otherwise search by identity — handles stale index after concurrent removal
        for (let i = 0; i < pool.keys.length; i++) {
          try {
            if (keyIdentity(pool.keys[i]) === expectedIdentity) return i
          } catch {}
        }
        // Not found — already removed by another fiber
        return undefined
      }
      if (index < 0 || index >= pool.keys.length) return undefined
      return index
    }

    return Service.of({
      init(providerID, keys, defaultCooldownMs?) {
        const pool: Pool = { keys: [...keys], current: 0, cooldowns: new Map(), defaultCooldownMs }

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
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) throw new Error(`No key pool for provider: ${providerID}`)
            if (pool.keys.length === 0) throw new Error(`Empty key pool for provider: ${providerID}`)

            const now = yield* Clock.currentTimeMillis

            pool.cooldowns = new Map(
              Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
            )

            const total = pool.keys.length
            // Round-robin scan starting from pool.current to avoid thundering herd
            for (let offset = 0; offset < total; offset++) {
              const idx = (pool.current + offset) % total
              if (!pool.cooldowns.has(idx)) {
                const entry = pool.keys[idx]!
                // Advance current for next caller — defeats thundering herd
                pool.current = (idx + 1) % total
                return {
                  entry,
                  index: idx,
                  identity: keyIdentity(entry),
                  status: "available" as const,
                }
              }
            }

            // All on cooldown — return earliest expiring and advance
            const earliest = Array.from(pool.cooldowns.entries()).reduce((a, b) =>
              a[1].expiry <= b[1].expiry ? a : b,
            )
            const idx = earliest[0]
            pool.current = (idx + 1) % total
            return {
              entry: pool.keys[idx],
              index: idx,
              identity: keyIdentity(pool.keys[idx]),
              status: "cooldown" as const,
            }
          }),
        )
      },

      markRateLimited(providerID, index, opts?) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return
            const effective = resolveEffectiveIndex(pool, index, (opts as any)?.expectedIdentity)
            if (effective === undefined) return

            const now = yield* Clock.currentTimeMillis
            const kind: CooldownKind = opts?.exhausted === true ? "exhausted" : "transient"
            const expiry =
              kind === "exhausted"
                ? getNextMidnightUTC(now)
                : now + (opts?.retryAfterMs ?? pool.defaultCooldownMs ?? 60_000)

            const alreadyCooled = pool.cooldowns.has(effective)
            pool.cooldowns.set(effective, { expiry, kind })

            if (!alreadyCooled) {
              // Advance past cooled key if current points at it
              if (pool.current === effective) {
                const available = pool.keys.map((_, i) => i).filter((i) => !pool.cooldowns.has(i))
                if (available.length > 0) {
                  // Pick next available after effective, round-robin
                  const total = pool.keys.length
                  for (let off = 1; off < total; off++) {
                    const cand = (effective + off) % total
                    if (!pool.cooldowns.has(cand)) {
                      pool.current = cand
                      break
                    }
                  }
                }
              }
            }

            yield* writeCooldownsFile(now)
          }),
        )
      },

      removeKey(providerID, index, opts?) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return
            const effective = resolveEffectiveIndex(pool, index, opts?.expectedIdentity)
            if (effective === undefined) {
              // Already removed by another fiber — idempotent no-op
              return
            }

            pool.keys.splice(effective, 1)

            const newCooldowns = new Map<number, CooldownEntry>()
            for (const [i, cd] of pool.cooldowns.entries()) {
              if (i === effective) continue
              const newIndex = i > effective ? i - 1 : i
              newCooldowns.set(newIndex, cd)
            }
            pool.cooldowns = newCooldowns

            if (pool.keys.length === 0) {
              pool.current = 0
            } else if (pool.current > effective) {
              pool.current--
            } else if (pool.current >= pool.keys.length) {
              pool.current = 0
            }

            const now = yield* Clock.currentTimeMillis
            yield* writeCooldownsFile(now)

            yield* Effect.tryPromise({
              try: async () => {
                const filePath = path.join(Global.Path.data, "providers", providerID, "apiKeys.json")
                await fs.promises.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {})
                await fs.promises.writeFile(filePath, JSON.stringify(pool.keys, null, 2))
              },
              catch: () => undefined,
            }).pipe(Effect.ignore)
          }),
        )
      },

      hasPool(providerID) {
        return pools.has(providerID)
      },

      getPoolSize(providerID) {
        return pools.get(providerID)?.keys.length ?? 0
      },

      hasAvailableKeys(providerID) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return false
            if (pool.keys.length === 0) return false
            const now = yield* Clock.currentTimeMillis
            // Purge expired inside lock for consistent view
            pool.cooldowns = new Map(
              Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
            )
            return pool.keys.some((_, i) => {
              const c = pool.cooldowns.get(i)
              return !c || c.expiry <= now
            })
          }),
        )
      },

      getAvailableCount(providerID) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return 0
            if (pool.keys.length === 0) return 0
            const now = yield* Clock.currentTimeMillis
            pool.cooldowns = new Map(
              Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
            )
            return pool.keys.filter((_, i) => {
              const c = pool.cooldowns.get(i)
              return !c || c.expiry <= now
            }).length
          }),
        )
      },

      getWaitTime(providerID) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return 0
            if (pool.keys.length === 0) return 0
            const now = yield* Clock.currentTimeMillis
            pool.cooldowns = new Map(
              Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
            )
            const available = pool.keys.some((_, i) => {
              const c = pool.cooldowns.get(i)
              return !c || c.expiry <= now
            })
            if (available) return 0
            if (pool.cooldowns.size === 0) return 0
            let earliest = Number.MAX_SAFE_INTEGER
            for (const c of pool.cooldowns.values()) earliest = Math.min(earliest, c.expiry)
            return Math.max(earliest - now, 0)
          }),
        )
      },

      getRotation(providerID) {
        return poolLock.withPermits(1)(
          Effect.gen(function* () {
            const pool = pools.get(providerID)
            if (!pool) return { total: 0, available: 0, waitMs: 0 }
            const now = yield* Clock.currentTimeMillis
            pool.cooldowns = new Map(
              Array.from(pool.cooldowns.entries()).filter(([, c]) => c.expiry > now),
            )
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
          }),
        )
      },
    })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as KeyRotator from "./key-rotator"
