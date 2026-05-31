// Writing new code: recall the approaches and decisions that shaped the codebase so the new code
// matches its grain, look at neighbouring structure, and gather reference material to imitate.
import type { RetrievalCues } from "../../session/types";
import type { ChecklistItem } from "../types";
import { basename, foldQuery } from "./common";

export function codeGenTemplate(cues: RetrievalCues, prompt: string): ChecklistItem[] {
  const q = foldQuery(cues, prompt);
  const items: ChecklistItem[] = [
    { kind: "query_graph", label: "where the new code fits", priority: 0.85, query: q, budget: 800 },
    { kind: "mem_recall", label: "established approaches & decisions", priority: 0.8, query: q, kinds: ["approach", "decision"], limit: 5 },
    { kind: "ov_find", label: "patterns to imitate", priority: 0.65, query: q, tier: "L1", limit: 5 },
  ];
  for (const f of cues.files.slice(0, 1)) {
    items.push({ kind: "get_node", label: `anchor ${basename(f)}`, priority: 0.7, symbol: basename(f) });
  }
  return items;
}
