// Thin best-effort bridges from the hooks to the GitManager, so the verifier/compactor handlers stay
// atomic (one line each) and the git concern lives here. Both fail open: git is never allowed to
// break a turn, and on a non-repo or a git error they simply do nothing.
import { join } from "node:path";
import type { HookContext } from "../hooks/context";
import { spawnRunner } from "../install/run";
import { createGitManager } from "./manager";
import { git, relPath } from "./plumbing";

function managerFor(ctx: HookContext) {
  return createGitManager({
    repoRoot: ctx.repoRoot,
    traceBranch: ctx.config.git.trace_branch,
    cleanBranch: ctx.config.git.clean_branch,
  });
}

/** Absolute paths of the files the trace branch holds beyond the clean branch — i.e. what this run
 * changed. The doc generator's Stop pass consumes this. Returns [] on a non-repo or any git error. */
export async function tracedFiles(ctx: HookContext): Promise<string[]> {
  const g = ctx.config.git;
  if (!g.enabled) return [];
  try {
    const out = await git(spawnRunner, ctx.repoRoot, ["diff", "--name-only", `${g.clean_branch}..${g.trace_branch}`]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((f) => join(ctx.repoRoot, f));
  } catch {
    return [];
  }
}

/** PostToolUse: record one atomic trace commit for a write, if trace recording is enabled. Returns the
 * repo-relative path that was committed (so the caller logs what the commit actually stored), or null
 * when trace recording is off. */
export async function recordWrite(ctx: HookContext, file: string, sessionId: string): Promise<string | null> {
  const g = ctx.config.git;
  if (!g.enabled || !g.commit_per_write) return null;
  await managerFor(ctx).commitWrite(file, { sessionId, mode: g.mode });
  return relPath(ctx.repoRoot, file);
}

export interface PromotionOutcome {
  planned: number;
  applied: boolean;
  mode: "suggest" | "auto";
}

/** Stop: plan (and, in auto mode, apply) promotion of the trace range onto the clean branch. */
export async function maybePromote(ctx: HookContext, _sessionId: string): Promise<PromotionOutcome | null> {
  const g = ctx.config.git;
  if (!g.enabled || !g.branch_management) return null;
  const mgr = managerFor(ctx);
  await mgr.ensureBranches("session");
  const sets = await mgr.planPromotion(ctx.repoRoot, g.clean_branch);
  if (sets.length === 0) return { planned: 0, applied: false, mode: g.mode };
  await mgr.promote(sets, g.mode); // suggest → no-op (surfaced via the log), auto → applied
  return { planned: sets.length, applied: g.mode === "auto", mode: g.mode };
}
