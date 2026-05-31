import { describe, it, expect } from "vitest";
import { computeCostUsd, lookupPrice, DEFAULT_PRICE } from "../../src/providers/pricing";

describe("pricing", () => {
  it("computes a known model's cost exactly", () => {
    // haiku-4-5: $1.00/MTok input, $5.00/MTok output.
    expect(computeCostUsd("anthropic", "claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBeCloseTo(6.0, 9);
    expect(computeCostUsd("anthropic", "claude-haiku-4-5-20251001", 10, 20)).toBeCloseTo(
      (10 * 1.0 + 20 * 5.0) / 1_000_000,
      12,
    );
  });

  it("treats Ollama as free regardless of model", () => {
    expect(computeCostUsd("ollama", "qwen2.5-coder:7b", 1000, 1000)).toBe(0);
  });

  it("falls back to DEFAULT_PRICE for an unknown model", () => {
    expect(lookupPrice("openrouter", "vendor/unknown-model")).toEqual(DEFAULT_PRICE);
    expect(computeCostUsd("openrouter", "vendor/unknown-model", 1_000_000, 0)).toBeCloseTo(
      DEFAULT_PRICE.inputPerMTok,
      9,
    );
  });
});
