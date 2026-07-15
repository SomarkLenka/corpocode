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
  // Optional cache-split rates (USD per 1M tokens). When absent, cached reads default to 10% of
  // input and cache writes to 1.25x input — the Anthropic convention. Omitting them keeps the
  // legacy two-bucket math identical.
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
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

// Default cache multipliers over the input rate when a model declares no explicit cache pricing.
const CACHE_READ_MULTIPLIER = 0.1; // cached reads ≈ 10% of input (Anthropic convention)
const CACHE_WRITE_MULTIPLIER = 1.25; // cache writes ≈ 1.25x input

function cacheReadRate(price: ModelPrice): number {
  return price.cacheReadPerMTok ?? price.inputPerMTok * CACHE_READ_MULTIPLIER;
}

function cacheWriteRate(price: ModelPrice): number {
  return price.cacheWritePerMTok ?? price.inputPerMTok * CACHE_WRITE_MULTIPLIER;
}

/**
 * Cost of a single call. Ollama (local loopback) is always free. Cache token buckets are optional
 * and default to 0, so existing 4-arg callers get an identical result.
 */
export function computeCostUsd(
  kind: ProviderKind,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (kind === "ollama") return 0;
  const price = lookupPrice(kind, model);
  return (
    (inputTokens * price.inputPerMTok +
      outputTokens * price.outputPerMTok +
      cacheReadTokens * cacheReadRate(price) +
      cacheWriteTokens * cacheWriteRate(price)) /
    1_000_000
  );
}

export interface PriceBreakdownTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PriceBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
}

/** Per-bucket cost split for one call. Ollama is all-zero; buckets sum to the same total call cost. */
export function priceBreakdown(
  kind: ProviderKind,
  model: string,
  tokens: PriceBreakdownTokens,
): PriceBreakdown {
  if (kind === "ollama") {
    return { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0 };
  }
  const price = lookupPrice(kind, model);
  const inputUsd = (tokens.inputTokens * price.inputPerMTok) / 1_000_000;
  const outputUsd = (tokens.outputTokens * price.outputPerMTok) / 1_000_000;
  const cacheReadUsd = ((tokens.cacheReadTokens ?? 0) * cacheReadRate(price)) / 1_000_000;
  const cacheWriteUsd = ((tokens.cacheWriteTokens ?? 0) * cacheWriteRate(price)) / 1_000_000;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
  };
}
