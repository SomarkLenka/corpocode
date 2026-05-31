// Understanding the codebase: cast a wider structural net and pull more reference material, with a
// lighter touch on file-specific lookups since the goal is breadth, not a targeted change.
import type { RetrievalCues } from "../../session/types";
import type { ChecklistItem } from "../types";
import { foldQuery } from "./common";

export function explorationTemplate(cues: RetrievalCues, prompt: string): ChecklistItem[] {
  const q = foldQuery(cues, prompt);
  return [
    { kind: "query_graph", label: "broad structure", priority: 0.85, query: q, budget: 1200 },
    { kind: "ov_find", label: "overview material", priority: 0.75, query: q, tier: "L0", limit: 6 },
    { kind: "mem_recall", label: "what was decided here", priority: 0.7, query: q, kinds: ["decision", "approach"], limit: 5 },
  ];
}
