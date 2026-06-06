import { describe, it, expect } from "vitest";
import { run } from "../../src/intelligence/engine";
import type { AgentBackend, AgentCall, AgentResult } from "../../src/agents/backend";
import type { AgentTask, OrchestrationPlan } from "../../src/intelligence/types";

// Tests use a non-generic invoke; cast to the generic backend signature (variance is irrelevant here).
function backend(invoke: (call: AgentCall) => Promise<AgentResult>): AgentBackend {
  return { id: "anthropic-cli", invoke: invoke as AgentBackend["invoke"], release: async () => {}, health: async () => ({ up: true }), ping: async () => true, shutdown: async () => {} };
}

const result = (ok: boolean, costUsd = 0.001, data?: unknown): AgentResult => ({
  ok,
  data,
  usage: { inputTokens: 1, outputTokens: 1, costUsd, latencyMs: 1, model: "m" },
  model: { providerKey: "default", model: "m" },
  ...(ok ? {} : { error: { kind: "invalid_response" as const, message: "x", retryable: false } }),
});

const task = (id: string): AgentTask => ({ id, call: { component: "router", taskKind: "general", task: id } as AgentCall });

describe("orchestration engine", () => {
  it("runs every task in plan order and aggregates usage", async () => {
    const seen: string[] = [];
    const forTask = () => backend(async (c) => {
      seen.push(c.task);
      return result(true);
    });
    const plan: OrchestrationPlan = { tasks: [task("a"), task("b"), task("c")], fanoutWidth: 1 };
    const res = await run(plan, { forTask });
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]); // order preserved
    expect(res.usage.calls).toBe(3);
    expect(res.usage.succeeded).toBe(3);
    expect(res.usage.costUsd).toBeCloseTo(0.003, 6);
    expect(seen).toEqual(["a", "b", "c"]); // fanoutWidth:1 ⇒ sequential
  });

  it("drops failed tasks by default and reports ok from survivors", async () => {
    const forTask = () => backend(async (c) => result(c.task !== "bad"));
    const res = await run({ tasks: [task("good"), task("bad")] }, { forTask });
    expect(res.tasks.map((t) => t.id)).toEqual(["good"]);
    expect(res.ok).toBe(true);
    expect(res.usage.succeeded).toBe(1);
  });

  it("applies a custom judge (e.g. confidence/fit filter)", async () => {
    const forTask = () => backend(async (c) => result(true, 0.001, { conf: c.task === "keep" ? 0.9 : 0.1 }));
    const judge = (rs: { result: AgentResult }[]) => rs.filter((r) => (r.result.data as { conf: number }).conf >= 0.5) as never;
    const res = await run({ tasks: [task("keep"), task("drop")], judge }, { forTask });
    expect(res.tasks.map((t) => t.id)).toEqual(["keep"]);
  });

  it("never throws — a missing backend becomes a failed task, the run resolves", async () => {
    const forTask = () => {
      throw new Error("no backend registered");
    };
    const res = await run({ tasks: [task("a")] }, { forTask });
    expect(res.ok).toBe(false);
    expect(res.tasks).toHaveLength(0); // the failed task is judged out
    expect(res.usage.calls).toBe(1);
    expect(res.usage.succeeded).toBe(0);
  });

  it("respects the fan-out width (bounded concurrency)", async () => {
    let active = 0;
    let maxActive = 0;
    const forTask = () => backend(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return result(true);
    });
    await run({ tasks: ["a", "b", "c", "d", "e"].map(task), fanoutWidth: 2 }, { forTask });
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
