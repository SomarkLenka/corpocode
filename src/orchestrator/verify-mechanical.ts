// The cheap filter stack every candidate passes before anyone (or anything expensive) reads it:
// checkpoint stray edits → diff vs integration → dependency gate → task verify command.
// Deterministic; each stage's failure names itself so the run journal explains every rejection.
import { git } from "../git/plumbing";
import type { CommandRunner } from "../install/run";
import { extractNewDeps, checkDeps, type DepFinding } from "./depgate";

export interface MechanicalVerdict {
  ok: boolean;
  stage: "no-commits" | "depgate" | "verify-command" | "passed";
  detail: string;
  diffBytes: number;
  newDeps: DepFinding[];
}

export interface VerifyCandidateOptions {
  worktree: string;
  baseBranch: string;
  task: { id: string; verifyCommand?: string };
  run: CommandRunner;
  depgate: { enabled: boolean; allowlist: Set<string>; registryCheck?: boolean; fetchFn?: typeof fetch };
  platform?: NodeJS.Platform; // injectable for tests
  log?: (fields: Record<string, unknown>) => void;
}

export async function verifyCandidate(opts: VerifyCandidateOptions): Promise<MechanicalVerdict> {
  const { worktree, baseBranch, task, run } = opts;
  const fail = (stage: MechanicalVerdict["stage"], detail: string, diffBytes = 0, newDeps: DepFinding[] = []): MechanicalVerdict => {
    opts.log?.({ event: "mech_verify", task_id: task.id, ok: stage === "passed", stage, detail });
    return { ok: stage === "passed", stage, detail, diffBytes, newDeps };
  };

  // 1. Checkpoint stray edits so the diff sees everything the worker produced.
  const status = await git(run, worktree, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    await git(run, worktree, ["add", "-A"]);
    await git(run, worktree, ["commit", "-m", "chore(swarm): checkpoint uncommitted work"]);
  }

  // 2. The candidate IS its diff against the integration branch.
  const diff = await git(run, worktree, ["diff", baseBranch, "--unified=1"]);
  const diffBytes = Buffer.byteLength(diff, "utf8");
  if (diff.trim().length === 0) return fail("no-commits", "worker produced no change against the integration branch");

  // 3. Dependency gate — before any command from the candidate's own manifest can run.
  let newDeps: DepFinding[] = [];
  if (opts.depgate.enabled) {
    const found = extractNewDeps(diff);
    newDeps = await checkDeps(found, {
      allowlist: opts.depgate.allowlist,
      ...(opts.depgate.registryCheck !== undefined ? { registryCheck: opts.depgate.registryCheck } : {}),
      ...(opts.depgate.fetchFn ? { fetchFn: opts.depgate.fetchFn } : {}),
    });
    const blocked = newDeps.filter((d) => d.verdict !== "allowlisted");
    if (blocked.length > 0) {
      return fail("depgate", `new dependencies require a human decision: ${blocked.map((d) => `${d.name} (${d.verdict})`).join(", ")}`, diffBytes, newDeps);
    }
  }

  // 4. The task's own verify command, inside the worktree, via the platform shell.
  if (task.verifyCommand) {
    const platform = opts.platform ?? process.platform;
    const [cmd, args] = platform === "win32" ? ["cmd", ["/c", task.verifyCommand]] : ["sh", ["-c", task.verifyCommand]];
    const res = await run(cmd, args as string[], { cwd: worktree });
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout).slice(-2000);
      return fail("verify-command", `\`${task.verifyCommand}\` exited ${res.code}: ${tail}`, diffBytes, newDeps);
    }
  }

  return fail("passed", "all mechanical gates green", diffBytes, newDeps);
}
