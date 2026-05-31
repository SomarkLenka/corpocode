// Editing existing code: lean on structure (what calls/owns the target), surface the file's prior
// mistakes and rules before the edit lands, and pull a little reference material.
import type { RetrievalCues } from "../../session/types";
import type { ChecklistItem } from "../types";
import { basename, foldQuery } from "./common";

export function codeEditTemplate(cues: RetrievalCues, prompt: string): ChecklistItem[] {
  const q = foldQuery(cues, prompt);
  const items: ChecklistItem[] = [
    { kind: "query_graph", label: "structure around the edit", priority: 0.9, query: q, budget: 800 },
    { kind: "mem_recall", label: "prior mistakes & rules", priority: 0.85, query: q, kinds: ["mistake", "rule"], limit: 5 },
    { kind: "ov_find", label: "reference material", priority: 0.55, query: q, tier: "L0", limit: 4 },
  ];
  for (const f of cues.files.slice(0, 2)) {
    items.push({ kind: "get_node", label: `locate ${basename(f)}`, priority: 0.8, symbol: basename(f) });
  }
  return items;
}
