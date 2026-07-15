import { describe, expect, it } from "vitest";
import { arbitrate } from "../../src/orchestrator/arbiter";
import type { ArbiterVerdict } from "../../src/orchestrator/verdict";
import type { AgentBackend, AgentCall } from "../../src/agents/backend";

/** Fake backend per ADR-0001 — records the call, returns a canned result. NEVER a real model. */
function fakeBackend(result: { ok: boolean; data?: unknown; errorMessage?: string }) {
  const calls: AgentCall[] = [];
  const backend = {
    id: "anthropic-cli",
    invoke: async <T,>(call: AgentCall<T>) => {
      calls.push(call as AgentCall);
      return {
        ok: result.ok,
        data: result.data as T | undefined,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.002, latencyMs: 5, model: "fake" },
        model: { providerKey: "anthropic-cli", model: "fake" },
        ...(result.errorMessage ? { error: { kind: "model_unavailable", message: result.errorMessage, retryable: false } } : {}),
      };
    },
    release: async () => {},
    health: async () => ({ up: true }),
    shutdown: async () => {},
  } as unknown as AgentBackend;
  return { backend, calls };
}

const acceptVerdict: ArbiterVerdict = {
  decision: "accept",
  criteria: [{ id: "ac1", met: true, note: "diff satisfies the criterion" }],
  summary: "all referenced criteria met",
  specGaps: [],
};

const baseOpts = {
  task: { id: "t1", specRefs: ["ac1"] },
  diff: "diff --git a/x b/x\n+added",
  rubric: "- [ac1] WHEN a THE SYSTEM SHALL b",
};

describe("arbitrate", () => {
  it("returns ok:true with the normalized verdict on an accept", async () => {
    const { backend } = fakeBackend({ ok: true, data: acceptVerdict });
    const res = await arbitrate({ backend, ...baseOpts });
    expect(res.ok).toBe(true);
    expect(res.verdict?.decision).toBe("accept");
    expect(res.verdict?.specGaps).toEqual([]);
    expect(res.costUsd).toBe(0.002);
  });

  it("calls the arbiter as a read-nothing structured reviewer", async () => {
    const { backend, calls } = fakeBackend({ ok: true, data: acceptVerdict });
    await arbitrate({ backend, ...baseOpts });
    const call = calls[0]!;
    expect(call.component).toBe("arbiter");
    expect(call.taskKind).toBe("review");
    expect(call.tools).toBe("none");
    expect(call.effort).toBe("high");
    expect(call.schema).toBeDefined();
    expect(call.session).toBe("ephemeral");
    // rubric feeds reasoning, diff feeds decisions
    expect(call.inputs?.reasoning).toBe(baseOpts.rubric);
    expect(call.inputs?.decisions).toBe(baseOpts.diff);
  });

  it("passes an explicit model override through", async () => {
    const { backend, calls } = fakeBackend({ ok: true, data: acceptVerdict });
    await arbitrate({ backend, ...baseOpts, model: { providerKey: "default", model: "claude-fable-5" } });
    expect(calls[0]!.model).toEqual({ providerKey: "default", model: "claude-fable-5" });
  });

  it("a dead arbiter NEVER silently accepts — ok:false, no verdict, skipped reason", async () => {
    const { backend } = fakeBackend({ ok: false, errorMessage: "claude not found" });
    const res = await arbitrate({ backend, ...baseOpts });
    expect(res.ok).toBe(false);
    expect(res.verdict).toBeUndefined();
    expect(res.skipped).toContain("claude not found");
  });

  it("ok:true but no data is also treated as no verdict", async () => {
    const { backend } = fakeBackend({ ok: true });
    const res = await arbitrate({ backend, ...baseOpts });
    expect(res.ok).toBe(false);
    expect(res.verdict).toBeUndefined();
    expect(res.skipped).toContain("no verdict");
  });

  it("spec-gap coercion flows through normalizeVerdict", async () => {
    const { backend } = fakeBackend({
      ok: true,
      data: { decision: "accept", criteria: [], summary: "s", specGaps: ["the spec never names the error path"] },
    });
    const res = await arbitrate({ backend, ...baseOpts });
    expect(res.ok).toBe(true);
    expect(res.verdict?.decision).toBe("spec-gap");
  });

  it("logs an arbiter event carrying the cost", async () => {
    const { backend } = fakeBackend({ ok: true, data: acceptVerdict });
    const events: Record<string, unknown>[] = [];
    await arbitrate({ backend, ...baseOpts, log: (f) => events.push(f) });
    const ev = events.find((e) => e.event === "arbiter");
    expect(ev).toBeDefined();
    expect(ev!.cost_usd).toBe(0.002);
  });
});
