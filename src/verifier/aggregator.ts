// Turns a set of tenet findings into the verifier's consequence. The rule is deliberately strict
// about when CorpoCode is allowed to halt the host: a single HIGH-CONFIDENCE `block` finding stops
// the edit; warns and infos are surfaced to the model but never stop it. A false block is its own
// kind of harm, so the bar to block is high and everything else degrades to advice.
import type { TenetFinding } from "../molar/types";

/** A block finding below this confidence is downgraded to advice — we never halt on a guess. */
export const BLOCK_CONFIDENCE = 0.7;

export interface VerifierVerdict {
  violations: TenetFinding[]; // every finding with ok === false
  blocked: boolean;
  blockFinding?: TenetFinding;
  stopReason?: string;
}

export function aggregateFindings(findings: TenetFinding[]): VerifierVerdict {
  const violations = findings.filter((f) => !f.ok);
  const blockFinding = violations.find((f) => f.severity === "block" && f.confidence >= BLOCK_CONFIDENCE);
  if (blockFinding) {
    return {
      violations,
      blocked: true,
      blockFinding,
      stopReason: `CorpoCode verifier: MOLAR-EDIT ${blockFinding.tenet} violation — ${blockFinding.message}`,
    };
  }
  return { violations, blocked: false };
}

/** Format the surfaced (non-blocking) violations for injection into the model's context. */
export function formatViolations(violations: TenetFinding[]): string {
  return violations
    .map((f) => `- [${f.tenet}] ${f.message} (${f.severity}, confidence ${f.confidence.toFixed(2)})`)
    .join("\n");
}
