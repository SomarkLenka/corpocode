// The abstract orchestration engine — the acute core of the IntelligentRouter. `run(plan, deps)` executes
// a declarative OrchestrationPlan: a bounded-parallel fan-out of agent tasks, an optional pluggable judge,
// and aggregated usage. It knows NOTHING of what the agents do (that lives in the action-pattern that
// built the plan), so action-patterns can change freely without touching this code.
//
// Fully fail-open (the In-flight tenet): backend.invoke is already fail-open, and we additionally guard
// each task so a misconfigured backend becomes a failed task, never a thrown run. Two concurrency layers,
// exactly like retrieval/fanout.ts: a local fan-out width shapes this run, the process-global limiter
// bounds it against every other fan-out alive in the same hook.
import { globalProviderLimiter, type Limiter } from "../perf/limiter";
import type { AgentBackend, AgentTaskKind } from "../agents/backend";
import type { AgentTaskResult, Judge, OrchestrationPlan, OrchestrationResult } from "./types";

const DEFAULT_FANOUT = 3;

export interface EngineDeps {
  forTask: (kind: AgentTaskKind) => AgentBackend; // resolve the backend per task (from ctx.agents)
  limiter?: Limiter; // default: the process-global ceiling
  now?: () => number;
  log?: (line: Record<string, unknown>) => void; // one NDJSON line per agent + a run summary
}

/** Default judge: keep the tasks whose agent returned ok. A pattern supplies a stricter filter. */
const keepOk: Judge = (results) => results.filter((r) => r.result.ok);

export async function run(plan: OrchestrationPlan, deps: EngineDeps): Promise<OrchestrationResult> {
  const limiter = deps.limiter ?? globalProviderLimiter;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const width = Math.max(1, plan.fanoutWidth ?? DEFAULT_FANOUT);

  const results = await mapBounded(plan.tasks, width, async (task): Promise<AgentTaskResult> => {
    try {
      const backend = deps.forTask(task.call.taskKind);
      const result = await limiter.run(() => backend.invoke(task.call));
      deps.log?.({ event: "agent_item", id: task.id, task_kind: task.call.taskKind, ok: result.ok, cost_usd: result.usage.costUsd, latency_ms: result.usage.latencyMs });
      return { id: task.id, result };
    } catch (err) {
      // Defensive: a build-time misconfig (no backend registered) degrades to a failed task, not a throw.
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: task.id,
        result: { ok: false, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: "" }, model: { providerKey: "", model: "" }, error: { kind: "model_unavailable", message, retryable: false } },
      };
    }
  });

  const judged = (plan.judge ?? keepOk)(results);
  const usage = {
    costUsd: results.reduce((sum, r) => sum + r.result.usage.costUsd, 0),
    latencyMs: now() - started,
    calls: results.length,
    succeeded: results.filter((r) => r.result.ok).length,
  };
  deps.log?.({ event: "orchestrate", calls: usage.calls, succeeded: usage.succeeded, surviving: judged.length, cost_usd: usage.costUsd, latency_ms: usage.latencyMs });
  return { ok: judged.length > 0, tasks: judged, usage };
}

/** Bounded-parallel map preserving input order (mirrors retrieval/fanout.ts:17; the global limiter caps further). */
async function mapBounded<T, R>(items: T[], cap: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  const pool = Math.min(Math.max(1, cap), items.length || 1);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return out;
}
