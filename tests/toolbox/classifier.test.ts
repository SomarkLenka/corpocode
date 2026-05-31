// The toolbox classifier: picks valid catalog names for a prompt, drops hallucinated/duplicate names,
// caps to the limit, and fails open to [] so an outage never costs the turn.
import { describe, it, expect } from "vitest";
import { classifyRelevant } from "../../src/toolbox/classifier";
import type { Provider, ChatInput, ChatOutput } from "../../src/providers/types";
import type { ToolboxEntry } from "../../src/toolbox/types";

function provider(behavior: (input: ChatInput) => string): Provider {
  return {
    id: "anthropic",
    model: "fake",
    modelTier: "fast",
    async chat(input: ChatInput): Promise<ChatOutput> {
      return {
        text: behavior(input),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        providerId: "anthropic",
        model: "fake",
        finishReason: "stop",
      };
    },
    async ping() {
      return true;
    },
  };
}

const candidates: ToolboxEntry[] = [
  { kind: "skill", name: "alpha", scope: "user", absPath: "/a", description: "for alpha tasks" },
  { kind: "skill", name: "beta", scope: "user", absPath: "/b", description: "for beta tasks" },
];

describe("classifyRelevant", () => {
  it("returns only valid catalog names, dropping hallucinated ones", async () => {
    const p = provider(() => JSON.stringify({ selected: [{ name: "alpha", reason: "match" }, { name: "ghost", reason: "x" }] }));
    const out = await classifyRelevant({ kind: "skill", prompt: "do alpha", candidates, limit: 4 }, { provider: p });
    expect(out.map((s) => s.name)).toEqual(["alpha"]);
    expect(out[0]!.reason).toBe("match");
  });

  it("caps to the limit", async () => {
    const p = provider(() => JSON.stringify({ selected: [{ name: "alpha" }, { name: "beta" }] }));
    expect(await classifyRelevant({ kind: "skill", prompt: "both", candidates, limit: 1 }, { provider: p })).toHaveLength(1);
  });

  it("fails open to [] on a provider error or bad JSON", async () => {
    const boom = provider(() => {
      throw new Error("down");
    });
    expect(await classifyRelevant({ kind: "skill", prompt: "x", candidates, limit: 4 }, { provider: boom })).toEqual([]);
    const garbage = provider(() => "not json");
    expect(await classifyRelevant({ kind: "skill", prompt: "x", candidates, limit: 4 }, { provider: garbage })).toEqual([]);
  });

  it("returns [] with no candidates without calling the provider", async () => {
    let called = false;
    const p = provider(() => {
      called = true;
      return "{}";
    });
    expect(await classifyRelevant({ kind: "agent", prompt: "x", candidates: [], limit: 4 }, { provider: p })).toEqual([]);
    expect(called).toBe(false);
  });
});
