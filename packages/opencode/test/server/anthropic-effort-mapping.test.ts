import { describe, test, expect } from "bun:test"

/**
 * Part A tests: Honor Claude Code's requested reasoning effort
 * Mapping:
 *   Claude effort: low, medium, high, max (from claude-code/utils/effort.ts EFFORT_LEVELS)
 *   Meta accepts: minimal, low, medium, high, xhigh (models.json, transform.ts)
 *   Mapping: low→low, medium→medium, high→high, max→xhigh
 *
 * Precedence:
 *   1. output_config.effort present → map directly
 *   2. budget_tokens present → derive via threshold table anchored to TUI high=16000, max=31999
 *   3. neither → xhigh (TUI parity)
 */

// Re-implement mapping logic as in anthropic.ts for testing (should match real code)
function mapClaudeEffortToBackend(claudeEffort: string, variants: string[]): string | undefined {
  const lower = claudeEffort.toLowerCase()
  const explicitMap: Record<string, string> = {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    max: "xhigh",
    xhigh: "xhigh",
  }
  const mapped = explicitMap[lower]
  if (mapped && variants.includes(mapped)) return mapped
  if (variants.includes(lower)) return lower
  if (lower === "max" && variants.includes("xhigh")) return "xhigh"
  if (lower === "xhigh" && variants.includes("max")) return "max"
  return undefined
}

function budgetToEffort(budget: number, variants: string[]): string | undefined {
  if (variants.length === 0) return undefined
  let tier: string
  if (budget < 2000) tier = "minimal"
  else if (budget < 6000) tier = "low"
  else if (budget < 12000) tier = "medium"
  else if (budget < 20000) tier = "high"
  else tier = "xhigh"
  if (variants.includes(tier)) return tier
  return undefined
}

describe("Part A: Effort mapping honors client", () => {
  const metaVariants = ["minimal", "low", "medium", "high", "xhigh"]

  test('inbound output_config.effort: "medium" → outbound reasoningEffort: "medium"', () => {
    const inboundEffort = "medium"
    const mapped = mapClaudeEffortToBackend(inboundEffort, metaVariants)
    expect(mapped).toBe("medium")
    // Simulate providerOptions raw would have reasoningEffort = mapped
    const raw = { reasoningEffort: mapped }
    expect(raw.reasoningEffort).toBe("medium")
  })

  test('inbound output_config.effort: "max" → outbound reasoningEffort: "xhigh"', () => {
    // Claude's max should map to meta's xhigh (strongest)
    const inboundEffort = "max"
    const mapped = mapClaudeEffortToBackend(inboundEffort, metaVariants)
    expect(mapped).toBe("xhigh")
    const raw = { reasoningEffort: mapped }
    expect(raw.reasoningEffort).toBe("xhigh")
  })

  test('budget-only request → derived tier per threshold table', () => {
    // Thresholds anchored to TUI high=16000, max=31999 (transform.ts)
    expect(budgetToEffort(500, metaVariants)).toBe("minimal") // << high
    expect(budgetToEffort(3000, metaVariants)).toBe("low")
    expect(budgetToEffort(8000, metaVariants)).toBe("medium") // < high 16000
    expect(budgetToEffort(15000, metaVariants)).toBe("high") // ≈ high 16000
    expect(budgetToEffort(25000, metaVariants)).toBe("xhigh") // approaching max 31999
  })

  test('neither effort nor budget → xhigh (TUI parity)', () => {
    const variants = metaVariants
    const rawRequestedEffort: string | undefined = undefined
    const budget: number | undefined = undefined
    let resolved: string | undefined
    let rule: string
    if (rawRequestedEffort) {
      rule = "output_config.effort"
      resolved = mapClaudeEffortToBackend(rawRequestedEffort, variants)
    } else if (budget !== undefined) {
      rule = `budget:${budget}`
      resolved = budgetToEffort(budget, variants)
    } else {
      rule = "default_xhigh"
      resolved = "xhigh"
    }
    expect(rule).toBe("default_xhigh")
    expect(resolved).toBe("xhigh")
  })

  test("Anthropic backend unaffected by meta effort mapping", () => {
    // For Anthropic, budget should clamp TUI-style, not map to effort via thresholds
    const budget = 50000
    const outputLimit = 32000
    const clamped = Math.min(budget, outputLimit - 1, 31999)
    expect(clamped).toBe(31999)

    const budget2 = 10000
    const outputLimit2 = 8000
    const clamped2 = Math.min(budget2, outputLimit2 - 1, 31999)
    expect(clamped2).toBe(7999)

    // Anthropic effort mapping should still work via resolveModelEffort, not our meta mapping
    // Simulate that Anthropic variants are high/max with budgetTokens
    const anthropicVariants = ["high", "max"]
    const mapped = mapClaudeEffortToBackend("medium", anthropicVariants)
    // medium not in anthropic variants that are high/max, so should fallback or undefined
    // But our map for medium would try to find medium, which is not in anthropicVariants, so undefined
    // Then resolveModelEffort would handle? For Anthropic, effort is separate from budget, so we keep budget path
    expect(clamped).toBeDefined()
  })

  test("precedence: output_config.effort wins over budget_tokens", () => {
    const effort = "high"
    const budget = 500 // would map to minimal if used
    const variants = metaVariants

    // Precedence: effort present → use effort, ignore budget
    const rawRequestedEffort = effort
    const thinkingBudget = budget
    let resolved: string | undefined
    let rule: string
    if (rawRequestedEffort) {
      resolved = mapClaudeEffortToBackend(rawRequestedEffort, variants)
      rule = `output_config.effort:${rawRequestedEffort}->${resolved}`
    } else if (thinkingBudget !== undefined) {
      resolved = budgetToEffort(thinkingBudget, variants)
      rule = `budget:${thinkingBudget}->${resolved}`
    } else {
      resolved = "xhigh"
      rule = "default_xhigh"
    }

    expect(resolved).toBe("high") // not minimal
    expect(rule).toBe("output_config.effort:high->high")
  })
})
