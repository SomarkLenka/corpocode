import { describe, expect, it } from "vitest";
import { computePercentiles, detectP99Alerts } from "../../src/perf/percentiles";

describe("computePercentiles", () => {
  it("computes monotonic in-range percentiles over 1..100", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = computePercentiles(values);
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 10);
    // whitelist idiom: idx = min(len-1, floor((p/100)*len)); len=100 → p50→50 (value 51), p90→90 (91), p99→99 (100)
    expect(s.p50).toBe(51);
    expect(s.p90).toBe(91);
    expect(s.p99).toBe(100);
    // monotonic and within range
    expect(s.p50).toBeLessThanOrEqual(s.p90);
    expect(s.p90).toBeLessThanOrEqual(s.p99);
    expect(s.min).toBeLessThanOrEqual(s.p50);
    expect(s.p99).toBeLessThanOrEqual(s.max);
  });

  it("sorts unsorted input before computing", () => {
    const s = computePercentiles([100, 1, 50, 2, 99]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
  });

  it("returns all zeros for an empty array", () => {
    expect(computePercentiles([])).toEqual({
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p99: 0,
    });
  });

  it("returns the single value across every field for a one-element array", () => {
    const s = computePercentiles([7]);
    expect(s).toEqual({ count: 1, min: 7, max: 7, mean: 7, p50: 7, p90: 7, p99: 7 });
  });
});

describe("detectP99Alerts", () => {
  it("flags tasks whose p99 exceeds the threshold and excludes those under", () => {
    const perTask: Record<string, number[]> = {
      slow: Array.from({ length: 100 }, (_, i) => i + 1), // p99 = 100
      fast: [1, 2, 3, 4, 5], // p99 low
    };
    const alerts = detectP99Alerts(perTask, 50);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ taskId: "slow", threshold: 50 });
    expect(alerts[0]!.p99).toBeGreaterThan(50);
  });

  it("excludes a task whose p99 exactly equals the threshold (strictly greater)", () => {
    const alerts = detectP99Alerts({ edge: [10] }, 10);
    expect(alerts).toHaveLength(0);
  });

  it("sorts alerts by p99 descending, tiebreaking by taskId ascending", () => {
    const perTask: Record<string, number[]> = {
      b: [100],
      a: [100],
      c: [200],
      under: [1],
    };
    const alerts = detectP99Alerts(perTask, 50);
    expect(alerts.map((a) => a.taskId)).toEqual(["c", "a", "b"]);
  });

  it("returns an empty list when nothing exceeds the threshold", () => {
    expect(detectP99Alerts({ a: [1, 2, 3] }, 1000)).toEqual([]);
  });
});
