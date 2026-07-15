// The verify → rescue state machine. Pure orchestration: the arbiter call, the re-judgement, and the
// cheap rescue author are all INJECTED, so it is fully deterministic and faked in tests (no real model).
//
// Two invariants shape every branch:
//   1. A dead arbiter NEVER auto-accepts — no verdict means escalate, never land.
//   2. A spec-gap ALWAYS routes back to the human, regardless of mode — the diff may be fine, the spec
//      is not, and only the human authors the spec.
// In verify-rescue mode a reject drives a bounded rescue loop: a CHEAP agent authors from the arbiter's
// prose (the arbiter authors nothing), then the arbiter re-judges. Resample-first economics — bounded
// rescues, then give up cheaply rather than burning tokens chasing a stuck candidate.
import type { ArbitrateResult } from "./arbiter";
import type { ArbiterVerdict } from "./verdict";

export type RescueOutcome = "accepted" | "rejected" | "rescued-accepted" | "escalate-spec-gap" | "escalate";

export interface VerifyRescueDeps {
  /** First-pass arbitration of the candidate diff. */
  arbitrate: () => Promise<ArbitrateResult>;
  /** Re-judge after a cheap rescue authored a change. */
  reArbitrate: () => Promise<ArbitrateResult>;
  /** Cheap agent authors a rescue from the arbiter's prose; returns whether it produced a change. */
  rescueAuthor: (prose: string) => Promise<boolean>;
  mode: "gate" | "verify-rescue";
  maxRedispatch: number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface VerifyRescueResult {
  outcome: RescueOutcome;
  verdict?: ArbiterVerdict;
  rescues: number;
  escalation?: string;
}

/** Fold a verdict into the prose the cheap rescue author works from — summary + each criterion's note.
 *  The arbiter's words drive the rescue; the arbiter itself writes no code. */
function rescueProse(v: ArbiterVerdict): string {
  const notes = v.criteria.map((c) => `- [${c.id}] ${c.met ? "met" : "UNMET"}: ${c.note}`);
  return [v.summary, ...notes].join("\n");
}

export async function verifyAndRescue(deps: VerifyRescueDeps): Promise<VerifyRescueResult> {
  const r = await deps.arbitrate();
  if (!r.ok || !r.verdict) {
    deps.log?.({ event: "verify_rescue", outcome: "escalate", reason: r.skipped });
    return { outcome: "escalate", rescues: 0, ...(r.skipped ? { escalation: r.skipped } : {}) };
  }

  let v = r.verdict;
  if (v.decision === "accept") {
    deps.log?.({ event: "verify_rescue", outcome: "accepted", rescues: 0 });
    return { outcome: "accepted", verdict: v, rescues: 0 };
  }
  if (v.decision === "spec-gap") {
    deps.log?.({ event: "verify_rescue", outcome: "escalate-spec-gap", rescues: 0 });
    return { outcome: "escalate-spec-gap", verdict: v, rescues: 0 };
  }

  // decision === "reject"
  if (deps.mode === "gate") {
    deps.log?.({ event: "verify_rescue", outcome: "rejected", rescues: 0 });
    return { outcome: "rejected", verdict: v, rescues: 0 };
  }

  // verify-rescue: bounded cheap rescues, re-judged by the arbiter each round.
  let rescues = 0;
  for (let i = 0; i < deps.maxRedispatch; i++) {
    const authored = await deps.rescueAuthor(rescueProse(v));
    if (!authored) break; // cheap agent produced nothing — stop burning tokens

    const rr = await deps.reArbitrate();
    rescues++;
    if (!rr.ok || !rr.verdict) {
      deps.log?.({ event: "verify_rescue", outcome: "escalate", rescues, reason: rr.skipped });
      return { outcome: "escalate", rescues, ...(rr.skipped ? { escalation: rr.skipped } : {}) };
    }
    v = rr.verdict;
    if (v.decision === "accept") {
      deps.log?.({ event: "verify_rescue", outcome: "rescued-accepted", rescues });
      return { outcome: "rescued-accepted", verdict: v, rescues };
    }
    if (v.decision === "spec-gap") {
      deps.log?.({ event: "verify_rescue", outcome: "escalate-spec-gap", rescues });
      return { outcome: "escalate-spec-gap", verdict: v, rescues };
    }
    // still reject → next iteration authors a fresh rescue from the new verdict
  }

  deps.log?.({ event: "verify_rescue", outcome: "rejected", rescues });
  return { outcome: "rejected", verdict: v, rescues };
}
