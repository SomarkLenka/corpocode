import { describe, it, expect } from "vitest";
import {
  GUIDANCE_SCHEMA,
  isWriteTool,
  extractPreWriteTarget,
  planPreWrite,
  synthesizePreWriteGuidance,
  handlePreWrite,
  type PreWriteConfig,
} from "../../../src/intelligence/patterns/pre-write";
import type { Candidates } from "../../../src/intelligence/gather";
import type { Intent, OrchestrationResult, AgentTaskResult } from "../../../src/intelligence/types";
import type { AgentBackend, AgentCall, AgentResult } from "../../../src/agents/backend";
import type { HookContext } from "../../../src/hooks/context";
import type { PreToolUseEnvelope } from "../../../src/hooks/envelope";
import type { HookResponse } from "../../../src/hooks/response";
import { composePreToolUse } from "../../../src/hooks/handlers";
import type { GraphNode, KnowledgeGraph, NodeKind } from "../../../src/backends/graph/types";
import type { MemoryStore, ScoredMemory } from "../../../src/backends/memory/types";
import { defaultConfig } from "../../../src/config/load";
import { BUILTIN_PROMPTS, isPromptId } from "../../../src/prompts/registry";
import { PROMPT_META } from "../../../src/prompts/catalog";

const CFG: PreWriteConfig = {
  maxFiles: 4,
  perAgentMs: 10_000,
  maxInjectedTokens: 800,
  maxProposedChars: 2000,
  taskPrompt: "WARN ABOUT BREAKAGE",
};

const preWriteIntent = (file: string, proposedContent?: string): Intent => ({
  kind: "pre-write",
  file,
  proposedContent,
  sessionId: "s",
  transcriptPath: "/t",
});

const fileNode = (path: string): GraphNode => ({ id: path, name: path, kind: "file" as NodeKind, path });

/** File-scoped candidates as gather() shapes them: the target's node + a neighborhood of related files. */
const fileCandidates = (target: string, neighborPaths: string[]): Candidates => ({
  files: [{ path: target, score: 1, nodeId: target }],
  nodes: [fileNode(target)],
  neighborhoods: [{ center: fileNode(target), nodes: neighborPaths.map(fileNode), edges: [], depth: 1 }],
  memories: [],
});

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

const warning = (severity: "info" | "warn" | "block", claim: string, refs?: string[]) => ({ claim, severity, ...(refs ? { refs } : {}) });

describe("pre-write · config slice", () => {
  it("defaults agents.pre_write per the spec (§6)", () => {
    expect(defaultConfig().agents.pre_write).toEqual({
      enabled: true,
      max_files: 4,
      per_agent_ms: 10_000,
      deadline_ms: 15_000,
      max_injected_tokens: 800,
      max_proposed_chars: 2000,
    });
  });
});

describe("pre-write · prompt registration", () => {
  it("registers pre-write-guidance in the registry and catalog", () => {
    expect(isPromptId("pre-write-guidance")).toBe(true);
    expect(BUILTIN_PROMPTS["pre-write-guidance"]).toContain("JSON");
    expect(PROMPT_META["pre-write-guidance"].path).toBe("intelligence/pre-write-guidance.md");
  });
});

describe("pre-write · isWriteTool", () => {
  it("recognizes exactly Write/Edit/MultiEdit", () => {
    for (const t of ["Write", "Edit", "MultiEdit"]) expect(isWriteTool(t)).toBe(true);
    for (const t of ["Bash", "Read", "Glob", "WebFetch", "write"]) expect(isWriteTool(t)).toBe(false);
  });
});

describe("pre-write · extractPreWriteTarget (§7.9)", () => {
  it("pulls content from a Write", () => {
    expect(extractPreWriteTarget("Write", { file_path: "a.ts", content: "NEW BODY" }, 2000)).toEqual({
      file: "a.ts",
      proposedContent: "NEW BODY",
    });
  });

  it("pulls new_string from an Edit", () => {
    expect(extractPreWriteTarget("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, 2000)).toEqual({
      file: "a.ts",
      proposedContent: "y",
    });
  });

  it("joins edits[].new_string from a MultiEdit", () => {
    const target = extractPreWriteTarget(
      "MultiEdit",
      { file_path: "a.ts", edits: [{ old_string: "a", new_string: "one" }, { old_string: "b", new_string: "two" }] },
      2000,
    );
    expect(target?.file).toBe("a.ts");
    expect(target?.proposedContent).toContain("one");
    expect(target?.proposedContent).toContain("two");
  });

  it("caps proposed content at maxProposedChars", () => {
    const content = `HEAD${"x".repeat(2500)}TAIL`;
    const target = extractPreWriteTarget("Write", { file_path: "a.ts", content }, 2000);
    expect(target?.proposedContent?.length).toBe(2000);
    expect(target?.proposedContent).toContain("HEAD");
    expect(target?.proposedContent).not.toContain("TAIL");
  });

  it("returns null for non-write tools and for a missing/non-string file_path", () => {
    expect(extractPreWriteTarget("Bash", { command: "ls" }, 2000)).toBeNull();
    expect(extractPreWriteTarget("Write", { content: "x" }, 2000)).toBeNull();
    expect(extractPreWriteTarget("Write", { file_path: 42, content: "x" }, 2000)).toBeNull();
  });

  it("tolerates malformed tool_input defensively (no proposed content, file still extracted)", () => {
    expect(extractPreWriteTarget("MultiEdit", { file_path: "a.ts", edits: "not-an-array" }, 2000)).toEqual({ file: "a.ts" });
    expect(extractPreWriteTarget("Edit", { file_path: "a.ts", new_string: 7 }, 2000)).toEqual({ file: "a.ts" });
  });
});

describe("pre-write · planPreWrite", () => {
  it("emits ONE read-only ephemeral pre-write-guidance task over the target + neighbor paths (§4.3, §7.10)", () => {
    const plan = planPreWrite(preWriteIntent("src/a.ts", "new body"), fileCandidates("src/a.ts", ["b.ts", "c.ts"]), CFG);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.fanoutWidth).toBe(1);
    const t = plan.tasks[0]!;
    expect(t.id).toBe("src/a.ts");
    expect(t.call.taskKind).toBe("pre-write-guidance");
    expect(t.call.tools).toBe("read-only");
    expect(t.call.session).toBe("ephemeral");
    expect(t.call.effort).toBe("minimal");
    expect(t.call.timeoutMs).toBe(10_000);
    expect(t.call.task).toBe(CFG.taskPrompt);
    expect(t.call.schema).toBe(GUIDANCE_SCHEMA);
    expect(t.call.inputs?.files).toEqual(["src/a.ts", "b.ts", "c.ts"]); // paths only — the agent reads them
    expect(t.call.inputs?.reasoning).toContain("src/a.ts");
    expect(t.call.inputs?.reasoning).toContain("new body"); // the one thing not on disk rides inline
  });

  it("caps neighbor paths at maxFiles and excludes the target from its own neighbor list", () => {
    const neighbors = ["src/a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]; // includes the target itself
    const plan = planPreWrite(preWriteIntent("src/a.ts"), fileCandidates("src/a.ts", neighbors), CFG);
    expect(plan.tasks[0]!.call.inputs?.files).toEqual(["src/a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]); // target + 4
  });

  it("caps inline proposed content at maxProposedChars in the reasoning (§4.3)", () => {
    const content = `HEAD${"x".repeat(2500)}TAIL`;
    const plan = planPreWrite(preWriteIntent("a.ts", content), fileCandidates("a.ts", []), CFG);
    expect(plan.tasks[0]!.call.inputs?.reasoning).toContain("HEAD");
    expect(plan.tasks[0]!.call.inputs?.reasoning).not.toContain("TAIL");
  });

  it("judge keeps only ok results whose warnings are a non-empty array of shape-valid entries (§7.8)", () => {
    const plan = planPreWrite(preWriteIntent("a.ts"), fileCandidates("a.ts", []), CFG);
    const judged = plan.judge!([
      taskResult("keep", true, { warnings: [warning("warn", "caller assumes cents", ["billing/charge.ts:88"])] }),
      taskResult("empty", true, { warnings: [] }),
      taskResult("bad-entry", true, { warnings: [{ claim: 42, severity: "warn" }] }),
      taskResult("bad-severity", true, { warnings: [{ claim: "x", severity: "fatal" }] }),
      taskResult("not-array", true, { warnings: "lots" }),
      taskResult("errored", false, { warnings: [warning("block", "x")] }),
      taskResult("no-data", true, undefined),
    ]);
    expect(judged.map((t) => t.id)).toEqual(["keep"]);
  });
});

describe("pre-write · synthesizePreWriteGuidance", () => {
  it("renders warnings under the intelligent-router tag, highest severity first, with refs (§4.5)", () => {
    const out = synthesizePreWriteGuidance(
      orchestration([
        taskResult("src/auth.ts", true, {
          warnings: [
            warning("info", "minor note"),
            warning("block", "charge.ts caller assumes cents", ["billing/charge.ts:88"]),
            warning("warn", "session TTL contract"),
          ],
        }),
      ]),
      800,
    );
    expect(out).toContain("middle-management intelligent-router");
    expect(out).toContain("Pre-write guidance for src/auth.ts");
    expect(out).toContain("(refs: billing/charge.ts:88)");
    const iBlock = out.indexOf("[block]");
    const iWarn = out.indexOf("[warn]");
    const iInfo = out.indexOf("[info]");
    expect(iBlock).toBeGreaterThan(-1);
    expect(iBlock).toBeLessThan(iWarn);
    expect(iWarn).toBeLessThan(iInfo);
    expect(out).not.toMatch(/<[a-z]+>[^<]*<\/[a-z]+>/); // structure only — no HTML markup
  });

  it("returns empty string when nothing survived (no-op injection)", () => {
    expect(synthesizePreWriteGuidance(orchestration([]), 800)).toBe("");
  });

  it("truncates to the token budget dropping lowest-severity first; the top warning is always kept", () => {
    const big = "x".repeat(4000); // ~1000 tokens each at length/4
    const out = synthesizePreWriteGuidance(
      orchestration([taskResult("a.ts", true, { warnings: [warning("info", `INFO ${big}`), warning("block", `BLOCK ${big}`)] })]),
      300,
    );
    expect(out).toContain("BLOCK"); // top severity kept even though it alone exceeds the budget
    expect(out).not.toContain("INFO"); // lowest severity dropped to fit
  });
});

// ── Handler adapter (§4.6): extract → gather → gate → plan → run (deadline-raced) → synthesize ───────

const fakeBackend = (invoke: (call: AgentCall) => Promise<AgentResult>): AgentBackend => ({
  id: "anthropic-cli",
  invoke: invoke as AgentBackend["invoke"],
  release: async () => {},
  health: async () => ({ up: true }),
  ping: async () => true,
  shutdown: async () => {},
});

interface HandlerCtxOpts {
  getNode?: KnowledgeGraph["getNode"];
  getNeighbors?: KnowledgeGraph["getNeighbors"];
  recall?: () => Promise<ScoredMemory[]>;
  invoke?: (call: AgentCall) => Promise<AgentResult>;
  withAgents?: boolean; // default true
}

function makeHandlerCtx(opts: HandlerCtxOpts = {}) {
  const records: Array<Record<string, unknown>> = [];
  const graph: KnowledgeGraph = {
    id: "graphify",
    scoreFiles: async () => [],
    getNode: opts.getNode ?? (async () => null),
    getNeighbors:
      opts.getNeighbors ?? (async () => ({ center: { id: "", name: "", kind: "file" as NodeKind }, nodes: [], edges: [], depth: 1 })),
    findPath: async () => null,
    query: async () => ({ nodes: [], edges: [], query: "", budgetTokens: 0, truncated: false }),
    ensureBuilt: async () => {},
    refresh: async () => {},
    ping: async () => true,
  };
  const memory: MemoryStore = {
    id: "native",
    recall: opts.recall ?? (async () => []),
    capture: async () => {},
    consolidate: async () => ({ captured: 0, superseded: 0 }),
    recordOutcome: async () => {},
    ping: async () => true,
  };
  const backend = fakeBackend(opts.invoke ?? (async () => agentResult(true, { warnings: [warning("warn", "default warning")] })));
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

const ptuEnv = (tool_name: string, tool_input: Record<string, unknown>): PreToolUseEnvelope =>
  ({ session_id: "s", transcript_path: "/t", cwd: "/repo", tool_name, tool_input }) as unknown as PreToolUseEnvelope;

const writeEnv = (file = "src/a.ts"): PreToolUseEnvelope => ptuEnv("Write", { file_path: file, content: "new body" });

/** Graph fakes that give the target file a node + two neighbors (a real blast radius). */
const connectedGraph = (target = "src/a.ts"): Pick<HandlerCtxOpts, "getNode" | "getNeighbors"> => ({
  getNode: async (name: string) => (name === target ? fileNode(target) : null),
  getNeighbors: async () => ({ center: fileNode(target), nodes: [fileNode("b.ts"), fileNode("c.ts")], edges: [], depth: 1 }),
});

describe("pre-write · handlePreWrite", () => {
  it("injects guidance and logs a 'ran' pattern event when the agent returns warnings (§7.1)", async () => {
    const { ctx, records } = makeHandlerCtx({
      ...connectedGraph(),
      invoke: async () => agentResult(true, { warnings: [warning("warn", "charge.ts caller assumes cents", ["billing/charge.ts:88"])] }),
    });
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res.hookEventName).toBe("PreToolUse"); // the stamp that makes mergeContext label correctly (§4.6)
    expect(res.additionalContext).toContain("middle-management intelligent-router");
    expect(res.additionalContext).toContain("Pre-write guidance for src/a.ts");
    expect(res.additionalContext).toContain("charge.ts caller assumes cents");
    const ev = records.find((r) => r.event === "pattern")!;
    expect(ev).toMatchObject({ pattern: "pre-write", surface: "PreToolUse", decision: "ran", reason: "ran", warnings: 1 });
  });

  it("skips the agent on an isolated file and logs 'gate:no-blast-radius' (§7.3)", async () => {
    let invoked = false;
    const { ctx, records } = makeHandlerCtx({
      invoke: async () => {
        invoked = true;
        return agentResult(true, { warnings: [warning("warn", "x")] });
      },
    });
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res).toEqual({});
    expect(invoked).toBe(false);
    expect(records.find((r) => r.event === "pattern")).toMatchObject({ decision: "skipped", reason: "gate:no-blast-radius" });
  });

  it("is advisory only: never sets a permissionDecision, even on severe warnings (§7.5)", async () => {
    const { ctx } = makeHandlerCtx({
      ...connectedGraph(),
      invoke: async () => agentResult(true, { warnings: [warning("block", "this WILL break prod")] }),
    });
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res.additionalContext).toContain("this WILL break prod");
    expect(res.permissionDecision).toBeUndefined();
    expect(res.decision).toBeUndefined();
    expect(res.continue).toBeUndefined();
  });

  it("is fail-open: a throwing backend yields a clean empty response (§7.6)", async () => {
    const { ctx } = makeHandlerCtx({
      ...connectedGraph(),
      invoke: async () => {
        throw new Error("backend exploded");
      },
    });
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res.additionalContext).toBeUndefined();
    expect(res.permissionDecision).toBeUndefined();
  });

  it("hits the deadline backstop: nothing injected, event reason 'deadline' (§7.7)", async () => {
    const { ctx, records, config } = makeHandlerCtx({
      ...connectedGraph(),
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return agentResult(true, { warnings: [warning("warn", "too late")] });
      },
    });
    config.agents.pre_write.deadline_ms = 5;
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res.additionalContext).toBeUndefined();
    expect(records.find((r) => r.event === "pattern")!.reason).toBe("deadline");
  });

  it("drops empty-warnings results at the judge: no injection, reason 'no-warnings' (§7.8)", async () => {
    const { ctx, records } = makeHandlerCtx({
      ...connectedGraph(),
      invoke: async () => agentResult(true, { warnings: [] }),
    });
    const res = await handlePreWrite(writeEnv(), ctx);
    expect(res.additionalContext).toBeUndefined();
    expect(records.find((r) => r.event === "pattern")!).toMatchObject({ decision: "ran", reason: "no-warnings" });
  });
});

// ── Composition (§4.7): wrap the base PreToolUse handler with the gated pre-write pass ───────────────

describe("pre-write · composePreToolUse + mergeContext", () => {
  it("is byte-identical to the base handler when agents are off (§7.2 flag-off parity)", async () => {
    const { ctx, records } = makeHandlerCtx({ withAgents: false });
    const baseRes: HookResponse = { hookEventName: "PreToolUse", additionalContext: "BASE" };
    const handler = composePreToolUse({ base: async () => baseRes, runPreWrite: async () => ({ hookEventName: "PreToolUse", additionalContext: "SHOULD-NOT-RUN" }) });
    const res = await handler(writeEnv(), ctx);
    expect(res).toEqual(baseRes);
    expect(records.find((r) => r.event === "pattern")).toBeUndefined();
  });

  it("does not run pre-write when the per-pattern switch is off", async () => {
    const { ctx, config } = makeHandlerCtx();
    config.agents.pre_write.enabled = false;
    let ran = false;
    const handler = composePreToolUse({
      base: async () => ({}),
      runPreWrite: async () => {
        ran = true;
        return {};
      },
    });
    await handler(writeEnv(), ctx);
    expect(ran).toBe(false);
  });

  it("passes non-write tools straight through to the base handler (§7.4)", async () => {
    const { ctx } = makeHandlerCtx();
    let ran = false;
    const baseRes: HookResponse = { permissionDecision: "allow", permissionDecisionReason: "safe" };
    const handler = composePreToolUse({
      base: async () => baseRes,
      runPreWrite: async () => {
        ran = true;
        return {};
      },
    });
    const res = await handler(ptuEnv("Bash", { command: "ls" }), ctx);
    expect(res).toEqual(baseRes);
    expect(ran).toBe(false);
  });

  it("labels a toolbox-route base (no hookEventName) merged with guidance as PreToolUse (§7.12)", async () => {
    const { ctx } = makeHandlerCtx();
    const handler = composePreToolUse({
      base: async () => ({ additionalContext: "<middle-management toolbox>\nROUTE\n</middle-management toolbox>" }),
      runPreWrite: async () => ({ hookEventName: "PreToolUse", additionalContext: "<middle-management intelligent-router>\nGUIDE\n</middle-management intelligent-router>" }),
    });
    const res = await handler(writeEnv(), ctx);
    expect(res.hookEventName).toBe("PreToolUse");
    expect(res.additionalContext).toContain("ROUTE");
    expect(res.additionalContext).toContain("GUIDE");
    expect(res.additionalContext!.indexOf("ROUTE")).toBeLessThan(res.additionalContext!.indexOf("GUIDE")); // base first
  });

  it("returns the base byte-identical (no hookEventName added) when guidance is empty (§7.12)", async () => {
    const { ctx } = makeHandlerCtx();
    const base: HookResponse = { additionalContext: "ROUTE-ONLY" }; // toolbox-route shape — no hookEventName
    const handler = composePreToolUse({ base: async () => base, runPreWrite: async () => ({}) });
    const res = await handler(writeEnv(), ctx);
    expect(res).toBe(base); // mergeContext returns the base object untouched
    expect(res.hookEventName).toBeUndefined();
  });

  it("preserves a base permissionDecision while appending guidance (§4.7)", async () => {
    const { ctx } = makeHandlerCtx();
    const handler = composePreToolUse({
      base: async () => ({ hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "uncertain", additionalContext: "BASE" }),
      runPreWrite: async () => ({ hookEventName: "PreToolUse", additionalContext: "GUIDE" }),
    });
    const res = await handler(writeEnv(), ctx);
    expect(res.permissionDecision).toBe("ask");
    expect(res.additionalContext).toContain("BASE");
    expect(res.additionalContext).toContain("GUIDE");
  });
});
