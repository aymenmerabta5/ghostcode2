import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

// Single source of truth for compaction thresholds - aligned with core and Claude Code
// Re-export from core to avoid drift
export { AUTOCOMPACT_BUFFER_TOKENS, WARNING_THRESHOLD_BUFFER_TOKENS, MANUAL_COMPACT_BUFFER_TOKENS } from "@opencode-ai/core/session/compaction"
const COMPACTION_BUFFER = 13_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const maxOutput = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
  const contextUsable = Math.max(0, context - maxOutput)
  if (!input.model.limit.input) return contextUsable
  const inputUsable = Math.max(0, input.model.limit.input - reserved)
  // Fix asymmetry bug: models with same context/output should agree regardless of input limit.
  // Use the more conservative of input-based and context-based limits (like V2 does with context).
  return Math.min(inputUsable, contextUsable)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
