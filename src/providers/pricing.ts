// Local pricing table. Every provider computes its own costUsd from this, never from the vendor
// response, so `corpocode stats` compares a Gemini call, an Ollama call, and a Haiku call on the
// same footing — and a vendor that omits cost information never blinds the tracker.
//
// Rates are USD per 1,000,000 tokens. Update here when vendor pricing changes; this is the single
// place spend math lives.
import type { ProviderKind } from "./types";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  "anthropic:claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "anthropic:claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "anthropic:claude-opus-4": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "anthropic-cli:claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "google:gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "openai:gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  "openai:gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

/** Conservative neutral fallback for an unpriced model (e.g. an arbitrary OpenRouter model). */
export const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 0.5, outputPerMTok: 1.5 };

export function lookupPrice(kind: ProviderKind, model: string): ModelPrice {
  return PRICES[`${kind}:${model}`] ?? PRICES[model] ?? DEFAULT_PRICE;
}

/** Cost of a single call. Ollama (local loopback) is always free. */
export function computeCostUsd(
  kind: ProviderKind,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (kind === "ollama") return 0;
  const price = lookupPrice(kind, model);
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}
