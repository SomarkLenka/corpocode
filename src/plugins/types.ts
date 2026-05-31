// The public, versioned contract a plugin package exports (Phase 4 §3). A plugin contributes
// DEFINITIONS — retrieval templates and tenet checks — never imperative behavior, so installing one
// extends the data CorpoCode reasons over without handing it free rein in the user's environment. The
// two seams are exactly the ones the architecture was built to be extended along: the planner's
// per-task templates and the MOLAR-EDIT engine's tenet checks.
import type { TenetCheck } from "../molar/types";
import type { RetrievalCues } from "../session/types";
import type { ChecklistItem } from "../retrieval/types";

/** A retrieval template: the checklist a given moment type should gather, folding in the session cues. */
export type TemplateFn = (cues: RetrievalCues, prompt: string) => ChecklistItem[];

export interface RetrievalTemplate {
  type: string; // the moment type it serves (e.g. "code-edit"); a plugin adds new types
  build: TemplateFn;
}

export interface CorpoPlugin {
  readonly apiVersion: 1; // plugins declare which API generation they target; others are declined cleanly
  readonly name: string;
  templates?: RetrievalTemplate[]; // contributed by corpocode-template-* packages
  tenets?: TenetCheck[]; // contributed by corpocode-tenet-* packages
}
