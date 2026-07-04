// One active run per repository. Parallel runs would race on branches, worktrees, and the task
// graph, so the second `corpocode start` must refuse loudly rather than corrupt the first —
// unless the holder is dead, in which case the lock is stale and stealing it IS the recovery
// path (a crashed run must never brick a repo until someone hand-deletes a file).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, runsDir } from "../config/paths";

export interface RunLock {
  runId: string;
  pid: number;
  at: number;
}

export interface LockDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => number;
  /** Injectable liveness probe; the default asks the OS via signal 0. */
  pidAlive?: (pid: number) => boolean;
}

function lockFile(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(runsDir(cwd, env), "active.lock");
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(cwd?: string, env?: NodeJS.ProcessEnv): RunLock | null {
  try {
    const raw = JSON.parse(readFileSync(lockFile(cwd, env), "utf8")) as Partial<RunLock>;
    if (typeof raw.runId !== "string" || typeof raw.pid !== "number") return null;
    return { runId: raw.runId, pid: raw.pid, at: typeof raw.at === "number" ? raw.at : 0 };
  } catch {
    return null; // missing or malformed ⇒ treated as unheld (a broken lock must not brick the repo)
  }
}

/** Take the repo's run lock. `ok: false` carries the live holder so the caller can name it. */
export function acquireRunLock(runId: string, deps: LockDeps = {}): { ok: true } | { ok: false; holder: RunLock } {
  const alive = deps.pidAlive ?? defaultPidAlive;
  const existing = readLock(deps.cwd, deps.env);
  if (existing && existing.runId !== runId && alive(existing.pid)) return { ok: false, holder: existing };
  try {
    ensureDir(runsDir(deps.cwd, deps.env));
    const lock: RunLock = { runId, pid: deps.pid ?? process.pid, at: (deps.now ?? Date.now)() };
    writeFileSync(lockFile(deps.cwd, deps.env), `${JSON.stringify(lock)}\n`);
    return { ok: true };
  } catch {
    // An unwritable lock dir means run state is unwritable too; the caller's saveRun will surface it.
    return { ok: true };
  }
}

/** Release the lock, but only if this run still holds it — never clobber a successor's lock. */
export function releaseRunLock(runId: string, deps: LockDeps = {}): void {
  const existing = readLock(deps.cwd, deps.env);
  if (existing && existing.runId !== runId) return;
  try {
    rmSync(lockFile(deps.cwd, deps.env), { force: true });
  } catch {
    // best-effort; a stale lock from a dead pid is stealable anyway
  }
}
