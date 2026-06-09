import { describe, it, expect } from "vitest";
import {
  planBugHunt,
  synthesizeBugHunt,
  runBugHunt,
  BUG_HUNT_SCHEMA,
  DEFAULT_BUG_HUNT_CONFIG,
  type BugHuntFinding,
} from "../../../src/intelligence/patterns/bug-hunt";
import type { AgentBackend, AgentCall, AgentResult, AgentTaskKind } from "../../../src/agents/backend";
import type { KnowledgeGraph, ScoredFile } from "../../../src/backends/graph/types";
import type { MemoryStore, ScoredMemory } from "../../../src/backends/memory/types";
import type { Intent, OrchestrationResult } from "../../../src/intelligence/types";
import type { PromptResolver } from "../../../src/prompts/resolve";

// ---- fakes ---------------------------------------------------------------

const promptIntent = (prompt = "the cache returns stale users"): Intent => ({
  kind: "prompt",
  prompt,
  sessionId: "s1",
  transcriptPath: "/tmp/t.jsonl",
});

function fakeGraph(files: ScoredFile[]): KnowledgeGraph {
  return {
    id: "native",
    scoreFiles: async () => files,
    getNode: async () => null,
    getNeighbors: async () => ({ center: {} as never, nodes: [], edges: [], depth: 0 }),
    findPath: async () => null,
    query: async () => ({ nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false }),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
  } as unknown as KnowledgeGraph;
}

function fakeMemory(memories: ScoredMemory[]): MemoryStore {
  return { recall: async () => memories } as unknown as MemoryStore;
}

const fakePrompts: PromptResolver = { resolve: () => "BUG_HUNT_TASK_PROMPT" };

function backend(invoke: (call: AgentCall) => Promise<AgentResult>): AgentBackend {
  return {
    id: "anthropic-cli",
    invoke: invoke as AgentBackend["invoke"],
    release: async () => {},
    health: async () => ({ up: true }),
    ping: async () => true,
    shutdown: async () => {},
  };
}

const finding = (f: BugHuntFinding): AgentResult => ({
  ok: true,
  data: f,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 1, model: "m" },
  model: { providerKey: "default", model: "m" },
});

const scored = (path: string, score = 0.8): ScoredFile => ({ path, score, nodeId: `n:${path}` });

/** A file-relevance backend that returns a per-file finding from a map (defaults to implicated@0.9). */
function findingBackend(byFile: Record<string, BugHuntFinding>): (kind: AgentTaskKind) => AgentBackend {
  return () =>
    backend(async (call) => {
      const file = call.inputs?.files?.[0] ?? "";
      return finding(byFile[file] ?? { implicated: true, confidence: 0.9, lines: [{ start: 10, end: 20, why: "here" }] });
    });
}

// ---- (1) plan producer (pure) -------------------------------------------

describe("planBugHunt (pure plan producer)", () => {
  it("emits one read-only structured file-relevance task per candidate, capped at maxFiles", () => {
    const candidates = { files: [scored("a.ts"), scored("b.ts"), scored("c.ts")], memories: [] };
    const cfg = { ...DEFAULT_BUG_HUNT_CONFIG, maxFiles: 2 };
    const plan = planBugHunt(promptIntent("oops"), candidates, cfg, "TASK");

    expect(plan.tasks).toHaveLength(2); // capped
    expect(plan.tasks.map((t) => t.id)).toEqual(["a.ts", "b.ts"]);
    expect(plan.fanoutWidth).toBe(cfg.fanoutWidth);

    const call = plan.tasks[0]!.call;
    expect(call.taskKind).toBe("file-relevance");
    expect(call.tools).toBe("read-only"); // asserted tool posture
    expect(call.schema).toBe(BUG_HUNT_SCHEMA);
    expect(call.session).toBe("ephemeral");
    expect(call.task).toBe("TASK"); // stable prefix — no per-file text in the prompt
    expect(call.inputs?.files).toEqual(["a.ts"]); // the file rides in inputs, not the prompt
    expect(call.inputs?.reasoning).toBe("oops");
  });

  it("folds recalled mistakes into inputs.decisions when present", () => {
    const candidates = { files: [scored("a.ts")], memories: [{ text: "off-by-one here before" } as ScoredMemory] };
    const plan = planBugHunt(promptIntent(), candidates, DEFAULT_BUG_HUNT_CONFIG, "TASK");
    expect(plan.tasks[0]!.call.inputs?.decisions).toContain("off-by-one");
  });

  it("judge keeps only implicated findings at or above the confidence floor", () => {
    const plan = planBugHunt(promptIntent(), { files: [scored("a.ts")], memories: [] }, { ...DEFAULT_BUG_HUNT_CONFIG, confidenceFloor: 0.5 }, "TASK");
    const judge = plan.judge!;
    const mk = (id: string, f: BugHuntFinding, ok = true): { id: string; result: AgentResult } => ({
      id,
      result: ok ? finding(f) : ({ ...finding(f), ok: false } as AgentResult),
    });
    const kept = judge([
      mk("keep", { implicated: true, confidence: 0.9 }),
      mk("low", { implicated: true, confidence: 0.2 }),
      mk("not-impl", { implicated: false, confidence: 0.9 }),
      mk("failed", { implicated: true, confidence: 0.9 }, false),
    ] as never);
    expect(kept.map((k) => k.id)).toEqual(["keep"]);
  });
});

// ---- (3) synthesizer -----------------------------------------------------

describe("synthesizeBugHunt", () => {
  it("renders cited line spans under the IntelligentRouter tag", () => {
    const result: OrchestrationResult = {
      ok: true,
      tasks: [{ id: "src/cache.ts", result: finding({ implicated: true, confidence: 0.88, lines: [{ start: 42, end: 50, why: "TTL never checked" }] }) }],
      usage: { costUsd: 0, latencyMs: 0, calls: 1, succeeded: 1 },
    };
    const block = synthesizeBugHunt(result);
    expect(block).toContain("middle-management intelligent-router");
    expect(block).toContain("src/cache.ts");
    expect(block).toContain("lines 42-50");
    expect(block).toContain("TTL never checked");
  });

  it("is a no-op when nothing survived", () => {
    expect(synthesizeBugHunt({ ok: false, tasks: [], usage: { costUsd: 0, latencyMs: 0, calls: 0, succeeded: 0 } })).toBe("");
  });
});

// ---- (4) full orchestration (gather → plan → run → synthesize) ----------

describe("runBugHunt", () => {
  const baseDeps = {
    graph: fakeGraph([scored("src/cache.ts"), scored("src/user.ts")]),
    memory: fakeMemory([]),
    project: "proj",
    prompts: fakePrompts,
    routerRouter: false, // skip the triage gate in these tests (always SMART)
  };

  it("injects cited lines for implicated files", async () => {
    const deps = {
      ...baseDeps,
      forTask: findingBackend({
        "src/cache.ts": { implicated: true, confidence: 0.9, lines: [{ start: 5, end: 9, why: "stale read" }] },
        "src/user.ts": { implicated: false, confidence: 0.95 },
      }),
    };
    const block = await runBugHunt(promptIntent(), deps);
    expect(block).toContain("src/cache.ts");
    expect(block).toContain("lines 5-9");
    expect(block).toContain("stale read");
    expect(block).not.toContain("src/user.ts"); // not implicated → judged out
  });

  it("returns '' when the graph surfaces no candidates (fail-open, nothing injected)", async () => {
    const deps = { ...baseDeps, graph: fakeGraph([]), forTask: findingBackend({}) };
    expect(await runBugHunt(promptIntent(), deps)).toBe("");
  });

  it("returns '' (clean fail-open) when the backend throws", async () => {
    const deps = {
      ...baseDeps,
      forTask: (() => {
        throw new Error("backend exploded");
      }) as never,
    };
    expect(await runBugHunt(promptIntent(), deps)).toBe("");
  });

  it("returns '' when the router-router triages the moment as dumb", async () => {
    const triageBackend = (): AgentBackend =>
      backend(async () => ({
        ok: true,
        data: { dumb: true, reason: "just a greeting" },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, model: "m" },
        model: { providerKey: "default", model: "m" },
      }));
    const deps = { ...baseDeps, routerRouter: true, forTask: triageBackend };
    expect(await runBugHunt(promptIntent(), deps)).toBe("");
  });
});
