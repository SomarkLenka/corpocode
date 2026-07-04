// Pure plan producer for the consequence fan-out: one cheap read-only agent per option×axis, all
// declared in an OrchestrationPlan the engine executes. No model call happens here — the loop runs
// the plan and poll-synth folds the results, so this stays trivially testable structure.
import type { JsonSchema, ModelRef } from "../agents/backend";
import type { ComponentName } from "../config/schema";
import type { AgentTask, OrchestrationPlan } from "../intelligence/types";
import type { DecisionFork } from "./types";

/** What one consequence agent returns — the structured half of an AxisFinding (axis/optionId are
 *  ours from the task id, ok comes from the invoke result, so the model only authors these two). */
export interface AxisFindingPayload {
  summary: string;
  severity: "info" | "warn" | "risk";
}

export const AXIS_FINDING_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "one or two sentences: the concrete trade-off on this axis" },
    severity: { type: "string", enum: ["info", "warn", "risk"] },
  },
  required: ["summary", "severity"],
  additionalProperties: false,
};

export interface ConsequencePlanConfig {
  axes: string[];
  fanoutWidth: number;
  component: ComponentName;
  model?: ModelRef;
  effort: "minimal" | "medium" | "high";
  timeoutMs?: number;
  /** Candidate grounding paths (never contents) — the read-only agent decides what to open. */
  files?: string[];
  renderPrompt: (axis: string, option: { id: string; label: string; description?: string }) => string;
}

/** One AgentTask per option×axis. Task ids are `${optionId}::${axis}` — poll-synth keys its findings
 *  matrix on that exact shape, so a missing result maps to a visible "unanalyzed" cell, never a gap.
 *  keepAll judge: failed tasks must SURVIVE into the result so poll-synth can render the gap. */
export function consequencePlan(fork: DecisionFork, cfg: ConsequencePlanConfig): OrchestrationPlan {
  const tasks: AgentTask<AxisFindingPayload>[] = [];
  for (const option of fork.options) {
    for (const axis of cfg.axes) {
      tasks.push({
        id: `${option.id}::${axis}`,
        call: {
          component: cfg.component,
          taskKind: "consequence",
          task: cfg.renderPrompt(axis, option),
          inputs: cfg.files ? { files: cfg.files } : undefined,
          model: cfg.model,
          effort: cfg.effort,
          schema: AXIS_FINDING_JSON_SCHEMA,
          tools: "read-only",
          session: "ephemeral",
          timeoutMs: cfg.timeoutMs,
        },
      });
    }
  }
  return { tasks, fanoutWidth: cfg.fanoutWidth, judge: (results) => results };
}
