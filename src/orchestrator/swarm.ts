// The wave executor. Cheap workers author in isolated worktrees; deterministic verification
// picks winners; hard caps (budget, per-attempt and per-run wall-clock, lease TTLs) bound every
// loop — the $4,200-in-63-hours failure mode is a config knob here, not a possibility.
// Attempts are independent fresh samples (resample-first): no feedback threads between them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackend, AgentCall } from "../agents/backend";
import type { CostEvent } from "../cost/tracker";
import type { CompiledTask } from "./decompose";
import type { MechanicalVerdict } from "./verify-mechanical";
import type { Workspace } from "./workspace";

export interface AttemptRecord {
  attempt: number;
  branch: string;
  worktree: string;
  agentOk: boolean;
  verdict?: MechanicalVerdict;
  costUsd: number;
  latencyMs: number;
}

export interface TaskOutcome {
  taskId: string;
  status: "completed" | "failed" | "skipped";
  winner?: { branch: string; attempt: number; diffBytes: number };
  attempts: AttemptRecord[];
}

export interface SwarmResult {
  outcomes: TaskOutcome[];
  halted?: string;
}

export interface SwarmDeps {
  runId: string;
  tasks: CompiledTask[];
  waves: string[][];
  swarmConfig: { max_parallel_writers: number; attempts_per_task: number; task_wallclock_ms: number; run_wallclock_ms: number };
  workspace: Pick<Workspace, "create" | "removeIfClean">;
  /** A write-capable backend rooted at the given worktree (fresh instance per attempt). */
  implementFor: (worktreePath: string) => AgentBackend;
  implementModel?: AgentCall["model"];
  verify: (worktreePath: string, task: CompiledTask) => Promise<MechanicalVerdict>;
  /** Wave-end integration (Task 13); next wave's worktrees branch from its result. */
  onWaveComplete: (winners: Array<{ taskId: string; branch: string }>, waveIndex: number) => Promise<void>;
  budget: { wouldExceed(phase: "build", projectedUsd?: number): boolean; charge(phase: "build", usd: number): void };
  leaseDir: string;
  log: (fields: Record<string, unknown>) => void;
  recordCost?: (event: CostEvent) => void;
  now?: () => number;
}

const implementPrompt = (t: CompiledTask): string =>
  [
    `OBJECTIVE: ${t.brief.objective}`,
    `OUTPUT FORMAT: ${t.brief.outputFormat}`,
    `TOOL GUIDANCE: ${t.brief.toolGuidance}`,
    `BOUNDARIES: ${t.brief.boundaries}`,
  ].join("\n\n");

function claimLease(dir: string, taskId: string, ttlMs: number, now: number): boolean {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${taskId}.json`);
  try {
    writeFileSync(file, JSON.stringify({ taskId, claimedAt: now, expiresAt: now + ttlMs }), { flag: "wx" });
    return true;
  } catch {
    try {
      const prior = JSON.parse(readFileSync(file, "utf8")) as { expiresAt?: number };
      if (typeof prior.expiresAt === "number" && prior.expiresAt < now) {
        writeFileSync(file, JSON.stringify({ taskId, claimedAt: now, expiresAt: now + ttlMs }));
        return true; // stale lease reaped
      }
    } catch {
      // unreadable lease counts as claimed — err toward not double-running
    }
    return false;
  }
}

function releaseLease(dir: string, taskId: string): void {
  try {
    rmSync(join(dir, `${taskId}.json`), { force: true });
  } catch {
    // best-effort; a stale lease self-expires
  }
}

async function mapBounded<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

export async function runSwarm(deps: SwarmDeps): Promise<SwarmResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const cfg = deps.swarmConfig;
  const byId = new Map(deps.tasks.map((t) => [t.id, t]));
  const outcomes: TaskOutcome[] = [];
  let halted: string | undefined;

  const capHit = (): string | undefined => {
    if (deps.budget.wouldExceed("build")) return "budget wall reached for the build phase";
    if (now() - started > cfg.run_wallclock_ms) return `run wall-clock cap (${cfg.run_wallclock_ms}ms) exceeded`;
    return undefined;
  };

  const runTask = async (taskId: string, waveIndex: number): Promise<TaskOutcome> => {
    const task = byId.get(taskId);
    if (!task) return { taskId, status: "skipped", attempts: [] };
    const leaseTtl = cfg.task_wallclock_ms * cfg.attempts_per_task + 60_000;
    if (!claimLease(deps.leaseDir, taskId, leaseTtl, now())) {
      deps.log({ event: "swarm_task", task_id: taskId, status: "skipped", reason: "lease held" });
      return { taskId, status: "skipped", attempts: [] };
    }
    try {
      const attempts: AttemptRecord[] = [];
      for (let attempt = 1; attempt <= cfg.attempts_per_task; attempt++) {
        const cap = capHit();
        if (cap) {
          halted = cap;
          break;
        }
        const { path, branch } = await deps.workspace.create(taskId, attempt);
        const backend = deps.implementFor(path);
        const res = await backend.invoke({
          component: "orchestrator",
          taskKind: "implement",
          task: implementPrompt(task),
          inputs: { reasoning: task.compiledContext },
          ...(deps.implementModel ? { model: deps.implementModel } : {}),
          effort: "medium",
          tools: { read: true, glob: true, grep: true, write: true },
          session: "ephemeral",
          timeoutMs: cfg.task_wallclock_ms,
        });
        deps.budget.charge("build", res.usage.costUsd);
        deps.recordCost?.({
          ts: new Date(now()).toISOString(),
          component: "orchestrator",
          model: res.model.model,
          costUsd: res.usage.costUsd,
          runId: deps.runId,
          waveId: waveIndex,
          taskId,
          attempt,
          role: "implement",
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
        });

        const verdict = res.ok ? await deps.verify(path, task) : undefined;
        attempts.push({ attempt, branch, worktree: path, agentOk: res.ok, ...(verdict ? { verdict } : {}), costUsd: res.usage.costUsd, latencyMs: res.usage.latencyMs });
        deps.log({ event: "swarm_attempt", task_id: taskId, attempt, agent_ok: res.ok, verdict: verdict?.stage ?? "agent-failed", cost_usd: res.usage.costUsd });

        try {
          await deps.workspace.removeIfClean(path);
        } catch {
          // cleanup is best-effort; a kept worktree is evidence, not an error
        }
        if (verdict?.ok) {
          return { taskId, status: "completed", winner: { branch, attempt, diffBytes: verdict.diffBytes }, attempts };
        }
        // failed candidate: fresh independent attempt next iteration — no feedback threading
      }
      return { taskId, status: "failed", attempts };
    } finally {
      releaseLease(deps.leaseDir, taskId);
    }
  };

  for (let w = 0; w < deps.waves.length; w++) {
    if (halted ?? (halted = capHit())) break;
    const results = await mapBounded(deps.waves[w]!, cfg.max_parallel_writers, (id) => runTask(id, w));
    outcomes.push(...results);
    const winners = results.filter((r) => r.status === "completed" && r.winner).map((r) => ({ taskId: r.taskId, branch: r.winner!.branch }));
    if (winners.length > 0) await deps.onWaveComplete(winners, w);
    deps.log({ event: "swarm_wave", wave: w, tasks: results.length, completed: winners.length, halted: halted ?? null });
  }

  return { outcomes, ...(halted ? { halted } : {}) };
}
