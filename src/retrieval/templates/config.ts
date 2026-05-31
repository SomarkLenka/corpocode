// Configuration changes: rules and prior decisions carry the most weight (config is where a single
// wrong value bites), backed by reference material and a light structural look.
import type { RetrievalCues } from "../../session/types";
import type { ChecklistItem } from "../types";
import { foldQuery } from "./common";

export function configTemplate(cues: RetrievalCues, prompt: string): ChecklistItem[] {
  const q = foldQuery(cues, prompt);
  return [
    { kind: "mem_recall", label: "config rules & decisions", priority: 0.9, query: q, kinds: ["rule", "decision"], limit: 5 },
    { kind: "ov_find", label: "config reference", priority: 0.7, query: q, tier: "L0", limit: 4 },
    { kind: "query_graph", label: "what reads this config", priority: 0.6, query: q, budget: 600 },
  ];
}
