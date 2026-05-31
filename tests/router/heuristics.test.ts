import { describe, it, expect } from "vitest";
import { isTrivialPrompt, stageOne } from "../../src/router/heuristics";
import type { KnowledgeGraph, NodeKind } from "../../src/backends/graph/types";
import type { ThoughtState } from "../../src/session/types";

const emptyThought: ThoughtState = { intent: "", openQuestions: [], recentDecisions: [], entities: [] };
const cfg = { heuristic_candidate_limit_files: 10, trivial_early_exit: true };

function fakeGraph(over: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    id: "graphify",
    scoreFiles: async () => [],
    getNode: async () => null,
    getNeighbors: async () => ({
      center: { id: "", name: "", kind: "file" as NodeKind },
      nodes: [],
      edges: [],
      depth: 1,
    }),
    findPath: async () => null,
    query: async () => ({ nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false }),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
    ...over,
  };
}

describe("stage one heuristics", () => {
  it("flags trivial prompts and passes substantial ones", () => {
    expect(isTrivialPrompt("hi")).toBe(true);
    expect(isTrivialPrompt("what is 2+2")).toBe(true);
    expect(isTrivialPrompt("thanks")).toBe(true);
    expect(isTrivialPrompt("implement JWT auth in the login flow")).toBe(false);
  });

  it("early-exits on a trivial prompt", async () => {
    const r = await stageOne("hi", emptyThought, { graph: fakeGraph(), repoRoot: "/r" }, cfg);
    expect(r.trivial).toBe(true);
    expect(r.candidates).toEqual([]);
  });

  it("uses graph.scoreFiles and folds in the line of thought", async () => {
    let receivedQuery = "";
    const graph = fakeGraph({
      scoreFiles: async (q) => {
        receivedQuery = q;
        return [{ path: "src/auth.ts", score: 0.9, nodeId: "a" }];
      },
    });
    const thought: ThoughtState = { ...emptyThought, intent: "refactor login", entities: ["session.ts"] };
    const r = await stageOne("fix the bug", thought, { graph, repoRoot: "/r" }, cfg);
    expect(r.trivial).toBe(false);
    expect(r.usedFallback).toBe(false);
    expect(r.candidates[0]!.path).toBe("src/auth.ts");
    expect(receivedQuery).toContain("refactor login");
    expect(receivedQuery).toContain("session.ts");
  });

  it("falls back to string overlap when the graph is unavailable", async () => {
    const graph = fakeGraph({
      scoreFiles: async () => {
        throw new Error("graph not built");
      },
    });
    const listFiles = (): string[] => ["src/payment.ts", "src/user.ts", "README.md"];
    const r = await stageOne("fix the payment bug", emptyThought, { graph, repoRoot: "/r", listFiles }, cfg);
    expect(r.usedFallback).toBe(true);
    expect(r.candidates.map((c) => c.path)).toContain("src/payment.ts");
    expect(r.candidates.map((c) => c.path)).not.toContain("src/user.ts");
  });
});
