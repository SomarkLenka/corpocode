// Honoring the categorizer's effort selection on the work CorpoCode spawns. The Provider interface
// is deliberately narrow (no provider-specific reasoning knob), so the portable way to spend "more"
// or "less" on a helper call is the token budget: a hard moment lets its retrieval/review/verify
// passes think a little longer, a trivial one spends the minimum.
import type { ChatInput } from "./types";
import type { Effort } from "../config/schema";

const MULTIPLIER: Record<Effort, number> = {
  minimal: 0.6,
  medium: 1,
  high: 1.6,
};

const FLOOR_TOKENS = 64;

/** Scale a chat call's token budget by the chosen effort. Undefined effort leaves the input as-is. */
export function applyEffort(input: ChatInput, effort: Effort | undefined): ChatInput {
  if (!effort) return input;
  const base = input.maxTokens ?? 500;
  return { ...input, maxTokens: Math.max(FLOOR_TOKENS, Math.round(base * MULTIPLIER[effort])) };
}
