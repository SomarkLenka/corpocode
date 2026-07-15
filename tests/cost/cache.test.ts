import { describe, expect, it } from "vitest";
import { aggregateByTask, type CostEvent } from "../../src/cost/tracker";

describe("cost attribution — cache tokens", () => {
  it("sums cacheRead/cacheWrite tokens per task, defaulting missing to zero", () => {
    const events: CostEvent[] = [
      {
        ts: "2026-07-11T00:00:00Z",
        costUsd: 0.02,
        taskId: "t1",
        inputTokens: 9000,
        outputTokens: 400,
        cacheReadTokens: 8000,
        cacheWriteTokens: 1000,
      },
      {
        ts: "2026-07-11T00:01:00Z",
        costUsd: 0.03,
        taskId: "t1",
        inputTokens: 9100,
        outputTokens: 500,
        cacheReadTokens: 8100,
        // no cacheWriteTokens → defaults to 0
      },
      {
        // no cache token fields at all → both default to 0
        ts: "2026-07-11T00:02:00Z",
        costUsd: 0.01,
        taskId: "t2",
        inputTokens: 100,
        outputTokens: 50,
      },
    ];
    const byTask = aggregateByTask(events);
    expect(byTask["t1"]).toMatchObject({
      attempts: 2,
      cacheReadTokens: 16100,
      cacheWriteTokens: 1000,
    });
    expect(byTask["t2"]).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
