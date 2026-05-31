// Merge the item results into one deterministic package: dedupe references (keeping the highest-
// confidence sighting of each), rank by confidence, and truncate to the token budget so the injected
// context can never balloon. Ordering ties break on the ref string so the output is stable.
import type { ItemResult, RetrievalPackage, RetrievedRef } from "./types";

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const PER_REF_OVERHEAD = 8; // bullet + uri framing

const SOURCE_ORDER: RetrievedRef["source"][] = ["graph", "context", "memory"];
const SOURCE_LABEL: Record<RetrievedRef["source"], string> = {
  graph: "Code structure",
  context: "Reference material",
  memory: "Lessons & decisions",
};

function format(refs: RetrievedRef[]): string {
  if (refs.length === 0) return "(no additional context found)";
  const lines: string[] = [];
  for (const src of SOURCE_ORDER) {
    const xs = refs.filter((r) => r.source === src);
    if (xs.length === 0) continue;
    lines.push(`${SOURCE_LABEL[src]}:`);
    for (const r of xs) lines.push(`- ${r.detail} (${r.ref})`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function aggregate(results: ItemResult[], opts: { budgetTokens: number }): RetrievalPackage {
  // Dedupe by source+ref, keeping the highest-confidence sighting.
  const byKey = new Map<string, RetrievedRef>();
  for (const r of results.flatMap((x) => x.refs)) {
    const key = `${r.source}:${r.ref}`;
    const existing = byKey.get(key);
    if (!existing || r.confidence > existing.confidence) byKey.set(key, r);
  }

  const ranked = [...byKey.values()].sort(
    (a, b) => b.confidence - a.confidence || a.ref.localeCompare(b.ref),
  );

  const kept: RetrievedRef[] = [];
  let tokens = 0;
  for (const r of ranked) {
    const cost = estimateTokens(r.detail) + PER_REF_OVERHEAD;
    if (kept.length > 0 && tokens + cost > opts.budgetTokens) break; // always keep at least one
    kept.push(r);
    tokens += cost;
  }

  return {
    block: format(kept),
    refs: kept,
    itemsTotal: results.length,
    itemsSucceeded: results.filter((r) => r.ok).length,
    tokensEstimate: tokens,
  };
}
