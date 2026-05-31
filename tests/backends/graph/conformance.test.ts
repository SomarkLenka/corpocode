// Conformance for the graphify adapter, run against an in-memory fake transport over a fixture
// graph. This exercises the adapter's parsing/ordering/null-handling — the logic that must behave
// identically when the planned native graph swaps in behind the same interface.
import { describe, it, expect } from "vitest";
import { createGraphifyAdapter } from "../../../src/backends/graph/graphify-adapter";
import type { GraphifyTransport } from "../../../src/backends/graph/graphify-transport";

interface FNode {
  id: string;
  name: string;
  kind: string;
  path?: string;
  centrality?: number;
}
interface FEdge {
  from: string;
  to: string;
  kind: string;
  confidence?: string;
}

const NODES: FNode[] = [
  { id: "f_retry", name: "retry.ts", kind: "file", path: "src/retry.ts", centrality: 0.9 },
  { id: "f_client", name: "client.ts", kind: "file", path: "src/client.ts", centrality: 0.7 },
  { id: "f_unrelated", name: "unrelated.ts", kind: "file", path: "src/unrelated.ts", centrality: 0.1 },
  { id: "fn_withRetry", name: "withRetry", kind: "function", path: "src/retry.ts" },
  { id: "fn_callApi", name: "callApi", kind: "function", path: "src/client.ts" },
];
const EDGES: FEdge[] = [
  { from: "fn_callApi", to: "fn_withRetry", kind: "calls", confidence: "extracted" },
  { from: "f_client", to: "f_retry", kind: "imports", confidence: "extracted" },
];

const nodeById = (id: string): FNode | undefined => NODES.find((n) => n.id === id);

function neighborsOf(id: string): { nodes: FNode[]; edges: FEdge[] } {
  const ids = new Set<string>();
  const edges: FEdge[] = [];
  for (const e of EDGES) {
    if (e.from === id) {
      ids.add(e.to);
      edges.push(e);
    }
    if (e.to === id) {
      ids.add(e.from);
      edges.push(e);
    }
  }
  return { nodes: [...ids].map(nodeById).filter((n): n is FNode => Boolean(n)), edges };
}

function bfsPath(from: string, to: string): string[] | null {
  if (!nodeById(from) || !nodeById(to)) return null;
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    if (last === to) return path;
    for (const nb of neighborsOf(last).nodes) {
      if (!seen.has(nb.id)) {
        seen.add(nb.id);
        queue.push([...path, nb.id]);
      }
    }
  }
  return null;
}

function makeFakeTransport(alive = true): GraphifyTransport {
  return {
    async callTool(name, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      if (name === "query_graph") {
        const tokens = String(args.query ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
        const matched = NODES.filter((n) =>
          tokens.some((t) => `${n.name} ${n.path ?? ""}`.toLowerCase().includes(t)),
        );
        const union = new Map<string, FNode>();
        for (const m of matched) {
          union.set(m.id, m);
          for (const nb of neighborsOf(m.id).nodes) union.set(nb.id, nb);
        }
        const nodes = [...union.values()];
        const budget = args.budget;
        const truncated = typeof budget === "number" && budget < nodes.length;
        return { nodes, edges: EDGES, truncated };
      }
      if (name === "get_node") {
        return NODES.find((n) => n.name === args.name) ?? {};
      }
      if (name === "get_neighbors") {
        const id = String(args.id ?? "");
        const { nodes, edges } = neighborsOf(id);
        return { center: nodeById(id) ?? {}, nodes, edges };
      }
      if (name === "shortest_path") {
        const path = bfsPath(String(args.from ?? ""), String(args.to ?? ""));
        if (!path) return {};
        const nodes = path.map(nodeById).filter((n): n is FNode => Boolean(n));
        const edges = EDGES.filter((e) => path.includes(e.from) && path.includes(e.to));
        return { nodes, edges };
      }
      return {};
    },
    async ping() {
      return alive;
    },
    async close() {},
  };
}

const adapter = (alive = true) =>
  createGraphifyAdapter({ repoRoot: "/repo", transport: makeFakeTransport(alive) });

describe("graphify adapter conformance", () => {
  it("scoreFiles is deterministic, centrality-ordered, and surfaces a related file not in the prompt", async () => {
    const g = adapter();
    const a = await g.scoreFiles("fix the retry logic", { limit: 5 });
    const b = await g.scoreFiles("fix the retry logic", { limit: 5 });
    expect(a).toEqual(b);
    const paths = a.map((f) => f.path);
    expect(paths[0]).toBe("src/retry.ts");
    expect(paths).toContain("src/client.ts"); // structurally related, never named in the prompt
    expect(paths).not.toContain("src/unrelated.ts");
    expect(a[0]!.score).toBeGreaterThanOrEqual(a[1]!.score);
  });

  it("scoreFiles respects the limit", async () => {
    expect(await adapter().scoreFiles("retry client", { limit: 1 })).toHaveLength(1);
  });

  it("getNode round-trips a known symbol and returns null for a miss", async () => {
    const g = adapter();
    const node = await g.getNode("withRetry");
    expect(node?.id).toBe("fn_withRetry");
    expect(node?.kind).toBe("function");
    expect(await g.getNode("doesNotExist")).toBeNull();
  });

  it("getNeighbors returns callers and filters by edge kind", async () => {
    const g = adapter();
    const n = await g.getNeighbors("fn_withRetry");
    expect(n.center.id).toBe("fn_withRetry");
    expect(n.nodes.map((x) => x.id)).toContain("fn_callApi");
    expect(n.edges.some((e) => e.kind === "calls")).toBe(true);
    const filtered = await g.getNeighbors("fn_withRetry", { edgeKinds: ["imports"] });
    expect(filtered.edges).toHaveLength(0);
  });

  it("findPath finds a known path and returns null for disconnected nodes", async () => {
    const g = adapter();
    const path = await g.findPath("f_client", "f_retry");
    expect(path?.length).toBe(1);
    expect(path?.nodes.map((n) => n.id)).toEqual(["f_client", "f_retry"]);
    expect(await g.findPath("f_unrelated", "f_retry")).toBeNull();
  });

  it("query respects the budget and sets truncated", async () => {
    const g = adapter();
    const small = await g.query("retry client", { budget: 1 });
    expect(small.truncated).toBe(true);
    expect(small.budgetTokens).toBe(1);
    const big = await g.query("retry client", { budget: 1000 });
    expect(big.truncated).toBe(false);
    expect(big.nodes.length).toBeGreaterThan(0);
  });

  it("ping reflects daemon health", async () => {
    expect(await adapter(true).ping()).toBe(true);
    expect(await adapter(false).ping()).toBe(false);
  });

  it("ensureBuilt builds when absent and skips when present", async () => {
    let built = 0;
    const g = createGraphifyAdapter({
      repoRoot: "/repo",
      transport: makeFakeTransport(),
      graphExists: () => false,
      runGraphify: async () => {
        built++;
      },
    });
    await g.ensureBuilt("/repo");
    expect(built).toBe(1);

    let skipped = 0;
    const g2 = createGraphifyAdapter({
      repoRoot: "/repo",
      transport: makeFakeTransport(),
      graphExists: () => true,
      runGraphify: async () => {
        skipped++;
      },
    });
    await g2.ensureBuilt("/repo");
    expect(skipped).toBe(0);
  });
});
