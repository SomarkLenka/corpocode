import { describe, it, expect } from "vitest";
import { runRetrieval, type RetrievalDeps } from "../../src/retrieval/worker";
import { aggregate } from "../../src/retrieval/aggregator";
import { defaultConfig } from "../../src/config/load";
import type { ItemResult } from "../../src/retrieval/types";
import type { KnowledgeGraph } from "../../src/backends/graph/types";
import type { ContextStore } from "../../src/backends/context/types";
import type { MemoryStore } from "../../src/backends/memory/types";
import type { Provider } from "../../src/providers/types";

const delay = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const provider: Provider = {
  id: "anthropic",
  model: "m",
  modelTier: "fast",
  chat: async () => {
    throw new Error("planner provider should not be called for a templated type");
  },
  ping: async () => true,
};

function fakeGraph(over: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    id: "graphify",
    scoreFiles: async () => [],
    getNode: async (name) =>
      delay({ id: `n_${name}`, name, kind: "file" as const, path: `src/${name}`, centrality: 0.8 }, 40),
    getNeighbors: async () => ({ center: { id: "c", name: "c", kind: "file" }, nodes: [], edges: [], depth: 1 }),
    findPath: async () => null,
    query: async (q) =>
      delay(
        {
          nodes: [{ id: "q1", name: "queryHit.ts", kind: "file" as const, path: "src/queryHit.ts", centrality: 0.5 }],
          edges: [],
          query: q,
          budgetTokens: 800,
          truncated: false,
        },
        40,
      ),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
    ...over,
  };
}

function fakeContext(over: Partial<ContextStore> = {}): ContextStore {
  return {
    id: "openviking",
    find: async (query) =>
      delay({ query, tier: "L0" as const, resources: [{ uri: "viking://r/1.md", kind: "resource" as const, tier: "L0" as const, content: "reference snippet", tokens: 5, score: 0.7 }] }, 40),
    load: async () => "",
    write: async () => {},
    tree: async () => [],
    grep: async () => [],
    start: async () => {},
    health: async () => ({ up: true }),
    ping: async () => true,
    ...over,
  };
}

function fakeMemory(over: Partial<MemoryStore> = {}): MemoryStore {
  return {
    id: "native",
    recall: async () =>
      delay([{ id: "m1", kind: "mistake" as const, text: "off-by-one in pager", createdAt: 1, score: 0.9 }], 40),
    capture: async () => {},
    consolidate: async () => ({ captured: 0, superseded: 0 }),
    recordOutcome: async () => {},
    ping: async () => true,
    ...over,
  };
}

function deps(over: Partial<RetrievalDeps> = {}): RetrievalDeps {
  const records: Array<Record<string, unknown>> = [];
  const base: RetrievalDeps = {
    provider,
    backends: {
      graph: fakeGraph(),
      context: fakeContext(),
      memory: fakeMemory(),
      scope: { project: "p", workspaceCascade: false },
    },
    config: defaultConfig().retrieval,
    logger: { enabled: true, log: (r: Record<string, unknown>) => records.push(r) },
    ...over,
  };
  return Object.assign(base, { _records: records }) as RetrievalDeps & { _records: typeof records };
}

const req = {
  sessionId: "s1",
  type: "code-edit",
  prompt: "fix the retry backoff",
  cues: { query: "retry backoff jitter", files: ["retry.ts"] },
};

describe("retrieval worker", () => {
  it("emits one retrieval_item per checklist item plus one summary; succeeded==items on the happy path", async () => {
    const d = deps() as RetrievalDeps & { _records: Array<Record<string, unknown>> };
    const pkg = await runRetrieval(req, d);
    const items = d._records.filter((r) => r.event === "retrieval_item");
    const summary = d._records.find((r) => r.event === "retrieval")!;
    // code-edit template → query_graph + mem_recall + ov_find + one get_node (for retry.ts) = 4
    expect(items).toHaveLength(4);
    expect(summary.checklist_items).toBe(4);
    expect(pkg.itemsSucceeded).toBe(4);
    expect(summary.items_succeeded).toBe(4);
  });

  it("folds line-of-thought terms into item queries (touches all three abstractions)", async () => {
    let graphQuery = "";
    let memQuery = "";
    const d = deps({
      backends: {
        graph: fakeGraph({
          query: async (q) => {
            graphQuery = q;
            return { nodes: [], edges: [], query: q, budgetTokens: 800, truncated: false };
          },
        }),
        context: fakeContext(),
        memory: fakeMemory({
          recall: async (o) => {
            memQuery = o.query ?? "";
            return [];
          },
        }),
        scope: { project: "p", workspaceCascade: false },
      },
    });
    await runRetrieval(req, d);
    expect(graphQuery).toContain("retry backoff jitter"); // the cue query, not just the prompt
    expect(memQuery).toContain("retry backoff jitter");
  });

  it("runs items in parallel — total latency approximates a single item, not the sum", async () => {
    const start = Date.now();
    await runRetrieval(req, deps());
    const elapsed = Date.now() - start;
    // 4 items at ~40ms each: parallel ≈ 40–80ms, serial would be ~160ms+.
    expect(elapsed).toBeLessThan(140);
  });

  it("drops only the affected item when a backend dies mid-run; the package still returns", async () => {
    const d = deps({
      backends: {
        graph: fakeGraph({
          query: async () => {
            throw new Error("graphify killed");
          },
        }),
        context: fakeContext(),
        memory: fakeMemory(),
        scope: { project: "p", workspaceCascade: false },
      },
    }) as RetrievalDeps & { _records: Array<Record<string, unknown>> };
    const pkg = await runRetrieval(req, d);
    const failed = d._records.filter((r) => r.event === "retrieval_item" && r.ok === false);
    expect(failed.length).toBeGreaterThanOrEqual(1); // the query_graph item failed
    expect(pkg.itemsSucceeded).toBeGreaterThanOrEqual(2); // ov_find + mem_recall still succeeded
    expect(pkg.refs.length).toBeGreaterThan(0); // package still has context
  });

  it("times out a hung item without sinking the others", async () => {
    const d = deps({
      // Between the fast items (~40ms) and the hung one (200ms): only query_graph should time out.
      config: { ...defaultConfig().retrieval, per_item_timeout_ms: 100 },
      backends: {
        graph: fakeGraph({ query: async (q) => delay({ nodes: [], edges: [], query: q, budgetTokens: 0, truncated: false }, 200) }),
        context: fakeContext(),
        memory: fakeMemory(),
        scope: { project: "p", workspaceCascade: false },
      },
    }) as RetrievalDeps & { _records: Array<Record<string, unknown>> };
    const pkg = await runRetrieval(req, d);
    const timedOut = d._records.filter((r) => r.event === "retrieval_item" && r.timed_out === true);
    expect(timedOut.length).toBe(1);
    expect(pkg.itemsSucceeded).toBeGreaterThanOrEqual(2);
  });

  it("aggregate dedupes by ref, ranks by confidence, and truncates to the token budget", () => {
    const results: ItemResult[] = [
      {
        label: "a",
        kind: "query_graph",
        ok: true,
        timedOut: false,
        latencyMs: 1,
        refs: [
          { source: "graph", ref: "src/a.ts", detail: "x".repeat(80), confidence: 0.9 },
          { source: "graph", ref: "src/a.ts", detail: "x".repeat(80), confidence: 0.4 }, // dup, lower conf
          { source: "context", ref: "viking://b", detail: "y".repeat(80), confidence: 0.8 },
          { source: "memory", ref: "m3", detail: "z".repeat(80), confidence: 0.7 },
        ],
      },
    ];
    const pkg = aggregate(results, { budgetTokens: 40 });
    // dup collapsed to the 0.9 sighting; budget keeps only the top few
    const aRef = pkg.refs.filter((r) => r.ref === "src/a.ts");
    expect(aRef).toHaveLength(1);
    expect(aRef[0]!.confidence).toBe(0.9);
    expect(pkg.refs.length).toBeLessThan(3); // budget truncated
    expect(pkg.tokensEstimate).toBeLessThanOrEqual(40 + 30); // within budget (+ at most one overflow ref)
  });
});
