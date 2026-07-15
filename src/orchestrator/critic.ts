// Planning Critic: one cheap read-nothing agent reviews the compiled plan before dispatch.
// Advisory and fail-open — a dead critic never blocks a build; only its explicit "block"
// findings do (and the command layer can override those with --allow-incomplete).
import type { AgentBackend, AgentCall } from "../agents/backend";
import type { CompiledTask } from "./decompose";

export interface CriticFinding {
  taskId: string;
  severity: "info" | "warn" | "block";
  note: string;
}

export interface CriticReport {
  ok: boolean; // false only when block findings exist
  findings: CriticFinding[];
  skipped?: string; // set when the critic could not run (fail-open)
}

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["taskId", "severity", "note"],
        properties: {
          taskId: { type: "string" },
          severity: { enum: ["info", "warn", "block"] },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

const CRITIC_TASK = [
  "You are reviewing an implementation plan (JSON below) that parallel worker agents will execute in isolated worktrees.",
  "Report findings ONLY for real dispatch risks:",
  "- a task whose brief/boundaries contradict its files list (severity: block)",
  "- two tasks that will edit the same file but are not dependency-ordered (severity: block)",
  "- a task with no runnable verify command backing its acceptance criteria (severity: warn)",
  "- vague objectives a cold worker could misread (severity: warn)",
  "Do NOT redesign the plan. Do NOT add scope. Empty findings is a fine answer.",
].join("\n");

export interface CritiqueOptions {
  backend: AgentBackend;
  tasks: CompiledTask[];
  model?: AgentCall["model"];
  timeoutMs?: number;
  log?: (fields: Record<string, unknown>) => void;
}

export async function critiquePlan(opts: CritiqueOptions): Promise<CriticReport> {
  const res = await opts.backend.invoke<{ findings: CriticFinding[] }>({
    component: "orchestrator",
    taskKind: "review",
    task: CRITIC_TASK,
    inputs: { reasoning: JSON.stringify(opts.tasks.map(({ compiledContext, ...t }) => t)) },
    ...(opts.model ? { model: opts.model } : {}),
    effort: "minimal",
    schema: FINDINGS_SCHEMA as unknown as NonNullable<AgentCall["schema"]>,
    tools: "none",
    session: "ephemeral",
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  opts.log?.({ event: "plan_critic", ok: res.ok, findings: res.data?.findings?.length ?? 0, cost_usd: res.usage.costUsd });

  if (!res.ok || !res.data) {
    return { ok: true, findings: [], skipped: res.error?.message ?? "critic returned no data" };
  }
  const findings = res.data.findings ?? [];
  return { ok: !findings.some((f) => f.severity === "block"), findings };
}
