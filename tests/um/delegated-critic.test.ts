import { describe, it, expect } from "vitest";
import { recommendDelegated, RECO_SCHEMA } from "../../src/um/delegated-critic";
import type { AgentBackend, AgentCall, AgentResult } from "../../src/agents/backend";
import type { DecisionFork } from "../../src/um/types";

// ---------- fakes: mirror tests/um/loop.test.ts ----------

/** A backend that returns `data` (or an error when errorMessage is set), recording every call. */
function fakeBackend(
  data: unknown,
  errorMessage?: string,
): { backend: AgentBackend; calls: AgentCall[] } {
  const calls: AgentCall[] = [];
  const backend = {
    id: "anthropic-cli",
    invoke: (async (call: AgentCall): Promise<AgentResult> => {
      calls.push(call);
      return {
        ok: !errorMessage,
        data: errorMessage ? undefined : data,
        usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.001, latencyMs: 2, model: "cheap" },
        model: { providerKey: "default", model: "cheap" },
        ...(errorMessage
          ? { error: { kind: "model_unavailable", message: errorMessage, retryable: false } }
          : {}),
      };
    }) as AgentBackend["invoke"],
    release: async () => {},
    health: async () => ({ up: true }),
    ping: async () => true,
    shutdown: async () => {},
  } as unknown as AgentBackend;
  return { backend, calls };
}

function makeFork(over?: Partial<DecisionFork>): DecisionFork {
  return {
    id: "f1",
    section: "api-spec",
    concept: "persistence",
    question: "SQLite or JSON?",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    major: true,
    ...over,
  };
}

// ---------- schema ----------

describe("RECO_SCHEMA", () => {
  it("requires optionId and rationale strings", () => {
    expect(RECO_SCHEMA).toMatchObject({
      type: "object",
      required: ["optionId", "rationale"],
      properties: {
        optionId: { type: "string" },
        rationale: { type: "string" },
      },
    });
  });
});

// ---------- recommendDelegated ----------

describe("recommendDelegated", () => {
  it("valid recommendation → via 'critic', that optionId, source 'delegated', rationale carried", async () => {
    const { backend, calls } = fakeBackend({ optionId: "b", rationale: "B scales better" });
    const fork = makeFork();

    const res = await recommendDelegated({ backend, fork, defaultOptionId: "a" });

    expect(res.via).toBe("critic");
    expect(res.answer).toEqual({ pollId: "f1", optionId: "b", source: "delegated" });
    expect(res.rationale).toBe("B scales better");

    // the critic reads only the fork; it authors nothing (no write tools, ephemeral, cheap effort)
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.component).toBe("um");
    expect(call.taskKind).toBe("consequence");
    expect(call.effort).toBe("minimal");
    expect(call.tools).toBe("none");
    expect(call.session).toBe("ephemeral");
    expect(call.schema).toBe(RECO_SCHEMA);
    expect(call.inputs?.reasoning).toBe(JSON.stringify(fork));
  });

  it("recommendation naming an unknown optionId → via 'fallback' to the default", async () => {
    const { backend } = fakeBackend({ optionId: "zzz", rationale: "off the menu" });
    const res = await recommendDelegated({ backend, fork: makeFork(), defaultOptionId: "a" });

    expect(res.via).toBe("fallback");
    expect(res.answer).toEqual({ pollId: "f1", optionId: "a", source: "delegated" });
  });

  it("dead backend (ok:false) → via 'fallback' to the default", async () => {
    const { backend } = fakeBackend(undefined, "model gone");
    const res = await recommendDelegated({ backend, fork: makeFork(), defaultOptionId: "b" });

    expect(res.via).toBe("fallback");
    expect(res.answer).toEqual({ pollId: "f1", optionId: "b", source: "delegated" });
  });

  it("no default + dead backend → via 'fallback' with optionId undefined (still source 'delegated')", async () => {
    const { backend } = fakeBackend(undefined, "model gone");
    const res = await recommendDelegated({ backend, fork: makeFork() });

    expect(res.via).toBe("fallback");
    expect(res.answer).toEqual({ pollId: "f1", source: "delegated" });
    expect(res.answer.optionId).toBeUndefined();
  });

  it("passes an explicit model ref through when provided", async () => {
    const { backend, calls } = fakeBackend({ optionId: "a", rationale: "ok" });
    await recommendDelegated({
      backend,
      fork: makeFork(),
      defaultOptionId: "a",
      model: { providerKey: "default", model: "cheap" },
    });
    expect(calls[0]!.model).toEqual({ providerKey: "default", model: "cheap" });
  });

  it("ok result but missing data → via 'fallback' (never throws on a malformed win)", async () => {
    const { backend } = fakeBackend(undefined); // ok:true, data undefined
    const res = await recommendDelegated({ backend, fork: makeFork(), defaultOptionId: "a" });
    expect(res.via).toBe("fallback");
    expect(res.answer).toEqual({ pollId: "f1", optionId: "a", source: "delegated" });
  });
});
