// The orchestration vocabulary. An action-pattern produces an OrchestrationPlan; the engine executes it
// and returns an OrchestrationResult. The engine is deliberately ignorant of WHAT any agent does — the
// agent-loop shape (which tasks, fan-out width, session policy, judging) lives entirely in the plan a
// pattern emits, so patterns evolve without touching the engine.
import type { AgentCall, AgentResult } from "../agents/backend";

/** One agent invocation in a plan, with a stable id for attribution + ordering (e.g. a file path). */
export interface AgentTask<T = unknown> {
  id: string;
  call: AgentCall<T>;
}

/** The outcome of one task: its id + the backend's (already fail-open) AgentResult. */
export interface AgentTaskResult<T = unknown> {
  id: string;
  result: AgentResult<T>;
}

/** A pure filter/rank over task results — the pattern's judging policy, kept OUT of the engine. The
 *  default keeps the successful results; a pattern can supply a confidence/fit filter instead. */
export type Judge = (results: AgentTaskResult[]) => AgentTaskResult[];

/** A declarative orchestration: a fan-out group of agent tasks, a bounded width, and an optional judge. */
export interface OrchestrationPlan {
  tasks: AgentTask[];
  fanoutWidth?: number; // local parallelism cap; the process-global limiter still bounds it
  judge?: Judge; // default: keep ok results
}

export interface OrchestrationUsage {
  costUsd: number;
  latencyMs: number; // wall-clock of the whole run
  calls: number; // agent invocations attempted
  succeeded: number; // invocations that returned ok
}

export interface OrchestrationResult {
  ok: boolean; // at least one surviving (judged) task
  tasks: AgentTaskResult[]; // surviving results, in plan order
  usage: OrchestrationUsage;
}

/** The per-hook intent a thin handler builds; an action-pattern switches on `kind` to produce a plan. */
export type Intent =
  | { kind: "prompt"; prompt: string; sessionId: string; transcriptPath: string }
  | { kind: "pre-write"; file: string; proposedContent?: string; sessionId: string; transcriptPath: string }
  | { kind: "pre-read"; file: string; sessionId: string; transcriptPath: string }
  | { kind: "post-write"; file: string; sessionId: string; transcriptPath: string };
