// The telemetry payload — defined as a WHITELIST, never a blacklist. Only the aggregate, non-identifying
// fields enumerated here are ever built, which is a stronger guarantee than trying to scrub a richer
// payload: a field that isn't constructed can't leak. The builder reads the NDJSON log and emits only
// counts, distributions, and percentiles. It NEVER copies a string the log carries (prompts, code, file
// paths, decisions, memory) — so there is nothing identifying to transmit by construction.
import type { CorpoConfig } from "../config/schema";
import { aggregateCosts, type CostEvent } from "../cost/tracker";

export const TELEMETRY_SCHEMA = "corpocode-telemetry/1" as const;

// Same baseline the `stats` command uses, so the savings figure is comparable across surfaces.
const BASELINE_MULTIPLIER = 14;

export interface TelemetryPayload {
  schema: typeof TELEMETRY_SCHEMA;
  events: number;
  hookInvocations: Record<string, number>; // counts by event name
  modelChoices: Record<string, number>; // distribution of models used
  effortChoices: Record<string, number>; // distribution of effort levels
  totalCostUsd: number;
  estimatedSavingsUsd: number;
  errorRate: number;
  backends: { knowledgeGraph: string; contextStore: string; memoryStore: string };
  latencyMs: { p50: number; p90: number; p99: number };
}

/** The exact set of top-level keys that may ever be transmitted. The preview/tests assert against it. */
export const TELEMETRY_FIELDS: ReadonlyArray<keyof TelemetryPayload> = [
  "schema",
  "events",
  "hookInvocations",
  "modelChoices",
  "effortChoices",
  "totalCostUsd",
  "estimatedSavingsUsd",
  "errorRate",
  "backends",
  "latencyMs",
];

interface LogRecord {
  event?: string;
  component?: string;
  provider?: string;
  model?: string;
  cost_usd?: number;
  latency_ms?: number;
  decision?: { effort?: string };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function bump(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

export function buildTelemetryPayload(lines: string[], config: CorpoConfig): TelemetryPayload {
  const hookInvocations: Record<string, number> = {};
  const modelChoices: Record<string, number> = {};
  const effortChoices: Record<string, number> = {};
  const costEvents: CostEvent[] = [];
  const latencies: number[] = [];
  let events = 0;
  let errors = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    events += 1;
    bump(hookInvocations, rec.event);
    bump(modelChoices, rec.model);
    bump(effortChoices, rec.decision?.effort);
    if (rec.event === "hook_error") errors += 1;
    if (typeof rec.cost_usd === "number") {
      costEvents.push({ ts: "", component: rec.component, provider: rec.provider, costUsd: rec.cost_usd });
    }
    if (typeof rec.latency_ms === "number") latencies.push(rec.latency_ms);
  }

  const totals = aggregateCosts(costEvents);
  latencies.sort((a, b) => a - b);

  return {
    schema: TELEMETRY_SCHEMA,
    events,
    hookInvocations,
    modelChoices,
    effortChoices,
    totalCostUsd: totals.totalUsd,
    estimatedSavingsUsd: totals.totalUsd * BASELINE_MULTIPLIER,
    errorRate: events ? errors / events : 0,
    backends: { ...config.backends },
    latencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), p99: percentile(latencies, 99) },
  };
}
