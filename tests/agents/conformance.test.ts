import { describe, it, expect } from "vitest";
import { createAnthropicCliAgent, buildArgs, allowedTools, DEFAULT_AGENT_MODEL } from "../../src/agents/backends/anthropic-cli";
import { createAgentEngineBackend } from "../../src/agents/backends/agent-engine";
import { buildAgentRegistry } from "../../src/agents/registry";
import type { SpawnText } from "../../src/agents/spawn";
import type { AgentBackend, AgentCall } from "../../src/agents/backend";

const okStdout = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ result: "hello", session_id: "sess-1", model: DEFAULT_AGENT_MODEL, total_cost_usd: 0.002, usage: { input_tokens: 10, output_tokens: 5 }, ...over });

/** A spawn that records the argv it was called with and returns a canned stdout. */
function recordingSpawn(stdout: string): { spawn: SpawnText; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnText = async (_cmd, args) => {
    calls.push(args);
    return { stdout };
  };
  return { spawn, calls };
}

const call = (over: Partial<AgentCall> = {}): AgentCall => ({ component: "router", taskKind: "general", task: "do a thing", ...over });

describe("anthropic-cli AgentBackend — flag construction", () => {
  it("is always read-only and --bare (the recursion guard), with default tools", () => {
    const { args } = buildArgs(call(), DEFAULT_AGENT_MODEL, "/repo");
    expect(args).toContain("--bare");
    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--allowedTools Read,Glob,Grep");
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("do a thing");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("mints --session-id for a persistent-create call", () => {
    const { args, newSessionId } = buildArgs(call({ session: { persist: true } }), DEFAULT_AGENT_MODEL, "/repo");
    expect(newSessionId).toMatch(/[0-9a-f-]{36}/);
    expect(args[args.indexOf("--session-id") + 1]).toBe(newSessionId);
  });

  it("uses --resume (and omits the system prompt) when reusing a session", () => {
    const { args, newSessionId } = buildArgs(call({ session: { reuse: "prev-id" } }), DEFAULT_AGENT_MODEL, "/repo");
    expect(newSessionId).toBeUndefined();
    expect(args[args.indexOf("--resume") + 1]).toBe("prev-id");
    expect(args).not.toContain("--append-system-prompt"); // already bound to the resumed session
  });

  it("maps tool policy to the allow-list (none → empty; write opt-in)", () => {
    expect(allowedTools("none")).toEqual([]);
    expect(allowedTools("read-only")).toEqual(["Read", "Glob", "Grep"]);
    expect(allowedTools({ write: true, mcp: ["mcp__github__add_issue_comment"] })).toContain("Write");
    expect(allowedTools({ write: true, mcp: ["mcp__github__add_issue_comment"] })).toContain("mcp__github__add_issue_comment");
  });
});

describe("anthropic-cli AgentBackend — invoke contract (fail-open)", () => {
  it("returns parsed data + usage on a schema call", async () => {
    const { spawn } = recordingSpawn(okStdout({ result: '{"implicated":true,"confidence":0.9}' }));
    const agent = createAnthropicCliAgent({ spawn, repoRoot: "/repo" });
    const res = await agent.invoke<{ implicated: boolean }>(call({ schema: { type: "object" } }));
    expect(res.ok).toBe(true);
    expect(res.data?.implicated).toBe(true);
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.costUsd).toBe(0.002);
    expect(res.session?.id).toBe("sess-1");
  });

  it("never throws — ENOENT resolves to model_unavailable", async () => {
    const spawn: SpawnText = async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    };
    const agent = createAnthropicCliAgent({ spawn });
    const res = await agent.invoke(call());
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("model_unavailable");
  });

  it("a timeout resolves to { ok:false, error.kind:'timeout' }, never throws", async () => {
    const hanging: SpawnText = (_c, _a, _s, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const agent = createAnthropicCliAgent({ spawn: hanging });
    const res = await agent.invoke(call({ timeoutMs: 5 }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("timeout");
  });

  it("a malformed-JSON schema response is a clean fail-open, not a throw", async () => {
    const { spawn } = recordingSpawn(okStdout({ result: "not json at all" }));
    const agent = createAnthropicCliAgent({ spawn });
    const res = await agent.invoke(call({ schema: { type: "object" } }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("invalid_response");
  });
});

describe("agent-engine stub backend", () => {
  it("resolves fail-open with model_unavailable (never throws)", async () => {
    const res = await createAgentEngineBackend().invoke(call());
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("model_unavailable");
  });
});

describe("agent registry", () => {
  const cli = createAnthropicCliAgent({ spawn: async () => ({ stdout: okStdout() }) });
  const engine = createAgentEngineBackend();

  it("resolves a task to its configured backend, defaulting to anthropic-cli", () => {
    const reg = buildAgentRegistry({ backends: { "anthropic-cli": cli, "agent-engine": engine }, taskBackends: { review: "agent-engine" } });
    expect(reg.forTask("rank").id).toBe("anthropic-cli");
    expect(reg.forTask("review").id).toBe("agent-engine");
  });

  it("falls open to another loaded backend when the configured one is absent", () => {
    const reg = buildAgentRegistry({ backends: { "anthropic-cli": cli }, taskBackends: { review: "agent-engine" } });
    expect(reg.forTask("review").id).toBe("anthropic-cli"); // agent-engine not registered → fall open
    expect(reg.availableFor("review")).toBe(true);
  });
});
