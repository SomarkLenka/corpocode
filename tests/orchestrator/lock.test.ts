// One active run per repo: a live holder blocks, a dead holder's lock is stolen (crash recovery),
// and release never clobbers a successor's lock.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock, releaseRunLock } from "../../src/orchestrator/lock";
import { ensureDir, runsDir } from "../../src/config/paths";

const dirs: string[] = [];
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "cc-lock-"));
  dirs.push(dir);
  return { CORPOCODE_HOME: dir };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("run lock", () => {
  it("acquires when unheld, re-acquires its own, blocks a second live run", () => {
    const env = home();
    const alive = () => true;
    expect(acquireRunLock("run-1", { env, pidAlive: alive })).toEqual({ ok: true });
    expect(acquireRunLock("run-1", { env, pidAlive: alive })).toEqual({ ok: true }); // idempotent for the holder
    const second = acquireRunLock("run-2", { env, pidAlive: alive });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder.runId).toBe("run-1");
  });

  it("steals a dead holder's lock (crash recovery) and tolerates a malformed lock file", () => {
    const env = home();
    expect(acquireRunLock("run-1", { env, pidAlive: () => true })).toEqual({ ok: true });
    expect(acquireRunLock("run-2", { env, pidAlive: () => false })).toEqual({ ok: true }); // holder dead ⇒ steal

    ensureDir(runsDir(undefined, env));
    writeFileSync(join(runsDir(undefined, env), "active.lock"), "{ not json");
    expect(acquireRunLock("run-3", { env, pidAlive: () => true })).toEqual({ ok: true });
  });

  it("release only removes its own lock", () => {
    const env = home();
    const alive = () => true;
    acquireRunLock("run-1", { env, pidAlive: alive });
    releaseRunLock("run-other", { env }); // not the holder — must not clobber
    const blocked = acquireRunLock("run-2", { env, pidAlive: alive });
    expect(blocked.ok).toBe(false);
    releaseRunLock("run-1", { env });
    expect(acquireRunLock("run-2", { env, pidAlive: alive })).toEqual({ ok: true });
  });
});
