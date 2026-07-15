// The arbiter's verdict shape and the rubric it judges against. Pure and deterministic: the rubric
// is DERIVED from the human-approved EARS acceptance criteria (never invented), and the verdict is
// normalized so spec holes can never masquerade as an accept. The arbiter reads a diff + this rubric
// and emits one tiny structured verdict — it authors nothing.
import type { Spec } from "../um/spec-schema";

/** One acceptance criterion's judgement. `note` is the arbiter's terse justification. */
export interface CriterionVerdict {
  id: string;
  met: boolean;
  note: string;
}

/** The arbiter's whole verdict. `spec-gap` routes back to the human — the diff is fine, the spec isn't. */
export interface ArbiterVerdict {
  decision: "accept" | "reject" | "spec-gap";
  criteria: CriterionVerdict[];
  summary: string;
  specGaps: string[];
}

/** JSON Schema the arbiter's structured output is validated against. specGaps is optional so a clean
 *  accept need not carry an empty array; normalizeVerdict backfills it. */
export const VERDICT_SCHEMA = {
  type: "object",
  required: ["decision", "criteria", "summary"],
  properties: {
    decision: { enum: ["accept", "reject", "spec-gap"] },
    criteria: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "met", "note"],
        properties: {
          id: { type: "string" },
          met: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
    specGaps: { type: "array", items: { type: "string" } },
  },
} as const;

/** The sentinel prose when no acceptance criterion backs the task — the arbiter must default to reject. */
const NO_CRITERIA_SENTINEL = "(no acceptance criteria — reject unless trivially correct)";

/**
 * Build the rubric the arbiter judges against, filtered to exactly the acceptance ids the task
 * references. Order follows the spec (not the refs list), unknown refs are dropped, and NOTHING is
 * invented — an empty match yields the reject-unless-trivial sentinel rather than a fabricated bar.
 */
export function buildRubric(spec: Spec, refs: string[]): { criteria: Array<{ id: string; criterion: string }>; prose: string } {
  const wanted = new Set(refs);
  const criteria = spec.acceptance
    .filter((a) => wanted.has(a.id))
    .map((a) => ({ id: a.id, criterion: a.criterion }));
  const prose = criteria.length
    ? criteria.map((c) => `- [${c.id}] ${c.criterion}`).join("\n")
    : NO_CRITERIA_SENTINEL;
  return { criteria, prose };
}

/**
 * Normalize a raw arbiter verdict: default specGaps to [], and if the arbiter surfaced spec gaps but
 * did not itself route to spec-gap (e.g. it said "accept" while noting a hole), coerce the decision to
 * spec-gap. A reject stays a reject — a rejected diff with gaps is still a reject.
 */
export function normalizeVerdict(raw: ArbiterVerdict): ArbiterVerdict {
  const specGaps = raw.specGaps ?? [];
  const decision = specGaps.length > 0 && raw.decision !== "reject" ? "spec-gap" : raw.decision;
  return { ...raw, decision, specGaps };
}
