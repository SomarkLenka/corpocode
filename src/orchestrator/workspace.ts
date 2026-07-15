// Worktree lifecycle for the swarm. Every attempt gets an isolated worktree on its own branch,
// rooted at the run-owned integration branch — the user's branch is never touched. Creation is
// serialized (parallel `git worktree add` hits git config-lock contention); cleanup is
// dirty-state-aware (a dirty worktree is evidence — keep it; the branch survives removal).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../git/plumbing";
import type { CommandRunner } from "../install/run";
import { runDir } from "../config/paths";

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export interface Workspace {
  /** The run's integration branch; created from baseRef on first call. */
  ensureIntegration(): Promise<string>;
  /** Serialized: adds worktrees one at a time. Branch is rooted at the integration branch. */
  create(taskId: string, attempt: number): Promise<WorktreeHandle>;
  isDirty(worktreePath: string): Promise<boolean>;
  removeIfClean(worktreePath: string): Promise<"removed" | "kept-dirty">;
}

export interface WorkspaceOptions {
  runId: string;
  repoRoot: string;
  run: CommandRunner;
  baseRef?: string; // default HEAD
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function createWorkspace(opts: WorkspaceOptions): Workspace {
  const { runId, repoRoot, run } = opts;
  const baseRef = opts.baseRef ?? "HEAD";
  const integration = `corpocode/${runId}/integration`;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const copyIncludes = (worktreePath: string): void => {
    const includeFile = join(repoRoot, ".worktreeinclude");
    if (!existsSync(includeFile)) return;
    const lines = readFileSync(includeFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const rel of lines) {
      const src = join(repoRoot, rel);
      if (!existsSync(src)) continue; // absent sources are fine — the file lists "if present" needs
      const dest = join(worktreePath, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  };

  return {
    async ensureIntegration(): Promise<string> {
      try {
        await git(run, repoRoot, ["rev-parse", "--verify", `refs/heads/${integration}`]);
      } catch {
        await git(run, repoRoot, ["branch", integration, baseRef]);
      }
      return integration;
    },

    create(taskId: string, attempt: number): Promise<WorktreeHandle> {
      return serialize(async () => {
        const branch = `corpocode/${runId}/${taskId}/a${attempt}`;
        const path = join(runDir(runId, opts.cwd, opts.env), "worktrees", `${taskId}-a${attempt}`);
        mkdirSync(dirname(path), { recursive: true });
        await git(run, repoRoot, ["worktree", "add", "-b", branch, path, integration]);
        mkdirSync(path, { recursive: true }); // fake runners don't create it; real git already has
        copyIncludes(path);
        return { path, branch };
      });
    },

    async isDirty(worktreePath: string): Promise<boolean> {
      const out = await git(run, worktreePath, ["status", "--porcelain"]);
      return out.trim().length > 0;
    },

    async removeIfClean(worktreePath: string): Promise<"removed" | "kept-dirty"> {
      const out = await git(run, worktreePath, ["status", "--porcelain"]);
      if (out.trim().length > 0) return "kept-dirty";
      await git(run, repoRoot, ["worktree", "remove", worktreePath]);
      return "removed";
    },
  };
}
