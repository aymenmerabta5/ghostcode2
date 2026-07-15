export const EFFORT_SCALE = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORT_SCALE)[number]

const EFFORT_RANK: Record<string, number> = {
  none: -2,
  minimal: -1,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
}

export function effortRank(effort: string): number | undefined {
  return EFFORT_RANK[effort]
}

export function resolveEffort(requested: string | undefined, variants: string[]): string | undefined {
  if (!requested || variants.length === 0) return undefined
  if (variants.includes(requested)) return requested

  const reqRank = EFFORT_RANK[requested]
  if (reqRank === undefined) return undefined

  const ranked = variants
    .map((v) => ({ v, rank: EFFORT_RANK[v] }))
    .filter((x): x is { v: string; rank: number } => x.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)

  if (ranked.length === 0) return undefined

  return ranked.find((x) => x.rank >= reqRank)?.v ?? ranked[ranked.length - 1]!.v
}

export * as EffortUtil from "./effort"
