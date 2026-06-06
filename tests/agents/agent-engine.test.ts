import { describe, it, expect } from "vitest";
import { createAgentEngineBackend, toEngineCall, toEngineTools, fromEngineResult } from "../../src/agents/backends/agent-engine";
import type { AgentCall } from "../../src/agents/backend";

const call = (over: Partial<AgentCall> = {}): AgentCall => ({ component: "router", taskKind: "general", task: "t", ...over });

describe("agent-engine adapter — type mapping", () => {
  it("maps tool policy to the engine's shape", () => {
    expect(toEngineTools(undefined)).toBe("read-only");
    expect(toEngineTools("none")).toBe("none");
    expect(toEngineTools({ write: true, mcp: ["mcp__github__x"] })).toEqual({ enable: { read: true, glob: true, grep: true, mcp__github__x: true }, allowMutation: true });
  });

  it("maps a CorpoCode AgentCall to an engine call (model/inputs/schema/session)", () => {
    const ec = toEngineCall(call({
      model: { providerKey: "default", model: "claude-haiku-4-5" },
      inputs: { transcript: "tx", files: ["a.ts"], decisions: "d" },
      schema: { type: "object" },
      session: { reuse: "s1", persist: true, key: "k" },
    }));
    expect(ec.model).toEqual({ providerID: "default", modelID: "claude-haiku-4-5" });
    expect(ec.inputs?.decisions).toEqual(["d"]); // string → string[]
    expect(ec.schema?.jsonSchema).toEqual({ type: "object" });
    expect(ec.schema?.parse({ x: 1 })).toEqual({ x: 1 }); // engine validates jsonSchema; parse is identity
    expect(ec.session).toEqual({ reuse: "s1", persist: true }); // CorpoCode-only `key` dropped
  });

  it("maps an engine result back, normalizing model + error kinds", () => {
    const res = fromEngineResult({
      ok: false,
      usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01, latencyMs: 9 },
      model: { providerID: "default", modelID: "m" },
      trace: [{ tool: "read", title: "a.ts" }],
      error: { kind: "server_unavailable", message: "down", retryable: true },
    });
    expect(res.model).toEqual({ providerKey: "default", model: "m" });
    expect(res.usage.model).toBe("m");
    expect(res.trace).toEqual([{ name: "read", input: "a.ts" }]);
    expect(res.error?.kind).toBe("model_unavailable"); // server_unavailable → model_unavailable
  });
});

describe("agent-engine backend", () => {
  it("delegates to an injected engine and adapts the result", async () => {
    const fakeEngine = {
      invoke: async () => ({ ok: true, data: { picked: true }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 2 }, model: { providerID: "default", modelID: "m" } }),
      release: async () => {},
      health: async () => ({ ok: true, serverUp: true }),
      shutdown: async () => {},
    };
    const backend = createAgentEngineBackend({ engine: fakeEngine as never });
    const res = await backend.invoke<{ picked: boolean }>(call({ schema: { type: "object" } }));
    expect(res.ok).toBe(true);
    expect(res.data?.picked).toBe(true);
    expect(res.model).toEqual({ providerKey: "default", model: "m" });
    expect(await backend.ping()).toBe(true);
  });

  it("is fail-open when the package/engine is absent (anthropic-cli stays the default)", async () => {
    const backend = createAgentEngineBackend({ load: async () => null });
    const res = await backend.invoke(call());
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("model_unavailable");
    expect(await backend.health()).toEqual({ up: false });
  });
});
