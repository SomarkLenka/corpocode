// The run's spend ledger. Pure arithmetic over the config's budget block — no IO, no clock — so the
// loop can ask "would this next call bust the cap?" BEFORE dispatching it and pause at the boundary
// instead of discovering the overrun after the money is spent. Null caps mean UNCAPPED (the
// local-testing default written by init); build gets its own explicit cap rather than inheriting
// verify's, because build fanout is where runaway spend actually happens.
import type { CorpoConfig } from "../config/schema";

export type BudgetPhase = "spec" | "verify" | "build";

export interface BudgetGuard {
  /** Record actual spend. Monotonic — negative charges are ignored (a refund can't un-spend a call). */
  charge(phase: BudgetPhase, usd: number): void;
  /** True when spent+projected would bust the phase's cap OR the whole-run cap. Uncapped axes never trip. */
  wouldExceed(phase: BudgetPhase, projectedUsd?: number): boolean;
  /** Total spent in one phase, or across the run when phase is omitted. */
  spent(phase?: BudgetPhase): number;
  caps: { maxRunUsd: number | null; perPhase: Record<BudgetPhase, number | null> };
}

export function createBudgetGuard(budget: CorpoConfig["orchestrator"]["budget"]): BudgetGuard {
  const caps = {
    maxRunUsd: budget.max_run_usd,
    perPhase: {
      spec: budget.spec_usd,
      verify: budget.verify_usd,
      build: budget.build_usd,
    } as Record<BudgetPhase, number | null>,
  };
  const ledger: Record<BudgetPhase, number> = { spec: 0, verify: 0, build: 0 };

  return {
    caps,

    charge(phase, usd) {
      if (!(usd > 0)) return; // negative/NaN charges ignored — the ledger only moves forward
      ledger[phase] += usd;
    },

    spent(phase) {
      if (phase) return ledger[phase];
      return ledger.spec + ledger.verify + ledger.build;
    },

    wouldExceed(phase, projectedUsd = 0) {
      const projected = projectedUsd > 0 ? projectedUsd : 0;
      const phaseCap = caps.perPhase[phase];
      // Strictly greater-than: spending exactly up to the cap is allowed — the cap is a ceiling, not
      // a trip-wire below it.
      if (phaseCap !== null && ledger[phase] + projected > phaseCap) return true;
      const total = ledger.spec + ledger.verify + ledger.build; // not this.spent() — guards get destructured
      if (caps.maxRunUsd !== null && total + projected > caps.maxRunUsd) return true;
      return false;
    },
  };
}
