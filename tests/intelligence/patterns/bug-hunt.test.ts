import { describe, it, expect } from "vitest";
import {
  BUG_SIGNAL,
  isBugLike,
  planBugHunt,
  synthesizeBugHunt,
  handleBugHunt,
  type BugHuntConfig,
} from "../../../src/intelligence/patterns/bug-hunt";
import type { Candidates } from "../../../src/intelligence/gather";
import type { Intent, OrchestrationResult, AgentTaskResult } from "../../../src/intelligence/types";
import type { AgentBackend, AgentCall, AgentResult } from "../../../src/agents/backend";
import type { CachedDecision } from "../../../src/session/decision-cache";
import type { HookContext } from "../../../src/hooks/context";
import type { UserPromptSubmitEnvelope } from "../../../src/hooks/envelope";
import type { HookResponse } from "../../../src/hooks/response";
import { composeUserPromptSubmit } from "../../../src/hooks/handlers";
import type { KnowledgeGraph, NodeKind, ScoredFile } from "../../../src/backends/graph/types";
import type { MemoryStore } from "../../../src/backends/memory/types";
import { defaultConfig } from "../../../src/config/load";

const CFG: BugHuntConfig = {
  maxFiles: 3,
  perAgentMs: 10_000,
  confidenceFloor: 0.5,
  maxInjectedTokens: 800,
  taskPrompt: "READ THE FILE AND DECIDE",
};

const promptIntent = (prompt: string): Intent => ({ kind: "prompt", prompt, sessionId: "s", transcriptPath: "/t" });

const candidates = (paths: string[]): Candidates => ({
  files: paths.map((path, i) => ({ path, score: 1 - i * 0.1, nodeId: path })),
  nodes: [],
  neighborhoods: [],
  memories: [],
});

/** A fake AgentResult carrying arbitrary structured data (what a file-relevance agent returns). */
const agentResult = (ok: boolean, data?: unknown): AgentResult => ({
  ok,
  data,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 1, model: "m" },
  model: { providerKey: "p", model: "m" },
  ...(ok ? {} : { error: { kind: "invalid_response" as const, message: "x", retryable: false } }),
});

const taskResult = (id: string, ok: boolean, data?: unknown): AgentTaskResult => ({ id, result: agentResult(ok, data) });

const orchestration = (tasks: AgentTaskResult[]): OrchestrationResult => ({
  ok: tasks.length > 0,
  tasks,
  usage: { costUsd: 0, latencyMs: 0, calls: tasks.length, succeeded: tasks.length },
});

describe("bug-hunt · BUG_SIGNAL", () => {
  it("matches bug vocabulary (whole word, case-insensitive) and phrases", () => {
    for (const p of ["it throws an Error", "the build is broken", "tests are failing", "not working", "unexpected output", "stack trace attached", "a regression"]) {
      expect(BUG_SIGNAL.test(p)).toBe(true);
    }
  });
  it("does not match ordinary feature prompts", () => {
    for (const p of ["add a new endpoint", "refactor the parser", "document the API", "erroneous is a substring but not a word"]) {
      expect(BUG_SIGNAL.test(p)).toBe(false);
    }
  });
});

describe("bug-hunt · isBugLike gate", () => {
  const fresh = (type: string): CachedDecision => ({
    type,
    complexity: "medium",
    breakpoint: false,
    dispatch_retrieval: false,
    effort: "medium",
    recalledIds: [],
    ts: 100,
  });

  it("fires on a bug-shaped code-edit/exploration moment written this turn", () => {
    expect(isBugLike("the API throws a 500", fresh("code-edit"), 50)).toBe(true);
    expect(isBugLike("why does login fail", fresh("exploration"), 50)).toBe(true);
  });
  it("skips when there is no decision", () => {
    expect(isBugLike("it crashes", null, 50)).toBe(false);
  });
  it("skips a stale decision from a prior turn (ts < turnStartedAt)", () => {
    expect(isBugLike("it crashes", fresh("code-edit"), 200)).toBe(false); // ts:100 < 200
  });
  it("skips non-edit/exploration moment types even when bug words appear", () => {
    expect(isBugLike("the docs mention an error", fresh("docs"), 50)).toBe(false);
    expect(isBugLike("config error", fresh("config"), 50)).toBe(false);
  });
  it("skips a bug-typed moment with no bug vocabulary in the prompt", () => {
    expect(isBugLike("add a retry to the client", fresh("code-edit"), 50)).toBe(false);
  });
});

describe("bug-hunt · planBugHunt", () => {
  it("emits one read-only ephemeral file-relevance task per top-N candidate file", () => {
    const plan = planBugHunt(promptIntent("it throws"), candidates(["a.ts", "b.ts", "c.ts", "d.ts"]), CFG);
    expect(plan.tasks.map((t) => t.id)).toEqual(["a.ts", "b.ts", "c.ts"]); // capped at maxFiles=3
    expect(plan.fanoutWidth).toBe(3);
    for (const t of plan.tasks) {
      expect(t.call.taskKind).toBe("file-relevance");
      expect(t.call.tools).toBe("read-only");
      expect(t.call.session).toBe("ephemeral");
      expect(t.call.effort).toBe("minimal");
      expect(t.call.timeoutMs).toBe(10_000);
      expect(t.call.task).toBe(CFG.taskPrompt);
      expect(t.call.inputs?.files).toEqual([t.id]); // the path only — never contents
      expect(t.call.inputs?.reasoning).toBe("it throws"); // the bug prompt
      expect(t.call.schema).toBeDefined();
    }
  });

  it("produces an empty plan when there are no candidate files", () => {
    const plan = planBugHunt(promptIntent("it throws"), candidates([]), CFG);
    expect(plan.tasks).toEqual([]);
  });

  it("judge keeps only ok + implicated + at-or-above-confidence-floor results, validating shape", () => {
    const plan = planBugHunt(promptIntent("it throws"), candidates(["a.ts"]), CFG);
    const judged = plan.judge!([
      taskResult("keep", true, { implicated: true, confidence: 0.8, lines: [{ start: 1, end: 3, why: "here" }] }),
      taskResult("not-implicated", true, { implicated: false, confidence: 0.9 }),
      taskResult("low-conf", true, { implicated: true, confidence: 0.2 }),
      taskResult("errored", false, { implicated: true, confidence: 0.9 }),
      taskResult("bad-shape", true, { implicated: "yes", confidence: 0.9 }), // implicated not a boolean
      taskResult("no-data", true, undefined),
    ]);
    expect(judged.map((t) => t.id)).toEqual(["keep"]);
  });
});

describe("bug-hunt · synthesizeBugHunt", () => {
  it("renders cited lines per file under the intelligent-router tag", () => {
    const out = synthesizeBugHunt(
      orchestration([
        taskResult("auth/session.ts", true, {
          implicated: true,
          confidence: 0.9,
          lines: [{ start: 140, end: 158, why: "TTL compared before clock skew" }],
        }),
      ]),
      800,
    );
    expect(out).toContain("middle-management intelligent-router");
    expect(out).toContain("auth/session.ts");
    expect(out).toContain("140");
    expect(out).toContain("TTL compared before clock skew");
    expect(out).not.toMatch(/<[a-z]+>[^<]*<\/[a-z]+>/); // no HTML markup, only the wrapping tag
  });

  it("returns empty string when nothing survived (no-op injection)", () => {
    expect(synthesizeBugHunt(orchestration([]), 800)).toBe("");
  });

  it("respects the injected-token budget, dropping lowest-confidence files first", () => {
    const long = (n: number, why: string) => taskResult(`f${n}.ts`, true, { implicated: true, confidence: n / 10, lines: [{ start: 1, end: 2, why }] });
    const big = "x".repeat(4000); // ~1000 tokens each at length/4
    const out = synthesizeBugHunt(orchestration([long(3, big), long(9, big)]), 300);
    expect(out).toContain("f9.ts"); // highest confidence kept
    expect(out).not.toContain("f3.ts"); // lowest confidence dropped to fit the budget
  });
});

// ── Handler adapter (§4.5): gather → plan → engine.run (deadline-raced) → synthesize ────────────────

const fakeBackend = (invoke: (call: AgentCall) => Promise<AgentResult>): AgentBackend => ({
  id: "anthropic-cli",
  invoke: invoke as AgentBackend["invoke"],
  release: async () => {},
  health: async () => ({ up: true }),
  ping: async () => true,
  shutdown: async () => {},
});

interface HandlerCtxOpts {
  scoreFiles?: KnowledgeGraph["scoreFiles"];
  invoke?: (call: AgentCall) => Promise<AgentResult>;
  withAgents?: boolean; // default true
}

function makeHandlerCtx(opts: HandlerCtxOpts = {}) {
  const records: Array<Record<string, unknown>> = [];
  const graph: KnowledgeGraph = {
    id: "graphify",
    scoreFiles: opts.scoreFiles ?? (async () => []),
    getNode: async () => null,
    getNeighbors: async () => ({ center: { id: "", name: "", kind: "file" as NodeKind }, nodes: [], edges: [], depth: 1 }),
    findPath: async () => null,
    query: async () => ({ nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false }),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
  };
  const memory: MemoryStore = {
    id: "native",
    recall: async () => [],
    capture: async () => {},
    consolidate: async () => ({ captured: 0, superseded: 0 }),
    recordOutcome: async () => {},
    ping: async () => true,
  };
  const backend = fakeBackend(opts.invoke ?? (async () => agentResult(true, { implicated: true, confidence: 0.9 })));
  const config = defaultConfig();
  const ctx = {
    config,
    env: {},
    repoRoot: "/repo",
    project: "proj",
    platform: "claude-code",
    logger: { enabled: true, log: (r: unknown) => records.push(r as Record<string, unknown>) },
    registry: { forComponent: () => ({}), all: () => [], availableFor: () => true },
    prompts: { resolve: (id: string) => id },
    graph,
    context: {},
    memory,
    sessionReader: { lineOfThought: async () => ({ intent: "", openQuestions: [], recentDecisions: [], entities: [] }), filePurpose: async () => null, retrievalCues: async () => ({ query: "", files: [] }) },
    plugins: { plugins: [], templates: [], tenets: [] },
    ...((opts.withAgents ?? true) ? { agents: { forTask: () => backend, all: () => [backend], availableFor: () => true } } : {}),
  } as unknown as HookContext;
  return { ctx, records, config };
}

const upsEnv = (prompt: string): UserPromptSubmitEnvelope =>
  ({ session_id: "s", transcript_path: "/t", cwd: "/repo", prompt }) as unknown as UserPromptSubmitEnvelope;

const freshDecision = (type: string): CachedDecision => ({
  type,
  complexity: "medium",
  breakpoint: false,
  dispatch_retrieval: false,
  effort: "medium",
  recalledIds: [],
  ts: 100,
});

describe("bug-hunt · handleBugHunt", () => {
  it("injects cited lines and logs a 'ran' pattern event when a file is implicated", async () => {
    const files: ScoredFile[] = [{ path: "auth/session.ts", score: 0.9, nodeId: "sess" }];
    const { ctx, records } = makeHandlerCtx({
      scoreFiles: async () => files,
      invoke: async () => agentResult(true, { implicated: true, confidence: 0.9, lines: [{ start: 140, end: 158, why: "TTL before skew" }] }),
    });
    const res = await handleBugHunt(upsEnv("login throws an error"), ctx, freshDecision("code-edit"));
    expect(res.hookEventName).toBe("UserPromptSubmit");
    expect(res.additionalContext).toContain("middle-management intelligent-router");
    expect(res.additionalContext).toContain("auth/session.ts");
    expect(res.additionalContext).toContain("140");
    const ev = records.find((r) => r.event === "pattern")!;
    expect(ev).toMatchObject({ pattern: "bug-hunt", surface: "UserPromptSubmit", decision: "ran", survivors: 1 });
  });

  it("is fail-open: a throwing backend yields a clean empty response, never a throw", async () => {
    const { ctx } = makeHandlerCtx({
      scoreFiles: async () => [{ path: "a.ts", score: 0.9, nodeId: "a" }],
      invoke: async () => {
        throw new Error("backend exploded");
      },
    });
    const res = await handleBugHunt(upsEnv("it crashes"), ctx, freshDecision("code-edit"));
    expect(res.additionalContext).toBeUndefined(); // nothing survived → no injection, no crash
  });

  it("injects only survivors when one agent fails (per-agent timeout modeled as ok:false)", async () => {
    const files: ScoredFile[] = [{ path: "fast.ts", score: 0.9, nodeId: "f" }, { path: "slow.ts", score: 0.8, nodeId: "s" }];
    const { ctx } = makeHandlerCtx({
      scoreFiles: async () => files,
      invoke: async (c) =>
        c.inputs?.files?.[0] === "fast.ts"
          ? agentResult(true, { implicated: true, confidence: 0.9, lines: [{ start: 1, end: 2, why: "here" }] })
          : agentResult(false), // timed out / errored — dropped fail-open
    });
    const res = await handleBugHunt(upsEnv("it fails intermittently"), ctx, freshDecision("code-edit"));
    expect(res.additionalContext).toContain("fast.ts");
    expect(res.additionalContext).not.toContain("slow.ts");
  });

  it("hits the deadline backstop: nothing injected, event reason 'deadline'", async () => {
    const { ctx, records, config } = makeHandlerCtx({
      scoreFiles: async () => [{ path: "a.ts", score: 0.9, nodeId: "a" }],
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return agentResult(true, { implicated: true, confidence: 0.9 });
      },
    });
    config.agents.bug_hunt.deadline_ms = 5; // fire the backstop before the agent returns
    const res = await handleBugHunt(upsEnv("it throws"), ctx, freshDecision("code-edit"));
    expect(res.additionalContext).toBeUndefined();
    const ev = records.find((r) => r.event === "pattern")!;
    expect(ev.reason).toBe("deadline");
  });

  it("logs 'empty-candidates' and injects nothing when the graph scores no files", async () => {
    const { ctx, records } = makeHandlerCtx({ scoreFiles: async () => [] });
    const res = await handleBugHunt(upsEnv("it errors out"), ctx, freshDecision("exploration"));
    expect(res.additionalContext).toBeUndefined();
    const ev = records.find((r) => r.event === "pattern")!;
    expect(ev).toMatchObject({ reason: "empty-candidates", files_fanned: 0 });
  });
});

// ── Composition (§4.6): wrap the base UserPromptSubmit handler with the gated bug-hunt pass ───────────

const baseResponse = (additionalContext: string): HookResponse => ({ hookEventName: "UserPromptSubmit", additionalContext });

describe("bug-hunt · composeUserPromptSubmit + mergeContext", () => {
  it("is byte-identical to the base handler when agents are off (flag-off parity)", async () => {
    const { ctx, records } = makeHandlerCtx({ withAgents: false });
    const base = async () => baseResponse("<middle-management recommendation>\nREC\n</middle-management recommendation>");
    const runBugHunt = async () => baseResponse("SHOULD-NOT-RUN");
    const handler = composeUserPromptSubmit({ base, runBugHunt, readDecision: () => freshDecision("code-edit"), now: () => 50 });
    const res = await handler(upsEnv("it throws an error"), ctx);
    expect(res).toEqual(await base());
    expect(records.find((r) => r.event === "pattern")).toBeUndefined(); // nothing logged, nothing ran
  });

  it("skips (no fan-out) and logs reason 'gate:not-bug-like' on a fresh non-bug moment", async () => {
    const { ctx, records } = makeHandlerCtx();
    let ran = false;
    const base = async () => baseResponse("REC");
    const runBugHunt = async () => {
      ran = true;
      return baseResponse("HUNT");
    };
    const handler = composeUserPromptSubmit({ base, runBugHunt, readDecision: () => freshDecision("code-edit"), now: () => 50 });
    const res = await handler(upsEnv("add a new endpoint"), ctx); // no bug vocabulary
    expect(res).toEqual(await base());
    expect(ran).toBe(false);
    expect(records.find((r) => r.event === "pattern")).toMatchObject({ decision: "skipped", reason: "gate:not-bug-like" });
  });

  it("skips with reason 'gate:no-fresh-decision' when the cached decision predates the turn", async () => {
    const { ctx, records } = makeHandlerCtx();
    const stale = { ...freshDecision("code-edit"), ts: 10 };
    const handler = composeUserPromptSubmit({ base: async () => baseResponse("REC"), runBugHunt: async () => baseResponse("HUNT"), readDecision: () => stale, now: () => 50 });
    const res = await handler(upsEnv("it throws an error"), ctx);
    expect(res.additionalContext).toBe("REC");
    expect(records.find((r) => r.event === "pattern")).toMatchObject({ decision: "skipped", reason: "gate:no-fresh-decision" });
  });

  it("runs bug-hunt and appends its block to the base additionalContext on a bug moment", async () => {
    const { ctx } = makeHandlerCtx();
    const base = async () => baseResponse("REC");
    const runBugHunt = async () => baseResponse("<middle-management intelligent-router>\nHUNT\n</middle-management intelligent-router>");
    const handler = composeUserPromptSubmit({ base, runBugHunt, readDecision: () => freshDecision("code-edit"), now: () => 50 });
    const res = await handler(upsEnv("login throws an error"), ctx);
    expect(res.additionalContext).toContain("REC");
    expect(res.additionalContext).toContain("HUNT");
    expect(res.additionalContext!.indexOf("REC")).toBeLessThan(res.additionalContext!.indexOf("HUNT")); // base first
    expect(res.hookEventName).toBe("UserPromptSubmit");
  });

  it("does not run bug-hunt when the per-pattern switch is off", async () => {
    const { ctx, config } = makeHandlerCtx();
    config.agents.bug_hunt.enabled = false;
    let ran = false;
    const handler = composeUserPromptSubmit({
      base: async () => baseResponse("REC"),
      runBugHunt: async () => {
        ran = true;
        return baseResponse("HUNT");
      },
      readDecision: () => freshDecision("code-edit"),
      now: () => 50,
    });
    const res = await handler(upsEnv("it throws an error"), ctx);
    expect(res.additionalContext).toBe("REC");
    expect(ran).toBe(false);
  });
});
