// The cost-quality record every run publishes: completed%, $/task, token split, wall-clock.
// $/task uses TOTAL spend over completed tasks — failed attempts are real costs of the wins.
import { aggregateByTask, type CostEvent, type TaskCostRollup } from "../cost/tracker";
import type { TaskOutcome } from "./swarm";

export interface RunReport {
  runId: string;
  tasksTotal: number;
  completed: number;
  failed: number;
  skipped: number;
  conflicts: number;
  attempts: number;
  totalCostUsd: number;
  costPerCompletedTaskUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  wallClockMs: number;
  perTask: Record<string, TaskCostRollup>;
  halted?: string;
}

export interface BuildReportOptions {
  runId: string;
  outcomes: TaskOutcome[];
  conflicts: number;
  costEvents: CostEvent[];
  wallClockMs: number;
  halted?: string;
}

export function buildRunReport(opts: BuildReportOptions): RunReport {
  const completed = opts.outcomes.filter((o) => o.status === "completed").length;
  const totalCostUsd = opts.costEvents.reduce((sum, e) => sum + e.costUsd, 0);
  return {
    runId: opts.runId,
    tasksTotal: opts.outcomes.length,
    completed,
    failed: opts.outcomes.filter((o) => o.status === "failed").length,
    skipped: opts.outcomes.filter((o) => o.status === "skipped").length,
    conflicts: opts.conflicts,
    attempts: opts.outcomes.reduce((sum, o) => sum + o.attempts.length, 0),
    totalCostUsd,
    costPerCompletedTaskUsd: completed > 0 ? totalCostUsd / completed : null,
    inputTokens: opts.costEvents.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0),
    outputTokens: opts.costEvents.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0),
    wallClockMs: opts.wallClockMs,
    perTask: aggregateByTask(opts.costEvents),
    ...(opts.halted ? { halted: opts.halted } : {}),
  };
}
