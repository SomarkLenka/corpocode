import { describe, it, expect } from "vitest";
import { gather } from "../../src/intelligence/gather";
import type { GatherDeps } from "../../src/intelligence/gather";
import type { KnowledgeGraph, NodeKind, ScoredFile, GraphNode } from "../../src/backends/graph/types";
import type { MemoryStore, ScoredMemory, RecallOptions } from "../../src/backends/memory/types";
import type { Intent } from "../../src/intelligence/types";

const scored = (path: string, score = 1): ScoredFile => ({ path, score, nodeId: path });
const mem = (text: string): ScoredMemory => ({ id: text, kind: "rule", text, createdAt: 0, score: 1 });
const node = (id: string, path?: string): GraphNode => ({ id, name: id, kind: "file" as NodeKind, path });

function fakeGraph(over: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    id: "fake",
    scoreFiles: async () => [],
    getNode: async () => null,
    getNeighbors: async () => ({ center: node(""), nodes: [], edges: [], depth: 1 }),
    findPath: async () => null,
    query: async () => ({ nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false }),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
    ...over,
  };
}

function fakeMemory(over: Partial<MemoryStore> = {}): MemoryStore {
  return {
    id: "fake",
    recall: async () => [],
    capture: async () => {},
    consolidate: async () => ({ captured: 0, superseded: 0 }),
    recordOutcome: async () => {},
    ping: async () => true,
    ...over,
  };
}

const deps = (graph: KnowledgeGraph, memory: MemoryStore): GatherDeps => ({ graph, memory, project: "p" });
const promptIntent: Intent = { kind: "prompt", prompt: "bug in auth", sessionId: "s", transcriptPath: "t" };
const writeIntent: Intent = { kind: "pre-write", file: "auth/session.ts", sessionId: "s", transcriptPath: "t" };

describe("gather — deterministic candidates", () => {
  it("scores files and recalls rules/mistakes for a prompt intent", async () => {
    let recallOpts: RecallOptions | undefined;
    const g = fakeGraph({ scoreFiles: async () => [scored("a.ts"), scored("b.ts")] });
    const m = fakeMemory({ recall: async (o) => { recallOpts = o; return [mem("don't touch X")]; } });

    const c = await gather(promptIntent, deps(g, m));

    expect(c.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(c.memories).toHaveLength(1);
    expect(recallOpts?.kinds).toEqual(["mistake", "rule"]);
    expect(recallOpts?.query).toBe("bug in auth");
    expect(c.nodes).toEqual([]); // prompt intents don't center on a node
  });

  it("centers on the file's node + neighborhood for a file-scoped intent", async () => {
    const center = node("n1", "auth/session.ts");
    const g = fakeGraph({
      getNode: async () => center,
      getNeighbors: async () => ({ center, nodes: [node("n2")], edges: [], depth: 1 }),
    });
    const c = await gather(writeIntent, deps(g, fakeMemory()));

    expect(c.nodes).toEqual([center]);
    expect(c.neighborhoods).toHaveLength(1);
    expect(c.files).toEqual([{ path: "auth/session.ts", score: 1, nodeId: "n1" }]);
  });

  it("is fail-open per source — a throwing graph degrades to empty, memory still returns", async () => {
    const g = fakeGraph({ scoreFiles: async () => { throw new Error("graph down"); } });
    const m = fakeMemory({ recall: async () => [mem("rule survives")] });

    const c = await gather(promptIntent, deps(g, m));

    expect(c.files).toEqual([]); // graph failure swallowed
    expect(c.memories.map((x) => x.text)).toEqual(["rule survives"]);
  });

  it("skips getNeighbors when the file has no graph node", async () => {
    let neighborsCalled = false;
    const g = fakeGraph({
      getNode: async () => null,
      getNeighbors: async () => { neighborsCalled = true; return { center: node(""), nodes: [], edges: [], depth: 1 }; },
    });
    const c = await gather(writeIntent, deps(g, fakeMemory()));

    expect(neighborsCalled).toBe(false);
    expect(c.nodes).toEqual([]);
    expect(c.neighborhoods).toEqual([]);
  });

  it("folds in an injected retrieval source when provided", async () => {
    const g = fakeGraph({ scoreFiles: async () => [scored("a.ts")] });
    const pkg = { block: "ctx", refs: [], itemsTotal: 1, itemsSucceeded: 1, tokensEstimate: 3 };
    const c = await gather(promptIntent, { ...deps(g, fakeMemory()), runRetrieval: async () => pkg });

    expect(c.retrieval).toBe(pkg);
  });
});
