// The convergence point: one checklist item resolves to exactly ONE call against exactly ONE
// knowledge abstraction, normalized to RetrievedRef[]. Each item is bounded by a per-item timeout
// and any failure is converted to a result marked timed-out/failed — so one dead backend degrades
// that single item, never the whole package (the fail-open principle at item granularity).
import type { ChecklistItem, ItemResult, RetrievalBackends, RetrievedRef } from "./types";

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

type Raced<T> = { value: T; timedOut: false } | { timedOut: true };

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([p.then((value): Raced<T> => ({ value, timedOut: false })), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

async function resolveItem(item: ChecklistItem, backends: RetrievalBackends): Promise<RetrievedRef[]> {
  switch (item.kind) {
    case "get_node": {
      const node = await backends.graph.getNode(item.symbol);
      if (!node) return [];
      return [
        {
          source: "graph",
          ref: node.path ?? node.name,
          detail: `${node.kind} ${node.name}${node.summary ? ` — ${node.summary}` : ""}`,
          confidence: clamp(item.priority * (node.centrality ?? 0.6)),
        },
      ];
    }
    case "get_neighbors": {
      const hood = await backends.graph.getNeighbors(item.nodeId, item.depth !== undefined ? { depth: item.depth } : {});
      return hood.nodes.map((n) => ({
        source: "graph" as const,
        ref: n.path ?? n.name,
        detail: `neighbor of ${item.nodeId}: ${n.name}`,
        confidence: clamp(item.priority * 0.7),
      }));
    }
    case "find_path": {
      const path = await backends.graph.findPath(item.from, item.to);
      if (!path) return [];
      return path.nodes.map((n) => ({
        source: "graph" as const,
        ref: n.path ?? n.name,
        detail: `on path ${item.from}→${item.to}: ${n.name}`,
        confidence: clamp(item.priority * 0.75),
      }));
    }
    case "query_graph": {
      const sub = await backends.graph.query(item.query, { budget: item.budget });
      return sub.nodes.map((n) => ({
        source: "graph" as const,
        ref: n.path ?? n.name,
        detail: n.summary ?? `${n.kind} ${n.name}`,
        confidence: clamp(item.priority * (n.centrality ?? 0.5)),
      }));
    }
    case "ov_find": {
      const found = await backends.context.find(item.query, { tier: item.tier, limit: item.limit });
      return found.resources.map((r) => ({
        source: "context" as const,
        ref: r.uri,
        detail: r.content.slice(0, 160),
        confidence: clamp(item.priority * (r.score ?? 0.6)),
      }));
    }
    case "mem_recall": {
      const mems = await backends.memory.recall({
        query: item.query,
        scope: backends.scope,
        limit: item.limit,
        ...(item.kinds ? { kinds: item.kinds } : {}),
      });
      return mems.map((m) => ({
        source: "memory" as const,
        ref: m.id,
        detail: `[${m.kind}] ${m.text}`,
        confidence: clamp(item.priority * Math.min(1, m.score)),
      }));
    }
  }
}

export async function handleItem(
  item: ChecklistItem,
  backends: RetrievalBackends,
  perItemTimeoutMs: number,
  now: () => number = () => Date.now(),
): Promise<ItemResult> {
  const started = now();
  try {
    const raced = await raceTimeout(resolveItem(item, backends), perItemTimeoutMs);
    if (raced.timedOut) {
      return { label: item.label, kind: item.kind, ok: false, timedOut: true, refs: [], latencyMs: now() - started };
    }
    return { label: item.label, kind: item.kind, ok: true, timedOut: false, refs: raced.value, latencyMs: now() - started };
  } catch {
    return { label: item.label, kind: item.kind, ok: false, timedOut: false, refs: [], latencyMs: now() - started };
  }
}
