// The retrieval team's vocabulary. A checklist decomposes a prompt into several small, specific
// items; each item resolves to exactly ONE call against exactly ONE knowledge abstraction; the
// results are merged deterministically into a budget-bounded package. The discriminated union below
// is what keeps "one item → one abstraction call" honest at the type level.
import type { KnowledgeGraph } from "../backends/graph/types";
import type { ContextStore, Tier } from "../backends/context/types";
import type { MemoryKind, MemoryStore, Scope } from "../backends/memory/types";

export type ItemKind = "get_node" | "get_neighbors" | "find_path" | "query_graph" | "ov_find" | "mem_recall";

interface ItemBase {
  label: string; // human-readable, for the retrieval_item log line
  priority: number; // 0..1 weight in the final ranking
}

export type ChecklistItem =
  | (ItemBase & { kind: "get_node"; symbol: string })
  | (ItemBase & { kind: "get_neighbors"; nodeId: string; depth?: number })
  | (ItemBase & { kind: "find_path"; from: string; to: string })
  | (ItemBase & { kind: "query_graph"; query: string; budget: number })
  | (ItemBase & { kind: "ov_find"; query: string; tier: Tier; limit: number })
  | (ItemBase & { kind: "mem_recall"; query: string; kinds?: MemoryKind[]; limit: number });

/** One piece of retrieved knowledge, normalized across the three abstractions for ranking/merge. */
export interface RetrievedRef {
  source: "graph" | "context" | "memory";
  ref: string; // file path, viking:// uri, or memory id
  detail: string; // a short human-readable line
  confidence: number; // item.priority × the item's intrinsic score, 0..1
}

export interface ItemResult {
  label: string;
  kind: ItemKind;
  ok: boolean;
  timedOut: boolean;
  refs: RetrievedRef[];
  latencyMs: number;
}

/** The merged, ranked, budget-bounded result injected as <middle-management retrieved-context>. */
export interface RetrievalPackage {
  block: string; // formatted body (without the surrounding tag)
  refs: RetrievedRef[];
  itemsTotal: number;
  itemsSucceeded: number;
  tokensEstimate: number;
}

/** The three abstractions an item handler may call, plus the recall scope. */
export interface RetrievalBackends {
  graph: KnowledgeGraph;
  context: ContextStore;
  memory: MemoryStore;
  scope: Scope;
}
