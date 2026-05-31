// The registry of built-in MOLAR-EDIT checks — one family per tenet. The verifier (post-edit) and
// the design-review team (at breakpoints) both draw their checks from here, filtered by the active
// tenet set. `corpocode-tenet-*` plugin packages will append their own checks to this registry in a
// later phase; the consumers only ever see TenetCheck[], never the concrete modules.
import type { Tenet, TenetCheck } from "../../molar/types";
import { atomicityCheck } from "./atomicity";
import { loggingCheck } from "./logging";
import { maintainabilityCheck } from "./maintainability";
import { observabilityCheck } from "./observability";
import { responsivenessCheck } from "./responsiveness";
import { extensibilityCheck } from "./extensibility";
import { documentationCheck } from "./documentation";
import { inFlightCheck } from "./in-flight";
import { testingCheck } from "./testing";

/** Every built-in tenet check. Order is stable so logs and findings are deterministic. */
export const ALL_CHECKS: TenetCheck[] = [
  maintainabilityCheck,
  observabilityCheck,
  loggingCheck,
  atomicityCheck,
  responsivenessCheck,
  extensibilityCheck,
  documentationCheck,
  inFlightCheck,
  testingCheck,
];

/**
 * The checks belonging to the given active tenets, drawn from the built-ins plus any plugin-contributed
 * checks. Removing a tenet from the active set stops its checks — including plugin ones — so a tenet
 * pack a user has disabled never fires. Plugin checks append after built-ins, preserving stable order.
 */
export function checksForTenets(tenets: readonly Tenet[], extra: readonly TenetCheck[] = []): TenetCheck[] {
  const active = new Set(tenets);
  return [...ALL_CHECKS, ...extra].filter((c) => active.has(c.tenet));
}
