import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUserPromptSubmit } from "../../src/router/handler";
import { defaultConfig } from "../../src/config/load";
import type { HookContext } from "../../src/hooks/context";
import type { UserPromptSubmitEnvelope } from "../../src/hooks/envelope";
import type { ChatInput, ChatOutput, Provider } from "../../src/providers/types";
import type { KnowledgeGraph, NodeKind, ScoredFile } from "../../src/backends/graph/types";
import type { MemoryStore, ScoredMemory } from "../../src/backends/memory/types";
import type { SessionReader, ThoughtState } from "../../src/session/types";
import type { ContextStore } from "../../src/backends/context/types";

interface CtxOptions {
  scoreFiles?: KnowledgeGraph["scoreFiles"];
  providerText?: string;
  recall?: MemoryStore["recall"];
  intent?: string;
  entities?: string[];
}

let home = "";

function makeCtx(opts: CtxOptions = {}) {
  const records: Array<Record<string, unknown>> = [];
  const providerCalls: ChatInput[] = [];

  const provider: Provider = {
    id: "anthropic",
    model: "haiku",
    modelTier: "fast",
    async chat(input): Promise<ChatOutput> {
      providerCalls.push(input);
      return {
        text: opts.providerText ?? "{}",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.0002,
        latencyMs: 5,
        providerId: "anthropic",
        model: "haiku",
        finishReason: "stop",
      };
    },
    async ping() {
      return true;
    },
  };

  const graph: KnowledgeGraph = {
    id: "graphify",
    scoreFiles: opts.scoreFiles ?? (async () => []),
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
  };

  const memory: MemoryStore = {
    id: "native",
    recall: opts.recall ?? (async () => []),
    capture: async () => {},
    consolidate: async () => ({ captured: 0, superseded: 0 }),
    recordOutcome: async () => {},
    ping: async () => true,
  };

  const thought: ThoughtState = {
    intent: opts.intent ?? "",
    openQuestions: [],
    recentDecisions: [],
    entities: opts.entities ?? [],
  };
  const sessionReader: SessionReader = {
    lineOfThought: async () => thought,
    filePurpose: async () => null,
    retrievalCues: async () => ({ query: "", files: [] }),
  };

  const ctx: HookContext = {
    config: defaultConfig(),
    env: { CORPOCODE_HOME: home },
    repoRoot: "/repo",
    project: "proj",
    platform: "claude-code",
    logger: { enabled: true, log: (r) => records.push(r as Record<string, unknown>) },
    registry: { forComponent: () => provider, all: () => [provider] },
    graph,
    context: {} as unknown as ContextStore,
    memory,
    sessionReader,
    plugins: { plugins: [], templates: [], tenets: [] },
  };
  return { ctx, records, providerCalls };
}

const env = (prompt: string): UserPromptSubmitEnvelope =>
  ({ session_id: "s", transcript_path: "/t", cwd: "/repo", prompt }) as unknown as UserPromptSubmitEnvelope;

describe("UserPromptSubmit categorizer handler", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-router-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("early-exits on a trivial prompt: free router log, no injection, no model call", async () => {
    const { ctx, records, providerCalls } = makeCtx();
    const res = await handleUserPromptSubmit(env("hi"), ctx);
    expect(res.additionalContext).toBeUndefined();
    const log = records.find((r) => r.event === "router")!;
    expect(log.stage2_invoked).toBe(false);
    expect(log.cost_usd).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it("injects a recommendation with graph candidates, an enforced preload subset, and recalled decisions", async () => {
    const candidates: ScoredFile[] = [
      { path: "src/client.ts", score: 0.7, nodeId: "c" },
      { path: "src/retry.ts", score: 0.9, nodeId: "r" },
    ];
    const decisionJson = JSON.stringify({
      type: "code-edit",
      complexity: "hard",
      breakpoint: true,
      dispatch_retrieval: true,
      effort: "minimal", // selectModelEffort should override this to "high" for a hard moment
      context_files_to_preload: ["src/retry.ts", "nonexistent.ts"],
    });
    const recalled: ScoredMemory[] = [
      { id: "d1", kind: "decision", text: "use exponential backoff", createdAt: 0, score: 1 },
    ];
    const { ctx, records } = makeCtx({
      scoreFiles: async () => candidates,
      providerText: decisionJson,
      recall: async () => recalled,
      intent: "improve retry resilience",
    });

    const res = await handleUserPromptSubmit(env("make the API calls more reliable"), ctx);

    expect(res.hookEventName).toBe("UserPromptSubmit");
    expect(res.additionalContext).toContain("middle-management recommendation");
    expect(res.additionalContext).toContain("src/client.ts"); // structurally related, not in the prompt
    expect(res.additionalContext).toContain("use exponential backoff"); // recalled decision surfaced

    const log = records.find((r) => r.event === "router")!;
    expect(log.stage2_invoked).toBe(true);
    const decision = log.decision as Record<string, unknown>;
    expect(decision.context_files_to_preload).toEqual(["src/retry.ts"]); // subset enforced
    expect(decision.effort).toBe("high"); // overridden by selectModelEffort(hard)
    expect(decision.model).toBe("claude-opus-4");
    expect(log.recalled).toBe(1);
  });
});
