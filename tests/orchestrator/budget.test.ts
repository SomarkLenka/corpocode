// Budget guard arithmetic — null = uncapped, per-phase vs whole-run interplay, projected charges,
// and spend sequences landing exactly on the pause boundary. Pure math, no IO.
import { describe, it, expect } from "vitest";
import { createBudgetGuard, type BudgetPhase } from "../../src/orchestrator/budget";
import { configSchema, type CorpoConfig } from "../../src/config/schema";

type Budget = CorpoConfig["orchestrator"]["budget"];

function budget(overrides: Partial<Budget> = {}): Budget {
  return { max_run_usd: null, spec_usd: null, verify_usd: null, build_usd: null, ...overrides };
}

describe("createBudgetGuard", () => {
  it("the config default (all nulls) is fully uncapped — wouldExceed never trips", () => {
    // Prove the schema default really is the uncapped shape this guard treats as "no ceiling".
    const cfg = configSchema.parse({});
    const guard = createBudgetGuard(cfg.orchestrator.budget);
    guard.charge("build", 1_000_000);
    for (const phase of ["spec", "verify", "build"] as BudgetPhase[]) {
      expect(guard.wouldExceed(phase)).toBe(false);
      expect(guard.wouldExceed(phase, 1_000_000)).toBe(false);
    }
    expect(guard.caps).toEqual({ maxRunUsd: null, perPhase: { spec: null, verify: null, build: null } });
  });

  it("tracks spend per phase and in total", () => {
    const guard = createBudgetGuard(budget());
    guard.charge("spec", 0.5);
    guard.charge("spec", 0.25);
    guard.charge("verify", 1);
    guard.charge("build", 2);
    expect(guard.spent("spec")).toBeCloseTo(0.75);
    expect(guard.spent("verify")).toBe(1);
    expect(guard.spent("build")).toBe(2);
    expect(guard.spent()).toBeCloseTo(3.75);
  });

  it("charges are monotonic — negative and NaN charges are ignored", () => {
    const guard = createBudgetGuard(budget());
    guard.charge("spec", 1);
    guard.charge("spec", -5);
    guard.charge("spec", Number.NaN);
    guard.charge("spec", 0);
    expect(guard.spent("spec")).toBe(1);
  });

  it("per-phase cap: spending exactly to the cap is fine, one cent past trips", () => {
    const guard = createBudgetGuard(budget({ spec_usd: 2 }));
    guard.charge("spec", 2);
    expect(guard.wouldExceed("spec")).toBe(false); // at the ceiling, not through it
    expect(guard.wouldExceed("spec", 0.01)).toBe(true);
    guard.charge("spec", 0.01);
    expect(guard.wouldExceed("spec")).toBe(true);
    // Other phases are untouched by spec's cap.
    expect(guard.wouldExceed("build", 100)).toBe(false);
  });

  it("build has its own independent cap", () => {
    const guard = createBudgetGuard(budget({ verify_usd: 5, build_usd: 1 }));
    expect(guard.wouldExceed("build", 1.5)).toBe(true);
    expect(guard.wouldExceed("verify", 1.5)).toBe(false);
  });

  it("total cap trips even when every per-phase cap has headroom", () => {
    const guard = createBudgetGuard(budget({ max_run_usd: 3, spec_usd: 2, verify_usd: 2, build_usd: 2 }));
    guard.charge("spec", 1.5);
    guard.charge("verify", 1.5); // total now 3 = max_run_usd
    expect(guard.wouldExceed("build")).toBe(false); // exactly at the run cap
    expect(guard.wouldExceed("build", 0.01)).toBe(true); // any build spend busts the TOTAL, not build's cap
    expect(guard.spent("build")).toBe(0);
  });

  it("per-phase cap trips even when the total cap has headroom", () => {
    const guard = createBudgetGuard(budget({ max_run_usd: 100, spec_usd: 1 }));
    guard.charge("spec", 0.9);
    expect(guard.wouldExceed("spec", 0.2)).toBe(true);
    expect(guard.wouldExceed("verify", 0.2)).toBe(false);
  });

  it("projected defaults to 0 — a bare wouldExceed asks about the current position only", () => {
    const guard = createBudgetGuard(budget({ spec_usd: 1 }));
    guard.charge("spec", 0.99);
    expect(guard.wouldExceed("spec")).toBe(false);
  });

  it("a spend sequence hits the pause point exactly where the cap says", () => {
    // Simulates the loop: before each $0.25 call, ask; charge only when allowed. Quarter-dollar
    // amounts are exactly representable in binary, so "fits exactly" isn't at the mercy of FP drift.
    const guard = createBudgetGuard(budget({ spec_usd: 0.75 }));
    const call = 0.25;
    let calls = 0;
    while (!guard.wouldExceed("spec", call)) {
      guard.charge("spec", call);
      calls++;
    }
    expect(calls).toBe(3); // 3 x 0.25 = 0.75 fits exactly; the 4th would bust
    expect(guard.spent("spec")).toBe(0.75);
  });
});
