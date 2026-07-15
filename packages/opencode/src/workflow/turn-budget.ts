export type Limit = { total: number; committed: number; reserved: number }

export type Pool = {
  id: string
  usd?: Limit
  tokens?: Limit
  avgStepUsd: number
  steps: number
}

export type Reservation = { usd: number }

let counter = 0

export function make(input: { usd?: number; tokens?: number }): Pool {
  counter += 1
  return {
    id: `turnpool_${counter}`,
    usd: input.usd !== undefined ? { total: input.usd, committed: 0, reserved: 0 } : undefined,
    tokens: input.tokens !== undefined ? { total: input.tokens, committed: 0, reserved: 0 } : undefined,
    avgStepUsd: 0,
    steps: 0,
  }
}

export function reserve(pool: Pool, estimateUsd: number): Reservation | undefined {
  if (pool.usd !== undefined && pool.usd.committed + pool.usd.reserved >= pool.usd.total) return undefined
  if (pool.tokens !== undefined && pool.tokens.committed + pool.tokens.reserved >= pool.tokens.total)
    return undefined
  const usd = Math.max(0, estimateUsd)
  if (pool.usd !== undefined) pool.usd.reserved += usd
  return { usd }
}

export function settle(pool: Pool, reservation: Reservation, actual: { usd: number; tokens?: number }): void {
  if (pool.usd !== undefined) {
    pool.usd.reserved = Math.max(0, pool.usd.reserved - reservation.usd)
    pool.usd.committed += actual.usd
  }
  if (pool.tokens !== undefined && actual.tokens !== undefined) pool.tokens.committed += actual.tokens
  pool.steps += 1
  pool.avgStepUsd = pool.avgStepUsd + (actual.usd - pool.avgStepUsd) / pool.steps
}

export function chargeDirect(pool: Pool, actual: { usd: number; tokens?: number }): void {
  if (pool.usd !== undefined) pool.usd.committed += actual.usd
  if (pool.tokens !== undefined && actual.tokens !== undefined) pool.tokens.committed += actual.tokens
}

export function remaining(pool: Pool): { usd?: number; tokens?: number } {
  return {
    usd:
      pool.usd !== undefined ? Math.max(0, pool.usd.total - pool.usd.committed - pool.usd.reserved) : undefined,
    tokens:
      pool.tokens !== undefined
        ? Math.max(0, pool.tokens.total - pool.tokens.committed - pool.tokens.reserved)
        : undefined,
  }
}

export * as TurnBudget from "./turn-budget"
