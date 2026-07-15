import { describe, expect, it } from "vitest";
import { aggregateByTask, aggregateCosts, type CostEvent } from "../../src/cost/tracker";

describe("cost attribution tags", () => {
  it("accepts run/wave/task attribution and aggregates per task id", () => {
    const events: CostEvent[] = [
      { ts: "2026-07-11T00:00:00Z", costUsd: 0.02, runId: "run-1", waveId: 0, taskId: "t1", attempt: 1, role: "implement", inputTokens: 9000, outputTokens: 400 },
      { ts: "2026-07-11T00:01:00Z", costUsd: 0.03, runId: "run-1", waveId: 0, taskId: "t1", attempt: 2, role: "implement", inputTokens: 9100, outputTokens: 500 },
      { ts: "2026-07-11T00:02:00Z", costUsd: 0.01, runId: "run-1", waveId: 1, taskId: "t2", attempt: 1, role: "implement" },
    ];
    const byTask = aggregateByTask(events);
    expect(byTask["t1"]).toMatchObject({ attempts: 2, inputTokens: 18100, outputTokens: 900 });
    expect(byTask["t1"]!.costUsd).toBeCloseTo(0.05, 10); // float sums: never assert exact equality
    expect(byTask["t2"]).toMatchObject({ attempts: 1, inputTokens: 0, outputTokens: 0 });
    // untagged events still aggregate through the existing fold untouched
    expect(aggregateCosts(events).totalUsd).toBeCloseTo(0.06, 10);
  });
});
