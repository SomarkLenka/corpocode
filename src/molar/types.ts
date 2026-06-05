// MOLAR-EDIT engine contract — consumed by the verifier (post-edit) and, in Phase 2, the
// design-review team (at breakpoints). One TenetCheck family per active tenet; both paths fan out
// one provider call per tenet and merge deterministically. `corpocode-tenet-*` plugin packages
// register additional checks into the same engine.
import type { PromptId } from "../prompts/registry";

export type Tenet = "M" | "O" | "L" | "A" | "R" | "E" | "D" | "I" | "T";

export interface TenetCheck {
  tenet: Tenet;
  name: string; // e.g. "atomicity:one-thing-per-unit"
  appliesTo(file: { path: string }): boolean; // e.g. R only on UI files
  // The rubric, as an editable built-in prompt id (`promptId`, the built-in tenets) OR an inline string
  // (`prompt`, plugin-contributed checks). Consumers resolve promptId through the prompt registry first.
  promptId?: PromptId;
  prompt?: string;
}

export interface TenetFinding {
  tenet: Tenet;
  ok: boolean;
  severity: "info" | "warn" | "block";
  message: string; // structured: what, where, why, what to check next (the L tenet)
  confidence: number; // 0..1
}

export interface MolarEditEngine {
  activeTenets(): Tenet[];
  verify(files: string[]): Promise<TenetFinding[]>;
  review(designContext: string): Promise<TenetFinding[]>;
}
