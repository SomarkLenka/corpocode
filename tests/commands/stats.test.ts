import { describe, it, expect } from "vitest";
import { computeStats } from "../../src/commands/stats";

const line = (o: object): string => JSON.stringify(o);

describe("computeStats", () => {
  it("aggregates cost by component and provider and computes the error rate", () => {
    const lines = [
      line({ ts: "2026-05-30T10:00:00Z", event: "router", component: "router", provider: "anthropic", cost_usd: 0.002 }),
      line({ ts: "2026-05-30T11:00:00Z", event: "verifier", component: "verifier", provider: "ollama", cost_usd: 0 }),
      line({ ts: "2026-05-30T12:00:00Z", event: "hook_error", component: "dispatch" }),
    ];
    const r = computeStats(lines, { now: Date.parse("2026-05-31T00:00:00Z") });
    expect(r.events).toBe(3);
    expect(r.totalCostUsd).toBeCloseTo(0.002, 6);
    expect(r.byComponent.router).toBeCloseTo(0.002, 6);
    expect(r.byProvider.anthropic).toBeCloseTo(0.002, 6);
    expect(r.errorRate).toBeCloseTo(1 / 3, 6);
    expect(r.estimatedSavingsUsd).toBeGreaterThan(0);
  });

  it("filters out events older than the days window", () => {
    const lines = [
      line({ ts: "2026-05-01T10:00:00Z", event: "router", cost_usd: 1 }),
      line({ ts: "2026-05-30T10:00:00Z", event: "router", cost_usd: 2 }),
    ];
    const r = computeStats(lines, { days: 7, now: Date.parse("2026-05-31T00:00:00Z") });
    expect(r.events).toBe(1);
    expect(r.totalCostUsd).toBeCloseTo(2, 6);
  });

  it("ignores malformed and blank lines", () => {
    const r = computeStats(["not json", "", line({ event: "router", cost_usd: 0.5 })]);
    expect(r.events).toBe(1);
    expect(r.totalCostUsd).toBeCloseTo(0.5, 6);
  });
});
