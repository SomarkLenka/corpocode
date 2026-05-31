// `corpocode stats` — read the NDJSON log and report cost per component/provider, an estimate of
// savings against a no-CorpoCode baseline, and error rates over a window.
import { readFileSync } from "node:fs";
import { logFile } from "../config/paths";
import { aggregateCosts, type CostEvent } from "../cost/tracker";

// Rough estimate of how much the same offloaded work would cost on the main (expensive) model. The
// cheap-model tier runs ~15× cheaper than an Opus-class model, so each dollar of cheap spend stands
// in for ~15 dollars of expensive spend; net savings is the difference. Labeled "estimated".
const BASELINE_MULTIPLIER = 14;

export interface StatsReport {
  windowDays: number;
  events: number;
  totalCostUsd: number;
  byComponent: Record<string, number>;
  byProvider: Record<string, number>;
  errorRate: number;
  estimatedSavingsUsd: number;
  latencyMs: { p50: number; p90: number; p99: number };
}

interface LogRecord {
  ts?: string;
  event?: string;
  component?: string;
  provider?: string;
  cost_usd?: number;
  latency_ms?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function computeStats(lines: string[], opts: { days?: number; now?: number } = {}): StatsReport {
  const now = opts.now ?? Date.now();
  const cutoff = opts.days ? now - opts.days * 86_400_000 : 0;

  let events = 0;
  let errors = 0;
  const costEvents: CostEvent[] = [];
  const latencies: number[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (cutoff && rec.ts) {
      const ts = Date.parse(rec.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
    }
    events += 1;
    if (rec.event === "hook_error") errors += 1;
    if (typeof rec.cost_usd === "number") {
      costEvents.push({ ts: rec.ts ?? "", component: rec.component, provider: rec.provider, costUsd: rec.cost_usd });
    }
    if (typeof rec.latency_ms === "number") latencies.push(rec.latency_ms);
  }

  const totals = aggregateCosts(costEvents);
  latencies.sort((a, b) => a - b);
  return {
    windowDays: opts.days ?? 0,
    events,
    totalCostUsd: totals.totalUsd,
    byComponent: totals.byComponent,
    byProvider: totals.byProvider,
    errorRate: events ? errors / events : 0,
    estimatedSavingsUsd: totals.totalUsd * BASELINE_MULTIPLIER,
    latencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), p99: percentile(latencies, 99) },
  };
}

function readLogLines(): string[] {
  try {
    return readFileSync(logFile(), "utf8").split("\n"); // project-local log in the cwd
  } catch {
    return [];
  }
}

interface StatsFlags {
  json: boolean;
  days?: number;
}

function parseFlags(argv: string[]): StatsFlags {
  const flags: StatsFlags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") flags.json = true;
    else if (argv[i] === "--days") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) flags.days = n;
    }
  }
  return flags;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function runStatsCommand(argv: string[], env?: NodeJS.ProcessEnv): void {
  const flags = parseFlags(argv);
  const report = computeStats(readLogLines(), { days: flags.days });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const window = report.windowDays ? `last ${report.windowDays} day(s)` : "all time";
  process.stdout.write(`CorpoCode stats (${window})\n`);
  process.stdout.write(`  events: ${report.events}\n`);
  process.stdout.write(`  total cost: ${formatUsd(report.totalCostUsd)}\n`);
  process.stdout.write(`  estimated savings vs all-expensive baseline: ${formatUsd(report.estimatedSavingsUsd)}\n`);
  process.stdout.write(`  error rate: ${(report.errorRate * 100).toFixed(1)}%\n`);
  process.stdout.write(
    `  latency: p50 ${report.latencyMs.p50}ms · p90 ${report.latencyMs.p90}ms · p99 ${report.latencyMs.p99}ms\n`,
  );
  process.stdout.write("  cost by component:\n");
  for (const [k, v] of Object.entries(report.byComponent)) process.stdout.write(`    ${k}: ${formatUsd(v)}\n`);
  process.stdout.write("  cost by provider:\n");
  for (const [k, v] of Object.entries(report.byProvider)) process.stdout.write(`    ${k}: ${formatUsd(v)}\n`);
}
