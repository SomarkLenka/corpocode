import { describe, it, expect } from "vitest";
import { route } from "../../src/intelligence/router-router";
import type { AgentBackend, AgentCall, AgentResult } from "../../src/agents/backend";
import type { Intent } from "../../src/intelligence/types";

function backend(invoke: (call: AgentCall) => Promise<AgentResult>): AgentBackend {
  return { id: "anthropic-cli", invoke: invoke as AgentBackend["invoke"], release: async () => {}, health: async () => ({ up: true }), ping: async () => true, shutdown: async () => {} };
}

const verdict = (dumb: boolean, directAction?: string): AgentResult => ({
  ok: true,
  data: { dumb, reason: dumb ? "simple" : "needs investigation", directAction },
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, model: "m" },
  model: { providerKey: "p", model: "m" },
});

const failed: AgentResult = {
  ok: false,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: "m" },
  model: { providerKey: "p", model: "m" },
  error: { kind: "timeout", message: "slow", retryable: true },
};

const prompt = (text: string): Intent => ({ kind: "prompt", prompt: text, sessionId: "s", transcriptPath: "t" });
const write: Intent = { kind: "pre-write", file: "auth/session.ts", sessionId: "s", transcriptPath: "t" };

describe("router-router — strict triage gate", () => {
  it("dumb-routes deterministically trivial prompts for free (no backend call)", async () => {
    let called = false;
    const forTask = () => backend(async () => { called = true; return verdict(false); });
    const d = await route(prompt("hi"), { forTask });
    expect(d.route).toBe("dumb");
    expect(called).toBe(false); // short-circuited before the agent
  });

  it("dumb-routes when the agent confidently says dumb, carrying the direct action", async () => {
    const forTask = () => backend(async () => verdict(true, "git commit"));
    const d = await route(write, { forTask });
    expect(d.route).toBe("dumb");
    if (d.route === "dumb") expect(d.directAction).toBe("git commit");
  });

  it("smart-routes when the agent says not-dumb", async () => {
    const forTask = () => backend(async () => verdict(false));
    expect((await route(prompt("refactor the auth layer for X"), { forTask })).route).toBe("smart");
  });

  it("smart-routes on any agent failure (never withhold context on doubt)", async () => {
    const forTask = () => backend(async () => failed);
    expect((await route(write, { forTask })).route).toBe("smart");
  });

  it("smart-routes when no triage backend is registered", async () => {
    const forTask = () => { throw new Error("none"); };
    expect((await route(write, { forTask })).route).toBe("smart");
  });

  it("always smart-routes when disabled, even for a trivial prompt", async () => {
    const forTask = () => backend(async () => verdict(true));
    expect((await route(prompt("hi"), { forTask, enabled: false })).route).toBe("smart");
  });

  it("sends a tool-less, minimal-effort, ephemeral triage call", async () => {
    let seen: AgentCall | undefined;
    const forTask = () => backend(async (c) => { seen = c; return verdict(false); });
    await route(prompt("something non-trivial to investigate"), { forTask });
    expect(seen?.taskKind).toBe("triage");
    expect(seen?.tools).toBe("none");
    expect(seen?.effort).toBe("minimal");
    expect(seen?.session).toBe("ephemeral");
  });
});
