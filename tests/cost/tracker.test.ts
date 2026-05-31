import { describe, it, expect } from "vitest";
import { aggregateCosts, createCostTracker, dayOf, type CostEvent } from "../../src/cost/tracker";

const ev = (over: Partial<CostEvent>): CostEvent => ({
  ts: "2026-05-30T10:00:00.000Z",
  component: "router",
  provider: "anthropic",
  costUsd: 0.001,
  ...over,
});

describe("cost tracker", () => {
  it("sums totals across component, provider, and day", () => {
    const totals = aggregateCosts([
      ev({ component: "router", provider: "anthropic", costUsd: 0.002 }),
      ev({ component: "router", provider: "anthropic", costUsd: 0.003 }),
      ev({ component: "verifier", provider: "ollama", costUsd: 0, ts: "2026-05-31T09:00:00Z" }),
    ]);
    expect(totals.count).toBe(3);
    expect(totals.totalUsd).toBeCloseTo(0.005, 6);
    expect(totals.byComponent.router).toBeCloseTo(0.005, 6);
    expect(totals.byProvider.anthropic).toBeCloseTo(0.005, 6);
    expect(totals.byDay["2026-05-30"]).toBeCloseTo(0.005, 6);
    expect(totals.byDay["2026-05-31"]).toBe(0);
    expect(totals.byComponentProviderDay["router|anthropic|2026-05-30"]).toBeCloseTo(0.005, 6);
  });

  it("buckets missing component/provider under 'unknown'", () => {
    const totals = aggregateCosts([{ ts: "2026-05-30T00:00:00Z", costUsd: 0.01 }]);
    expect(totals.byComponent.unknown).toBeCloseTo(0.01, 6);
    expect(totals.byProvider.unknown).toBeCloseTo(0.01, 6);
  });

  it("derives the UTC day, and 'unknown' for an unparseable ts", () => {
    expect(dayOf("2026-05-30T23:59:00.000Z")).toBe("2026-05-30");
    expect(dayOf("not-a-date")).toBe("unknown");
  });

  it("accumulates incrementally via the in-memory tracker", () => {
    const tracker = createCostTracker();
    tracker.record(ev({ costUsd: 0.001 }));
    tracker.record(ev({ costUsd: 0.004 }));
    expect(tracker.totals().totalUsd).toBeCloseTo(0.005, 6);
    expect(tracker.totals().count).toBe(2);
  });
});
