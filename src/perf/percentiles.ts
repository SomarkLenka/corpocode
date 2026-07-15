// Pure percentile stats over a bag of numbers, plus per-task p99 alerting. No clock, no randomness —
// a measurement layer the orchestrator and bench rig can fold latency/cost samples through.
//
// The percentile index mirrors the whitelist telemetry idiom exactly (sort ascending, then
// idx = min(len-1, floor((p/100)*len))), so every surface reports the same p50/p90/p99.

export interface PercentileStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Distribution stats for a set of samples. Empty input → all zeros; mean = sum/len. */
export function computePercentiles(values: number[]): PercentileStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p99: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}

export interface TaskPerfAlert {
  taskId: string;
  p99: number;
  threshold: number;
}

/**
 * Flag every task whose p99 latency (or any sampled metric) is strictly greater than `threshold`.
 * Deterministic: sorted by p99 descending, tiebroken by taskId ascending.
 */
export function detectP99Alerts(
  perTask: Record<string, number[]>,
  threshold: number,
): TaskPerfAlert[] {
  const alerts: TaskPerfAlert[] = [];
  for (const taskId of Object.keys(perTask)) {
    const p99 = computePercentiles(perTask[taskId]!).p99;
    if (p99 > threshold) alerts.push({ taskId, p99, threshold });
  }
  alerts.sort((a, b) => (b.p99 - a.p99) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return alerts;
}
