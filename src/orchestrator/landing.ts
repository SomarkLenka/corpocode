// The explicit human landing poll (invariant 3: landing onto the user's branch is NEVER automatic).
// After the swarm+arbiter produce an integration branch and Phase 4 promotes it to a clean branch,
// the run stops and ASKS. The SAFE default is "keep" — the run stays on its own branch unless the
// pilot deliberately picks "land". A dead interactor (`null`) pauses the run; it never guesses land.
//
// No model, no clock, no fs here — this is the pure decision seam between the poll answer and the
// caller-supplied `land()` mechanic. The caller wires `land()` to the actual git merge in a later
// phase; Phase 4 only guarantees that land() runs on, and only on, an explicit "land" choice.
import type { Interactor, Poll } from "../interact/types";

export type LandingDecision = "landed" | "declined" | "paused";

/**
 * Build the landing poll. Exactly two options — keep (recommended, the safe default) and land —
 * with free text and delegation disabled: landing is a deliberate binary the pilot must own.
 */
export function landingPoll(runId: string, integrationBranch: string, userBranch: string): Poll {
  return {
    id: `landing:${runId}`,
    concept: "landing",
    question:
      `Run ${runId} is ready on ${integrationBranch}. Land it onto ${userBranch} now, ` +
      `or keep the work on the integration branch for you to inspect first?`,
    options: [
      {
        id: "keep",
        label: "Keep on the integration branch",
        findings: [],
        recommended: true,
      },
      {
        id: "land",
        label: `Land onto ${userBranch} now`,
        findings: [],
      },
    ],
    allowFreeText: false,
    allowDelegate: false,
    defaultOptionId: "keep",
  };
}

export interface ProposeLandingOptions {
  interactor: Interactor;
  runId: string;
  integrationBranch: string;
  userBranch: string;
  /** The actual landing mechanic (integration → user branch). Called ONLY on an explicit "land". */
  land: () => Promise<void>;
  log?: (fields: Record<string, unknown>) => void;
}

export interface LandingResult {
  decision: LandingDecision;
  reason?: string;
}

/**
 * Ask the pilot whether to land. Only `optionId === "land"` triggers `land()`; every other answer
 * (keep, free text, an undefined optionId) declines without landing, and a `null` answer pauses the
 * run. This asymmetry is the invariant: nothing but an explicit "land" ever touches the user's branch.
 */
export async function proposeLanding(opts: ProposeLandingOptions): Promise<LandingResult> {
  const { interactor, runId, integrationBranch, userBranch, land, log } = opts;
  const answer = await interactor.ask(landingPoll(runId, integrationBranch, userBranch));

  const emit = (result: LandingResult): LandingResult => {
    log?.({ event: "landing_decision", runId, decision: result.decision, reason: result.reason });
    return result;
  };

  if (answer === null) {
    return emit({ decision: "paused", reason: "no answer — run paused" });
  }
  if (answer.optionId === "land") {
    await land();
    return emit({ decision: "landed" });
  }
  return emit({ decision: "declined", reason: answer.optionId ?? answer.freeText ?? "declined" });
}
