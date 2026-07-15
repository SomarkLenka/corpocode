// Sequential merge-train: one winner at a time into the run-owned integration branch, each
// merge seeing everything already landed. Conflicts abort cleanly and become ordinary
// cheap-authored tasks — resolution is edit selection, not arbitration. Uses merge, never
// rebase (assertSafe forbids history rewrite). The user's branch is untouched (invariant 3):
// landing integration → user branch is Phase 4's explicit human poll.
import { git } from "../git/plumbing";
import type { CommandRunner } from "../install/run";
import type { TasksFile } from "../um/harvest/tasks-schema";

export interface MergeConflict {
  taskId: string;
  branch: string;
  files: string[];
}

export interface IntegrationOutcome {
  merged: Array<{ taskId: string; branch: string }>;
  conflicts: MergeConflict[];
}

export interface IntegrateOptions {
  repoRoot: string;
  integrationBranch: string;
  /** Dedicated worktree holding the integration branch checkout (never the user's tree). */
  integrationWorktree: string;
  winners: Array<{ taskId: string; branch: string }>;
  run: CommandRunner;
  log?: (fields: Record<string, unknown>) => void;
}

export async function integrate(opts: IntegrateOptions): Promise<IntegrationOutcome> {
  const { run, integrationWorktree } = opts;
  const merged: Array<{ taskId: string; branch: string }> = [];
  const conflicts: MergeConflict[] = [];

  // Idempotent: adding an already-added worktree fails harmlessly; the merge below is the
  // loud check that the checkout actually exists.
  try {
    await git(run, opts.repoRoot, ["worktree", "add", integrationWorktree, opts.integrationBranch]);
  } catch {
    // already present from a prior wave — reuse
  }

  for (const winner of opts.winners) {
    try {
      await git(run, integrationWorktree, ["merge", "--no-ff", winner.branch, "-m", `merge(swarm): ${winner.taskId} via ${winner.branch}`]);
      merged.push(winner);
      opts.log?.({ event: "integrate", task_id: winner.taskId, ok: true });
    } catch {
      let files: string[] = [];
      try {
        const out = await git(run, integrationWorktree, ["diff", "--name-only", "--diff-filter=U"]);
        files = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      } catch {
        // conflict-file listing is best-effort
      }
      try {
        await git(run, integrationWorktree, ["merge", "--abort"]);
      } catch {
        // nothing to abort (e.g. merge failed before starting)
      }
      conflicts.push({ taskId: winner.taskId, branch: winner.branch, files });
      opts.log?.({ event: "integrate", task_id: winner.taskId, ok: false, conflict_files: files.length });
    }
  }
  return { merged, conflicts };
}

/** Conflicts become ordinary pending tasks for the next `corpocode build` invocation. */
export function conflictTasks(conflicts: MergeConflict[], originals: TasksFile["tasks"]): TasksFile["tasks"] {
  return conflicts.map((c, i) => {
    const original = originals.find((t) => t.id === c.taskId);
    return {
      id: `${c.taskId}-conflict-${i + 1}`,
      title: `Resolve merge conflict from ${c.taskId}`,
      description:
        `The branch ${c.branch} passed verification but conflicts with the integration branch. ` +
        `Merge that branch's changes into the current state of these files, preserving both sides' intent: ${c.files.join(", ")}. ` +
        `Most conflicts are edit selection — prefer combining existing hunks over writing new code.`,
      files: c.files.length > 0 ? c.files : (original?.files ?? []),
      ...(original?.verifyCommand ? { verifyCommand: original.verifyCommand } : {}),
      acceptanceCriteria: original?.acceptanceCriteria ?? [],
      dependsOn: [],
      status: "pending" as const,
      specRefs: original?.specRefs ?? [],
    };
  });
}
