// Documentation work: reference material dominates, at a fuller tier, with decisions recalled so the
// docs describe what was actually chosen and why.
import type { RetrievalCues } from "../../session/types";
import type { ChecklistItem } from "../types";
import { foldQuery } from "./common";

export function docsTemplate(cues: RetrievalCues, prompt: string): ChecklistItem[] {
  const q = foldQuery(cues, prompt);
  return [
    { kind: "ov_find", label: "documents to ground in", priority: 0.9, query: q, tier: "L1", limit: 6 },
    { kind: "mem_recall", label: "decisions to document", priority: 0.7, query: q, kinds: ["decision"], limit: 5 },
    { kind: "query_graph", label: "what the docs describe", priority: 0.55, query: q, budget: 600 },
  ];
}
