// Promote a run's integration branch to a stable "clean" branch — the readable handle the pilot
// sees and the branch the landing poll offers to land. The integration branch is a working surface
// (merge-train tip, possibly rewritten across rescue cycles); the clean branch is the published
// pointer at whatever the run currently vouches for.
//
// Pure git plumbing, no clock/fs of its own. Uses `branch` / `branch -f`, both allowed by
// assertSafe — neither is a push, hard reset, or history rewrite; force-updating a local ref is
// just repointing a name, and re-running a completed run must be able to republish idempotently.
import { branchExists, git } from "../git/plumbing";
import type { CommandRunner } from "../install/run";

export interface PromoteOptions {
  repoRoot: string;
  runId: string;
  integrationBranch: string;
  run: CommandRunner;
  log?: (fields: Record<string, unknown>) => void;
}

export interface PromoteResult {
  cleanBranch: string;
  /** true when the clean branch was created fresh; false when an existing one was force-updated. */
  created: boolean;
}

export async function promoteToClean(opts: PromoteOptions): Promise<PromoteResult> {
  const { repoRoot, runId, integrationBranch, run, log } = opts;
  const cleanBranch = `corpocode/${runId}/clean`;

  const exists = await branchExists(run, repoRoot, cleanBranch);
  if (exists) {
    await git(run, repoRoot, ["branch", "-f", cleanBranch, integrationBranch]);
  } else {
    await git(run, repoRoot, ["branch", cleanBranch, integrationBranch]);
  }

  const created = !exists;
  log?.({ event: "promote_clean", runId, cleanBranch, integrationBranch, created });
  return { cleanBranch, created };
}
