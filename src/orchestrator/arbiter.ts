// The arbiter call: the ONLY strong-model component in CorpoCode. It READS a candidate diff plus a
// rubric derived from the human-approved acceptance criteria and emits ONE tiny structured verdict —
// accept / reject / spec-gap. It authors nothing; a cheap agent writes any rescue from its prose.
//
// Unlike the fail-open critic, a dead arbiter NEVER silently accepts: no verdict means the candidate
// is unverified, and the caller (verify-rescue) escalates rather than landing an unjudged diff.
import type { AgentBackend, ModelRef } from "../agents/backend";
import type { AgentCall } from "../agents/backend";
import { normalizeVerdict, VERDICT_SCHEMA, type ArbiterVerdict } from "./verdict";

export interface ArbitrateOptions {
  backend: AgentBackend;
  task: { id: string; specRefs: string[] };
  diff: string;
  rubric: string;
  model?: ModelRef;
  maxOutputTokens?: number;
  log?: (fields: Record<string, unknown>) => void;
}

export interface ArbitrateResult {
  ok: boolean;
  verdict?: ArbiterVerdict;
  skipped?: string; // set when no verdict was produced (dead arbiter / empty data)
  costUsd: number;
}

const ARBITER_TASK = [
  "You are the arbiter: the single expensive judge over a candidate code diff.",
  "Judge the diff ONLY against the rubric criteria supplied below — each is one acceptance bar.",
  "Do NOT invent new requirements, restyle, or grade code you were not asked to. Read, then decide.",
  "For every rubric criterion emit { id, met, note } with a terse one-line note.",
  "Emit decision = accept when every criterion is met; reject when any is unmet;",
  "spec-gap when the diff is defensible but the rubric itself is silent or contradictory —",
  "list those holes in specGaps so they route back to the human. Keep the whole verdict terse.",
].join("\n");

/**
 * Run the arbiter over a candidate diff + rubric. Structured output validated against VERDICT_SCHEMA
 * by the backend; the returned verdict is normalized (spec holes routed to spec-gap). On any failure
 * — backend error or empty data — returns ok:false with a skipped reason and NO verdict.
 */
export async function arbitrate(opts: ArbitrateOptions): Promise<ArbitrateResult> {
  const res = await opts.backend.invoke<ArbiterVerdict>({
    component: "arbiter",
    taskKind: "review",
    task: ARBITER_TASK,
    inputs: { reasoning: opts.rubric, decisions: opts.diff },
    ...(opts.model ? { model: opts.model } : {}),
    effort: "high",
    schema: VERDICT_SCHEMA as unknown as NonNullable<AgentCall["schema"]>,
    tools: "none",
    session: "ephemeral",
  });

  const costUsd = res.usage.costUsd;
  opts.log?.({ event: "arbiter", task_id: opts.task.id, ok: res.ok, decision: res.data?.decision ?? null, cost_usd: costUsd });

  if (!res.ok || !res.data) {
    return { ok: false, skipped: res.error?.message ?? "arbiter returned no verdict", costUsd };
  }
  return { ok: true, verdict: normalizeVerdict(res.data), costUsd };
}
