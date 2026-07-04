// The cockpit's shared vocabulary. Pure types — no IO, no Zod (the spec's Zod schema lives in
// spec-schema.ts so artifact validation has one home). The seven sections are the interrogation
// charter from docs/narrative/05-upper-management.md: the run leaves the cockpit only when every
// section is complete AND the pilot answers the final approve poll.
import type { Answer, AxisFinding } from "../interact/types";

export const SPEC_SECTIONS = [
  "api-spec", // entities, contracts, endpoints, data shapes
  "capability-expansion", // what grafts onto the existing codebase (grounded in the KnowledgeGraph)
  "future-plans", // seams the architecture must not foreclose
  "parallelization", // which tasks are independent, so the swarm can fan out
  "compartmentalization", // service boundaries, one reason to change each
  "scale-path", // what must hold when the load is real
  "reusable-systems", // shared substrate factored out once
] as const;
export type SpecSectionId = (typeof SPEC_SECTIONS)[number];

/** The section ledger's lamp: open (amber) → in-progress → complete (green). */
export type SectionStatus = "open" | "in-progress" | "complete";

/** One decided fork, as journaled in the decisions ledger inside spec.json. The single audit
 *  trail of every human choice; mid-run escalations later append to the same ledger. */
export interface DecisionRecord {
  pollId: string;
  section: SpecSectionId;
  concept: string;
  question: string;
  options: { id: string; label: string; findings: AxisFinding[] }[];
  answer: Answer;
  at: number; // epoch ms
}

/** A fork the interrogator drafted and the consequence fan-out will analyze. */
export interface DecisionFork {
  id: string;
  section: SpecSectionId;
  concept: string;
  question: string;
  options: { id: string; label: string; description?: string }[];
  /** Whether this fork is major (architecture-shaping) — the granularity dial filters on it. */
  major: boolean;
}

/** The interrogator's next step: ask a drafted fork, or record content into a section. */
export type InterrogatorMove =
  | { kind: "fork"; fork: DecisionFork }
  | { kind: "content"; section: SpecSectionId; content: string }
  | { kind: "done" };

/** How the cockpit treats a concept, per the mastery model. Phase 1 is constantPoll: always
 *  teach-then-poll when teaching is on, and observe() only records. The adaptive EMA/hysteresis
 *  model is Phase 5 — the seam is identical so it swaps in without touching the loop. */
export type MasteryTreatment = "teach-then-poll" | "poll" | "assume";

export interface MasteryOutcome {
  /** Did the pilot answer directly (vs delegate), and without re-asking? */
  confident: boolean;
  /** Did they delegate the decision ("you decide")? */
  delegated: boolean;
}

export interface MasteryModel {
  treatment(concept: string): MasteryTreatment;
  /** Record an observation. Never throws; persistence is best-effort. */
  observe(concept: string, outcome: MasteryOutcome): void;
}
