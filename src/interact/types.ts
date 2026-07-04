// The Interactor seam — CorpoCode's first interactive surface. Everything the cockpit asks the
// human goes through this one interface, so the terminal Q&A loop (Phase 1), the scripted answers
// file (tests/CI), and the local web cockpit (Phase 2) are interchangeable behind one contract.
//
// The fail-open posture, made visible in the types: `ask` NEVER throws and never hangs forever.
// When the interactor dies (closed stdin, disconnected browser), it resolves the poll's declared
// default (`source: "default"` — the caller journals `answer_defaulted`) or resolves `null`, which
// tells the caller to transition the run to `paused`. A dead human channel never crashes a run and
// never silently guesses.

/** One computed consequence of one option on one axis — the output of a `consequence` agent. */
export interface AxisFinding {
  axis: string; // e.g. "performance", "failure-modes" — from orchestrator.interrogation.consequence_axes
  optionId: string;
  summary: string; // one or two sentences: the computed trade-off, concrete not generic
  severity: "info" | "warn" | "risk";
  ok: boolean; // false when the fan-out agent failed — the poll renders the axis as "unanalyzed"
}

export interface PollOption {
  id: string; // stable within the poll, e.g. "a", "b"
  label: string; // short — what the pilot picks
  description?: string; // one or two sentences of detail
  findings: AxisFinding[]; // per-axis consequences, pre-analyzed
  recommended?: boolean; // set ONLY by the deterministic majority-of-axes fold — never a model call
}

/** A teaching block shown before the question when the concept is past the pilot's frontier.
 *  Phase 1 renders it deterministically from the findings; generated-and-verified teaching is Phase 5. */
export interface TeachingBlock {
  concept: string;
  body: string; // plain text — structure, not markup
}

export interface Poll {
  id: string; // stable id — the decisions-ledger key
  concept: string; // the concept this decision exercises (the mastery-model key)
  question: string;
  options: PollOption[];
  teaching?: TeachingBlock;
  allowFreeText: boolean; // the pilot may always answer in their own words
  allowDelegate: boolean; // offer "you decide" — recorded as delegated, resolved by the recommendation
  defaultOptionId?: string; // resolved when the interactor dies; absent ⇒ ask() resolves null ⇒ pause
}

export type AnswerSource = "pilot" | "delegated" | "default";

export interface Answer {
  pollId: string;
  optionId?: string; // the chosen option (present unless freeText answered the poll)
  freeText?: string; // the pilot's own words, when they typed instead of picking
  source: AnswerSource;
}

/** One-way narration to the human (section-ledger updates, phase transitions, cost notices). */
export interface Interactor {
  /** Present a poll; resolve the answer. Never throws; never hangs forever. `null` ⇒ pause the run. */
  ask(poll: Poll): Promise<Answer | null>;
  /** Narrate one block of plain text. Best-effort; never throws. */
  say(block: string): void;
  /** Release the surface (close readline, stop the server). Idempotent; never throws. */
  close(): Promise<void>;
}
