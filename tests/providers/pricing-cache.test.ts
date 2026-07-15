import { describe, it, expect } from "vitest";
import { computeCostUsd, priceBreakdown, lookupPrice } from "../../src/providers/pricing";

describe("pricing — cache-split", () => {
  it("keeps the legacy 4-arg call unchanged (≈6.0)", () => {
    // Existing invariant: no cache tokens → identical result as before the overload.
    expect(computeCostUsd("anthropic", "claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBeCloseTo(6.0, 9);
  });

  it("prices cached reads cheaper than the same tokens billed as fresh input", () => {
    const asInput = computeCostUsd("anthropic", "claude-haiku-4-5", 1_000_000, 0, 0, 0);
    const asCacheRead = computeCostUsd("anthropic", "claude-haiku-4-5", 0, 0, 1_000_000, 0);
    expect(asCacheRead).toBeLessThan(asInput);
    // default cache-read = 10% of input (Anthropic convention): 1.0 * 0.1 = 0.1
    expect(asCacheRead).toBeCloseTo(0.1, 9);
  });

  it("prices cache writes pricier than the same tokens billed as fresh input", () => {
    const asInput = computeCostUsd("anthropic", "claude-haiku-4-5", 1_000_000, 0, 0, 0);
    const asCacheWrite = computeCostUsd("anthropic", "claude-haiku-4-5", 0, 0, 0, 1_000_000);
    expect(asCacheWrite).toBeGreaterThan(asInput);
    // default cache-write = 1.25x input: 1.0 * 1.25 = 1.25
    expect(asCacheWrite).toBeCloseTo(1.25, 9);
  });

  it("honors explicit cache rates when a model declares them", () => {
    // gpt-4o-mini has no explicit cache rates in the table → defaults apply.
    const p = lookupPrice("openai", "gpt-4o-mini");
    const expectedRead = (p.cacheReadPerMTok ?? p.inputPerMTok * 0.1);
    const expectedWrite = (p.cacheWritePerMTok ?? p.inputPerMTok * 1.25);
    expect(computeCostUsd("openai", "gpt-4o-mini", 0, 0, 1_000_000, 0)).toBeCloseTo(expectedRead, 9);
    expect(computeCostUsd("openai", "gpt-4o-mini", 0, 0, 0, 1_000_000)).toBeCloseTo(expectedWrite, 9);
  });

  it("keeps ollama free across every bucket", () => {
    expect(computeCostUsd("ollama", "qwen2.5-coder:7b", 1000, 1000, 1000, 1000)).toBe(0);
    const b = priceBreakdown("ollama", "qwen2.5-coder:7b", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 1000,
    });
    expect(b).toEqual({ inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0 });
  });

  it("priceBreakdown splits per-bucket and sums to the total call cost", () => {
    const b = priceBreakdown("anthropic", "claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(b.inputUsd).toBeCloseTo(1.0, 9);
    expect(b.outputUsd).toBeCloseTo(5.0, 9);
    expect(b.cacheReadUsd).toBeCloseTo(0.1, 9);
    expect(b.cacheWriteUsd).toBeCloseTo(1.25, 9);
    expect(b.totalUsd).toBeCloseTo(1.0 + 5.0 + 0.1 + 1.25, 9);
    expect(b.totalUsd).toBeCloseTo(
      computeCostUsd("anthropic", "claude-haiku-4-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000),
      9,
    );
  });

  it("defaults missing cache token counts to zero in priceBreakdown", () => {
    const b = priceBreakdown("anthropic", "claude-haiku-4-5", { inputTokens: 10, outputTokens: 20 });
    expect(b.cacheReadUsd).toBe(0);
    expect(b.cacheWriteUsd).toBe(0);
    expect(b.totalUsd).toBeCloseTo((10 * 1.0 + 20 * 5.0) / 1_000_000, 12);
  });
});
