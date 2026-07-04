// The decompose stage: approved spec → validated task graph. Cheapest evidence first, the same
// funnel discipline as verification: if the spec's own seeds already form a complete, valid graph
// (every task carries a deterministic verifyCommand and operational criteria), NOT ONE model token
// is spent — the deterministic emit is the answer. Only an incomplete graph reaches the decompose
// agent, and its output is validated with the same battery; fatal issues feed back into a bounded
// re-decompose before the caller escalates to the pilot. A run can never dead-end silently here.
import type { AgentResult } from "../agents/backend";
import type { Spec } from "../um/spec-schema";
import { emitTasksFile, parseTasksFile, tasksFileSchema, type TasksFile } from "../um/harvest/tasks-schema";

export type DecomposeIssueKind = "unknown-dep" | "cycle" | "missing-verify" | "empty-criteria" | "file-overlap";

export interface DecomposeIssue {
  kind: DecomposeIssueKind;
  /** Fatal issues block the graph; non-fatal ones are surfaced and carried (the scheduler
   *  serializes overlapping tasks rather than refusing them). */
  fatal: boolean;
  detail: string;
}

/** Validate a task graph against the pcvelz/superpowers plan discipline: acyclic, every dependsOn
 *  resolvable, every task deterministically verifiable with non-empty criteria; concurrent tasks
 *  (no dependency path either way) sharing a file are flagged for serialization. Pure. */
export function validateTasks(file: TasksFile): DecomposeIssue[] {
  const issues: DecomposeIssue[] = [];
  const ids = new Set(file.tasks.map((t) => t.id));

  for (const task of file.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) issues.push({ kind: "unknown-dep", fatal: true, detail: `${task.id} -> ${dep}` });
    }
    if (!task.verifyCommand || !task.verifyCommand.trim()) {
      issues.push({ kind: "missing-verify", fatal: true, detail: task.id });
    }
    if (task.acceptanceCriteria.length === 0) {
      issues.push({ kind: "empty-criteria", fatal: true, detail: task.id });
    }
  }

  // Cycle detection: iterative three-color DFS (a pathological graph must not blow the stack).
  const edges = new Map(file.tasks.map((t) => [t.id, t.dependsOn.filter((d) => ids.has(d))] as const));
  const mark = new Map<string, "visiting" | "done">();
  for (const root of ids) {
    if (mark.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    mark.set(root, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = edges.get(frame.id) ?? [];
      if (frame.next < deps.length) {
        const dep = deps[frame.next++]!;
        const state = mark.get(dep);
        if (state === "visiting") {
          const path = stack.map((f) => f.id).slice(stack.findIndex((f) => f.id === dep));
          issues.push({ kind: "cycle", fatal: true, detail: [...path, dep].join(" -> ") });
        } else if (state === undefined) {
          mark.set(dep, "visiting");
          stack.push({ id: dep, next: 0 });
        }
      } else {
        mark.set(frame.id, "done");
        stack.pop();
      }
    }
  }

  // File-overlap between tasks with no ordering between them — legal, but the scheduler must
  // serialize, so it is surfaced now rather than discovered as a mid-run merge conflict.
  const reachable = transitiveClosure(edges);
  for (let i = 0; i < file.tasks.length; i++) {
    for (let j = i + 1; j < file.tasks.length; j++) {
      const a = file.tasks[i]!;
      const b = file.tasks[j]!;
      if (reachable.get(a.id)?.has(b.id) || reachable.get(b.id)?.has(a.id)) continue;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length > 0) {
        issues.push({ kind: "file-overlap", fatal: false, detail: `${a.id} ∩ ${b.id}: ${shared.join(", ")}` });
      }
    }
  }

  return issues;
}

/** dependsOn reachability per task (which tasks each one is ordered AFTER, transitively). */
function transitiveClosure(edges: Map<string, readonly string[]>): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, guard: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (guard.has(id)) return new Set(); // cycle — already reported as fatal; don't recurse forever
    guard.add(id);
    const out = new Set<string>();
    for (const dep of edges.get(id) ?? []) {
      out.add(dep);
      for (const t of visit(dep, guard)) out.add(t);
    }
    guard.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const id of edges.keys()) visit(id, new Set());
  return memo;
}

export interface DecomposeDeps {
  /** One decompose-agent call: rendered prompt in, (fail-open) result out. */
  invoke: (prompt: string) => Promise<AgentResult>;
  /** Render the decompose prompt; `feedback` carries the previous attempt's fatal issues. */
  renderPrompt: (spec: Spec, feedback?: string) => string;
  /** Attempts including the first (default 2 = one corrective retry). */
  maxAttempts?: number;
  log?: (line: Record<string, unknown>) => void;
}

export type DecomposeOutcome =
  | { ok: true; file: TasksFile; issues: DecomposeIssue[]; usedAgent: boolean; costUsd: number }
  | { ok: false; error: string; issues: DecomposeIssue[]; costUsd: number };

/** Grow the approved spec into a validated task graph. The caller owns what happens on
 *  `ok: false` — the escalation poll belongs to the command, not to this stage. */
export async function decompose(spec: Spec, deps: DecomposeDeps): Promise<DecomposeOutcome> {
  const log = deps.log ?? ((): void => {});

  // Tier 1 — deterministic: the seeds themselves, when complete, cost nothing.
  const emitted = emitTasksFile(spec);
  if (emitted.ok) {
    const issues = validateTasks(emitted.file);
    if (!issues.some((i) => i.fatal)) {
      log({ event: "decompose", used_agent: false, tasks: emitted.file.tasks.length, issues: issues.length });
      return { ok: true, file: emitted.file, issues, usedAgent: false, costUsd: 0 };
    }
  }

  // Tier 2 — the decompose agent, with the previous attempt's fatal issues fed back verbatim.
  const maxAttempts = deps.maxAttempts ?? 2;
  let feedback = emitted.ok
    ? formatIssues(validateTasks(emitted.file).filter((i) => i.fatal))
    : emitted.error;
  let costUsd = 0;
  let lastError = feedback;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await deps.invoke(deps.renderPrompt(spec, feedback));
    costUsd += result.usage.costUsd;
    if (!result.ok) {
      lastError = result.error?.message ?? "decompose agent failed";
      feedback = lastError;
      continue;
    }
    const seeds = extractSeeds(result);
    if (!seeds) {
      lastError = "decompose agent returned no parseable taskSeeds";
      feedback = lastError;
      continue;
    }
    // The agent's graph replaces the seeds wholesale; run it through the same schema + battery
    // the deterministic path used — the agent earns no laxer standard than the spec did.
    const candidate = parseTasksFile({
      version: 1,
      tasks: seeds.map((s) => ({ ...s, status: "pending", specRefs: s.acceptanceRefs ?? [] })),
    });
    if (!candidate) {
      lastError = "decompose agent output did not validate against the tasks schema";
      feedback = lastError;
      continue;
    }
    const issues = validateTasks(candidate);
    const fatal = issues.filter((i) => i.fatal);
    if (fatal.length === 0) {
      log({ event: "decompose", used_agent: true, attempt, tasks: candidate.tasks.length, issues: issues.length, cost_usd: costUsd });
      return { ok: true, file: candidate, issues, usedAgent: true, costUsd };
    }
    lastError = formatIssues(fatal);
    feedback = lastError;
    log({ event: "decompose_retry", attempt, fatal: fatal.length });
  }

  log({ event: "decompose_failed", cost_usd: costUsd });
  return { ok: false, error: lastError, issues: [], costUsd };
}

function formatIssues(issues: DecomposeIssue[]): string {
  return issues.map((i) => `${i.kind}: ${i.detail}`).join("; ");
}

interface AgentSeed {
  id: string;
  title?: string;
  description?: string;
  files?: string[];
  dependsOn?: string[];
  verifyCommand?: string;
  acceptanceRefs?: string[];
  acceptanceCriteria?: string[];
  modelTier?: string;
  userGate?: boolean;
}

/** Pull `{taskSeeds:[...]}` out of a (schema'd or text) agent result, tolerantly. The seeds are
 *  then coerced through the real tasks schema, so this only needs to find the array. */
function extractSeeds(result: AgentResult): AgentSeed[] | null {
  const raw = result.data ?? tryJson(result.text);
  if (!raw || typeof raw !== "object") return null;
  const seeds = (raw as { taskSeeds?: unknown }).taskSeeds;
  if (!Array.isArray(seeds) || seeds.length === 0) return null;
  // Map acceptanceRefs → inlined criteria where the spec is not in hand: the agent may emit
  // either; validateTasks demands non-empty acceptanceCriteria, so refs alone are carried as
  // criteria text when no criteria were given (the ref IS the testable statement the agent chose).
  return seeds.map((s) => {
    const seed = s as AgentSeed;
    const criteria = seed.acceptanceCriteria?.length ? seed.acceptanceCriteria : seed.acceptanceRefs ?? [];
    return { ...seed, acceptanceCriteria: criteria };
  });
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Re-validate an imported plan (used by --from-plan): schema-parse + the full battery. */
export function validateImportedPlan(raw: unknown): { file: TasksFile; issues: DecomposeIssue[] } | null {
  const file = tasksFileSchema.safeParse(raw).success ? parseTasksFile(raw) : null;
  if (!file) return null;
  return { file, issues: validateTasks(file) };
}
