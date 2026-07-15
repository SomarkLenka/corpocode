// TTL garbage collection of old runs. A completed run leaves branches (integration, clean, and one
// per attempt) and a run dir full of worktrees, journals, and artifacts. After `runs_ttl_days` they
// are dead weight; this reaps them so the repo's ref namespace and disk don't grow without bound.
//
// Everything destructive here is best-effort and pure of its own clock/fs: `now`, `removeDir`,
// `runDirOf`, and the CommandRunner are all injected. A single failed branch delete or dir removal
// never aborts the sweep — GC is opportunistic cleanup, not a gate. `branch -D` and `worktree prune`
// are allowed by assertSafe (neither is a push, hard reset, or history rewrite). The user's branch is
// never in scope — only `corpocode/<runId>/*` refs are ever touched.
import { git } from "../git/plumbing";
import type { CommandRunner } from "../install/run";
import type { RunRecord } from "./run";

export interface GcOptions {
  runs: RunRecord[];
  repoRoot: string;
  run: CommandRunner;
  /** Runs older than this (now - createdAt > ttlMs) are collected. */
  ttlMs: number;
  now: number;
  removeDir: (path: string) => void;
  runDirOf: (runId: string) => string;
  log?: (fields: Record<string, unknown>) => void;
}

export interface GcResult {
  collected: string[];
  kept: string[];
}

/** List a run's branches (`corpocode/<runId>/*`), stripping git's leading marker/whitespace. */
async function listRunBranches(run: CommandRunner, repoRoot: string, runId: string): Promise<string[]> {
  const out = await git(run, repoRoot, ["branch", "--list", `corpocode/${runId}/*`]);
  return out
    .split("\n")
    .map((line) => line.replace(/^[*\s]+/, "").trim())
    .filter((line) => line.length > 0);
}

export async function gcRuns(opts: GcOptions): Promise<GcResult> {
  const { runs, repoRoot, run, ttlMs, now, removeDir, runDirOf, log } = opts;
  const collected: string[] = [];
  const kept: string[] = [];

  for (const record of runs) {
    // <= keeps the boundary run: only strictly-older-than-ttl runs are reaped.
    if (now - record.createdAt <= ttlMs) {
      kept.push(record.id);
      continue;
    }

    let branches: string[] = [];
    try {
      branches = await listRunBranches(run, repoRoot, record.id);
    } catch {
      branches = []; // can't list — still remove the dir below; the refs are harmless if orphaned
    }
    for (const branch of branches) {
      try {
        await git(run, repoRoot, ["branch", "-D", branch]);
      } catch {
        // best-effort: a stuck ref must not abort the sweep
      }
    }
    try {
      removeDir(runDirOf(record.id));
    } catch {
      // best-effort: a locked dir must not abort the sweep
    }
    collected.push(record.id);
    log?.({ event: "gc_collect", runId: record.id, branches });
  }

  // One prune after the loop clears the stale worktree registrations left by the removed run dirs.
  if (collected.length > 0) {
    try {
      await git(run, repoRoot, ["worktree", "prune"]);
    } catch {
      // best-effort
    }
  }

  return { collected, kept };
}
