import { describe, expect, it } from "vitest";
import { buildRunReport } from "../../src/orchestrator/report";
import type { TaskOutcome } from "../../src/orchestrator/swarm";
import type { CostEvent } from "../../src/cost/tracker";

const outcomes: TaskOutcome[] = [
  { taskId: "t1", status: "completed", winner: { branch: "b1", attempt: 2, diffBytes: 100 }, attempts: [{ attempt: 1, branch: "x", worktree: "w", agentOk: true, costUsd: 0.01, latencyMs: 5 }, { attempt: 2, branch: "b1", worktree: "w2", agentOk: true, costUsd: 0.01, latencyMs: 5 }] },
  { taskId: "t2", status: "failed", attempts: [{ attempt: 1, branch: "y", worktree: "w3", agentOk: false, costUsd: 0.02, latencyMs: 5 }] },
];

const costEvents: CostEvent[] = [
  { ts: "2026-07-11T00:00:00Z", costUsd: 0.01, taskId: "t1", attempt: 1, inputTokens: 9000, outputTokens: 300 },
  { ts: "2026-07-11T00:01:00Z", costUsd: 0.01, taskId: "t1", attempt: 2, inputTokens: 9000, outputTokens: 350 },
  { ts: "2026-07-11T00:02:00Z", costUsd: 0.02, taskId: "t2", attempt: 1, inputTokens: 8000, outputTokens: 900 },
];

describe("buildRunReport", () => {
  it("folds outcomes + cost events into the Pareto record", () => {
    const r = buildRunReport({
      runId: "run-1",
      outcomes,
      conflicts: 1,
      costEvents,
      wallClockMs: 120_000,
    });
    expect(r).toMatchObject({
      runId: "run-1",
      tasksTotal: 2,
      completed: 1,
      failed: 1,
      skipped: 0,
      conflicts: 1,
      attempts: 3,
      inputTokens: 26_000,
      outputTokens: 1_550,
      wallClockMs: 120_000,
    });
    expect(r.totalCostUsd).toBeCloseTo(0.04, 10);
    expect(r.costPerCompletedTaskUsd!).toBeCloseTo(0.04, 10); // total spend over completed tasks — honest denominator
    expect(r.perTask["t1"]).toMatchObject({ attempts: 2 });
    expect(r.perTask["t1"]!.costUsd).toBeCloseTo(0.02, 10);
  });

  it("reports null $/task when nothing completed (never divides by zero)", () => {
    const r = buildRunReport({ runId: "r", outcomes: [outcomes[1]!], conflicts: 0, costEvents: [], wallClockMs: 1 });
    expect(r.costPerCompletedTaskUsd).toBeNull();
  });
});
