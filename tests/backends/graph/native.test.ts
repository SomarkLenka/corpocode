// Native KnowledgeGraph conformance (Phase 5). Asserts the SAME interface behaviors the graphify
// adapter suite asserts — deterministic centrality-ordered scoring that surfaces a structurally related
// file, node/neighbor/path/query/ping semantics, ensureBuilt build-vs-skip — but over a real fixture the
// native graph PARSES, plus the two native-specific guarantees: an unsupported language degrades to an
// opaque node, and refresh re-parses only the changed files.
import { describe, it, expect } from "vitest";
import { createNativeGraph, type GraphStore } from "../../../src/backends/graph/native";
import { extractFile } from "../../../src/backends/graph/native/extract";
import type { NativeGraphData, SourceFile } from "../../../src/backends/graph/native/build";

const FIXTURE: SourceFile[] = [
  { path: "src/retry.ts", content: "export function withRetry(fn) {\n  return fn();\n}\n" },
  { path: "src/client.ts", content: 'import { withRetry } from "./retry";\nexport function callApi() {\n  return withRetry(doFetch);\n}\n' },
  { path: "src/unrelated.ts", content: "export function lonely() {\n  return 1;\n}\n" },
  { path: "src/notes.xyz", content: "this is an unsupported language file\n" },
];

function memStore(initiallyExists = false): GraphStore & { writes: number } {
  let saved: NativeGraphData | null = null;
  let present = initiallyExists;
  return {
    writes: 0,
    exists: () => present,
    read: () => saved,
    write(d) {
      saved = d;
      present = true;
      (this as { writes: number }).writes++;
    },
  };
}

const graph = (over: Partial<Parameters<typeof createNativeGraph>[0]> = {}) =>
  createNativeGraph({ repoRoot: "/repo", loadFiles: () => FIXTURE, store: memStore(), ...over });

describe("native knowledge graph conformance", () => {
  it("scoreFiles is deterministic, centrality-ordered, and surfaces a related file not in the prompt", async () => {
    const g = graph();
    const a = await g.scoreFiles("fix the retry logic", { limit: 5 });
    const b = await g.scoreFiles("fix the retry logic", { limit: 5 });
    expect(a).toEqual(b);
    const paths = a.map((f) => f.path);
    expect(paths[0]).toBe("src/retry.ts");
    expect(paths).toContain("src/client.ts"); // structurally related (imports + calls), never named
    expect(paths).not.toContain("src/unrelated.ts");
    expect(a[0]!.score).toBeGreaterThanOrEqual(a[1]!.score);
  });

  it("scoreFiles respects the limit", async () => {
    expect(await graph().scoreFiles("retry client", { limit: 1 })).toHaveLength(1);
  });

  it("getNode round-trips a known symbol and returns null for a miss", async () => {
    const g = graph();
    const node = await g.getNode("withRetry");
    expect(node?.kind).toBe("function");
    expect(node?.path).toBe("src/retry.ts");
    expect(await g.getNode("doesNotExist")).toBeNull();
  });

  it("getNeighbors returns callers and filters by edge kind", async () => {
    const g = graph();
    const withRetry = (await g.getNode("withRetry"))!;
    const callApi = (await g.getNode("callApi"))!;
    const n = await g.getNeighbors(withRetry.id);
    expect(n.center.id).toBe(withRetry.id);
    expect(n.nodes.map((x) => x.id)).toContain(callApi.id);
    expect(n.edges.some((e) => e.kind === "calls")).toBe(true);
    const filtered = await g.getNeighbors(withRetry.id, { edgeKinds: ["imports"] });
    expect(filtered.edges).toHaveLength(0);
  });

  it("findPath finds a known path and returns null for disconnected nodes", async () => {
    const g = graph();
    const client = (await g.getNode("client.ts"))!;
    const retry = (await g.getNode("retry.ts"))!;
    const unrelated = (await g.getNode("unrelated.ts"))!;
    const path = await g.findPath(client.id, retry.id);
    expect(path?.length).toBe(1);
    expect(path?.nodes.map((x) => x.id)).toEqual([client.id, retry.id]);
    expect(await g.findPath(unrelated.id, retry.id)).toBeNull();
  });

  it("query respects the budget and sets truncated", async () => {
    const g = graph();
    const small = await g.query("retry client", { budget: 1 });
    expect(small.truncated).toBe(true);
    expect(small.budgetTokens).toBe(1);
    const big = await g.query("retry client", { budget: 1000 });
    expect(big.truncated).toBe(false);
    expect(big.nodes.length).toBeGreaterThan(0);
  });

  it("ping is healthy for an in-process graph", async () => {
    expect(await graph().ping()).toBe(true);
  });

  it("ensureBuilt builds when absent and skips when present", async () => {
    let loads = 0;
    const load = () => {
      loads++;
      return FIXTURE;
    };
    await createNativeGraph({ repoRoot: "/r", loadFiles: load, store: memStore(false) }).ensureBuilt("/r");
    expect(loads).toBe(1);

    loads = 0;
    await createNativeGraph({ repoRoot: "/r", loadFiles: load, store: memStore(true) }).ensureBuilt("/r");
    expect(loads).toBe(0);
  });

  it("degrades an unsupported language to an opaque file node rather than erroring", async () => {
    const g = graph();
    const opaque = await g.getNode("notes.xyz");
    expect(opaque?.kind).toBe("file"); // present as a node...
    expect(opaque?.path).toBe("src/notes.xyz");
    // ...with no symbols extracted from it (no defines edges out of the opaque file).
    const neighbors = await g.getNeighbors(opaque!.id);
    expect(neighbors.nodes).toHaveLength(0);
  });

  it("refresh re-parses only the changed files (incremental)", async () => {
    const parsed: string[] = [];
    const parse = (path: string, content: string) => {
      parsed.push(path);
      return extractFile(path, content);
    };
    const g = createNativeGraph({ repoRoot: "/r", loadFiles: () => FIXTURE, parse, store: memStore() });
    await g.ensureBuilt("/r"); // cold build parses every file
    expect(parsed).toHaveLength(FIXTURE.length);

    parsed.length = 0;
    await g.refreshFiles(["src/retry.ts"]); // only the changed file re-parses; the rest hit the cache
    expect(parsed).toEqual(["src/retry.ts"]);
  });
});
