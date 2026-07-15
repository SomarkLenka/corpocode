// Cost aggregation. Every provider call computes its own costUsd locally (see providers/pricing.ts),
// so spend is comparable across vendors. This module rolls those per-call figures into
// per-component, per-provider, and per-day totals — the same logic `corpocode stats` runs over
// the NDJSON log, and that a single process can use in-memory.

export interface CostEvent {
  ts: string; // ISO timestamp; the day bucket (UTC YYYY-MM-DD) is derived from it
  component?: string;
  provider?: string;
  model?: string;
  costUsd: number;
  // Orchestrator attribution (Phase 2): present on swarm-phase events only.
  runId?: string;
  waveId?: number;
  taskId?: string;
  attempt?: number;
  role?: string; // "implement" | "review" | ...
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostTotals {
  totalUsd: number;
  count: number;
  byComponent: Record<string, number>;
  byProvider: Record<string, number>;
  byDay: Record<string, number>;
  /** Keyed "component|provider|day" for the finest-grained breakdown. */
  byComponentProviderDay: Record<string, number>;
}

const UNKNOWN = "unknown";

/** UTC calendar day for a timestamp; "unknown" if it cannot be parsed. */
export function dayOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? UNKNOWN : d.toISOString().slice(0, 10);
}

function add(bucket: Record<string, number>, key: string, amount: number): void {
  bucket[key] = (bucket[key] ?? 0) + amount;
}

export function emptyTotals(): CostTotals {
  return {
    totalUsd: 0,
    count: 0,
    byComponent: {},
    byProvider: {},
    byDay: {},
    byComponentProviderDay: {},
  };
}

/** Fold a stream of cost events into totals. Missing component/provider bucket under "unknown". */
export function aggregateCosts(events: Iterable<CostEvent>): CostTotals {
  const totals = emptyTotals();
  for (const e of events) {
    const cost = Number.isFinite(e.costUsd) ? e.costUsd : 0;
    const component = e.component ?? UNKNOWN;
    const provider = e.provider ?? UNKNOWN;
    const day = dayOf(e.ts);
    totals.totalUsd += cost;
    totals.count += 1;
    add(totals.byComponent, component, cost);
    add(totals.byProvider, provider, cost);
    add(totals.byDay, day, cost);
    add(totals.byComponentProviderDay, `${component}|${provider}|${day}`, cost);
  }
  return totals;
}

export interface TaskCostRollup {
  costUsd: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Per-task rollup for run reports; ignores events without a taskId. */
export function aggregateByTask(events: Iterable<CostEvent>): Record<string, TaskCostRollup> {
  const out: Record<string, TaskCostRollup> = {};
  for (const e of events) {
    if (!e.taskId) continue;
    const r = (out[e.taskId] ??= {
      costUsd: 0,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    r.costUsd += e.costUsd;
    r.attempts += 1;
    r.inputTokens += e.inputTokens ?? 0;
    r.outputTokens += e.outputTokens ?? 0;
    r.cacheReadTokens += e.cacheReadTokens ?? 0;
    r.cacheWriteTokens += e.cacheWriteTokens ?? 0;
  }
  return out;
}

export interface CostTracker {
  record(event: CostEvent): void;
  totals(): CostTotals;
}

/** In-memory accumulator for a single process. Mirrors aggregateCosts incrementally. */
export function createCostTracker(): CostTracker {
  const events: CostEvent[] = [];
  return {
    record: (event) => {
      events.push(event);
    },
    totals: () => aggregateCosts(events),
  };
}
