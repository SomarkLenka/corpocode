// Shared helpers for the checklist templates. Folding the session reader's cues into each item's
// query is what makes retrieval reason from the model's actual line of thought, not the bare prompt.
import type { RetrievalCues } from "../../session/types";

/** Combine the line-of-thought cue query with the raw prompt, cue first, bounded in length. */
export function foldQuery(cues: RetrievalCues, prompt: string): string {
  return [cues.query, prompt]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" — ")
    .slice(0, 400);
}

/** File name (with extension) for a path — what KnowledgeGraph.getNode matches on. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
