// Low-level git plumbing. The defining trick: commits are made onto a branch via a TEMPORARY index
// (GIT_INDEX_FILE), so recording to the trace/clean branches never touches the user's index, HEAD,
// or working tree — which is exactly what makes automatic trace recording safe.
//
// Every git invocation passes through `git()`, which refuses the forbidden operations
// (force-push, history rewrite, hard reset) structurally, so no bug elsewhere can issue one.
import { rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { CommandRunner } from "../install/run";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

function assertSafe(args: string[]): void {
  const a0 = args[0] ?? "";
  const force = args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease"));
  if (a0 === "push" && force) throw new Error("refusing forbidden git op: force-push");
  if (a0 === "reset" && args.includes("--hard")) throw new Error("refusing forbidden git op: hard reset");
  if (a0 === "rebase" || a0 === "filter-branch") throw new Error("refusing forbidden git op: history rewrite");
}

export interface GitRunOpts {
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export async function git(
  run: CommandRunner,
  repoRoot: string,
  args: string[],
  opts: GitRunOpts = {},
): Promise<string> {
  assertSafe(args);
  const res = await run("git", args, {
    cwd: repoRoot,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (res.code !== 0) throw new GitError(`git ${args[0]} failed (code ${res.code})`, res.stderr);
  return res.stdout;
}

export async function branchExists(run: CommandRunner, repoRoot: string, branch: string): Promise<boolean> {
  const res = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot });
  return res.code === 0;
}

export async function revParse(run: CommandRunner, repoRoot: string, ref: string): Promise<string> {
  return (await git(run, repoRoot, ["rev-parse", ref])).trim();
}

/** Repo-relative path in git's own convention (forward slashes), so messages, logs, and `git add`
 * arguments all agree on one representation across platforms. git accepts `/` on Windows too. */
export function relPath(repoRoot: string, file: string): string {
  const rel = isAbsolute(file) ? relative(repoRoot, file) : file;
  return rel.replace(/\\/g, "/");
}

/**
 * Commit the given files' current working-tree content onto `branch`, layered on its tip, using a
 * throwaway index so the user's index/HEAD/worktree are never touched. Returns the new commit sha.
 */
export async function commitFilesToBranch(
  run: CommandRunner,
  repoRoot: string,
  branch: string,
  files: string[],
  message: string,
): Promise<string> {
  const indexPath = join(repoRoot, ".git", `corpocode-index-${branch.replace(/[^a-z0-9]/gi, "-")}`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
  try {
    await git(run, repoRoot, ["read-tree", branch], { env }); // seed temp index from branch tip
    const rels = files.map((f) => relPath(repoRoot, f));
    await git(run, repoRoot, ["add", "--", ...rels], { env }); // stage working-tree content
    const tree = (await git(run, repoRoot, ["write-tree"], { env })).trim();
    const parent = await revParse(run, repoRoot, branch);
    const commit = (await git(run, repoRoot, ["commit-tree", tree, "-p", parent], { env, input: message })).trim();
    await git(run, repoRoot, ["update-ref", `refs/heads/${branch}`, commit], { env });
    return commit;
  } finally {
    try {
      rmSync(indexPath, { force: true });
    } catch {
      // a leftover temp index is harmless; cleanup is best-effort
    }
  }
}
