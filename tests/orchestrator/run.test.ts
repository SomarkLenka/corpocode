// The run state machine — the full transition matrix (illegal moves return unchanged-but-touched),
// pause/resume round-trips, and the disk round-trip under a CORPOCODE_HOME temp dir.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRun,
  advance,
  newRunId,
  saveRun,
  loadRun,
  listRuns,
  runRecordSchema,
  type RunRecord,
  type RunStatus,
  type RunEvent,
} from "../../src/orchestrator/run";
import { runDir, runFile } from "../../src/config/paths";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "cc-run-"));
  dirs.push(d);
  return { CORPOCODE_HOME: d } as NodeJS.ProcessEnv;
}

function runAt(status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return { id: "run-x", task: "t", status, createdAt: 100, updatedAt: 100, ...extra };
}

describe("createRun / advance", () => {
  it("starts a run interrogating with both timestamps set", () => {
    const r = createRun("run-1", "build a widget", 42);
    expect(r).toEqual({ id: "run-1", task: "build a widget", status: "interrogating", createdAt: 42, updatedAt: 42 });
  });

  it("spec-approved moves interrogating -> specified, and only from interrogating", () => {
    expect(advance(runAt("interrogating"), { type: "spec-approved" }, 200).status).toBe("specified");
    for (const s of ["specified", "planned", "building", "verifying", "rescuing", "promoting"] as RunStatus[]) {
      const out = advance(runAt(s), { type: "spec-approved" }, 200);
      expect(out.status).toBe(s); // rejected: unchanged...
      expect(out.updatedAt).toBe(200); // ...except the touch
    }
  });

  it("walks the full declared phase order and rejects every skip", () => {
    const order: RunStatus[] = ["interrogating", "specified", "planned", "building", "verifying", "promoting", "done"];
    const allPhases = ["specified", "planned", "building", "verifying", "rescuing", "promoting", "done"] as const;

    for (let i = 0; i < order.length - 1; i++) {
      const from = order[i];
      for (const to of allPhases) {
        const out = advance(runAt(from), { type: "phase", to }, 500);
        const legal = to === order[i + 1] || (from === "verifying" && to === "rescuing");
        expect(out.status, `${from} -> ${to}`).toBe(legal ? to : from);
        expect(out.updatedAt).toBe(500); // legal or not, the touch always lands
      }
    }
  });

  it("verifying <-> rescuing cycles both ways", () => {
    expect(advance(runAt("verifying"), { type: "phase", to: "rescuing" }, 1).status).toBe("rescuing");
    expect(advance(runAt("rescuing"), { type: "phase", to: "verifying" }, 1).status).toBe("verifying");
    // rescuing can't jump forward — it must go back through verifying
    expect(advance(runAt("rescuing"), { type: "phase", to: "promoting" }, 1).status).toBe("rescuing");
  });

  it("advance is pure — the input record is never mutated", () => {
    const before = runAt("verifying");
    const frozen = { ...before };
    advance(before, { type: "phase", to: "rescuing" }, 999);
    advance(before, { type: "pause", reason: "x" }, 999);
    expect(before).toEqual(frozen);
  });

  it("pause stores where it left off and resume restores it", () => {
    const paused = advance(runAt("building"), { type: "pause", reason: "budget" }, 300);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe("budget");
    expect(paused.resumeStatus).toBe("building");

    const resumed = advance(paused, { type: "resume" }, 400);
    expect(resumed.status).toBe("building");
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.resumeStatus).toBeUndefined();
    expect(resumed.updatedAt).toBe(400);
  });

  it("double pause does not clobber resumeStatus; phase moves are rejected while paused", () => {
    const paused = advance(runAt("verifying"), { type: "pause", reason: "first" }, 1);
    const again = advance(paused, { type: "pause", reason: "second" }, 2);
    expect(again.resumeStatus).toBe("verifying");
    expect(again.pausedReason).toBe("first"); // rejection keeps the original reason

    const jumped = advance(paused, { type: "phase", to: "promoting" }, 3);
    expect(jumped.status).toBe("paused");
    expect(jumped.resumeStatus).toBe("verifying");
  });

  it("resume without a stored resumeStatus is rejected", () => {
    const orphan = runAt("paused"); // e.g. a hand-edited run.json missing resumeStatus
    const out = advance(orphan, { type: "resume" }, 7);
    expect(out.status).toBe("paused");
    expect(out.updatedAt).toBe(7);
  });

  it("fail is legal from any live state and records the reason", () => {
    for (const s of ["interrogating", "specified", "planned", "building", "verifying", "rescuing", "promoting", "paused"] as RunStatus[]) {
      const out = advance(runAt(s), { type: "fail", reason: "boom" }, 9);
      expect(out.status).toBe("failed");
    }
  });

  it("done and failed are terminal — every event is absorbed", () => {
    const events: RunEvent[] = [
      { type: "spec-approved" },
      { type: "pause", reason: "r" },
      { type: "resume" },
      { type: "fail", reason: "r" },
      { type: "phase", to: "planned" },
    ];
    for (const s of ["done", "failed"] as RunStatus[]) {
      for (const e of events) {
        const out = advance(runAt(s), e, 11);
        expect(out.status).toBe(s);
        expect(out.updatedAt).toBe(11);
      }
    }
  });
});

describe("newRunId", () => {
  it("is filesystem-safe and sortable: run-<yyyymmddhhmmss>-<4 hex>", () => {
    const id = newRunId(() => Date.UTC(2026, 6, 4, 9, 5, 3), () => 0.5);
    expect(id).toBe("run-20260704090503-8000");
    expect(id).toMatch(/^run-\d{14}-[0-9a-f]{4}$/);
  });

  it("later timestamps sort after earlier ones", () => {
    const a = newRunId(() => Date.UTC(2026, 0, 1), () => 0.9);
    const b = newRunId(() => Date.UTC(2026, 0, 2), () => 0.1);
    expect(a < b).toBe(true);
  });
});

describe("persistence", () => {
  it("save -> load round-trips, including optional pause fields", () => {
    const env = home();
    const run = runAt("paused", { id: "run-20260101000000-abcd", pausedReason: "budget", resumeStatus: "building" });
    expect(saveRun(run, undefined, env)).toBe(true);
    expect(loadRun(run.id, undefined, env)).toEqual(run);
  });

  it("saveRun reports failure instead of throwing when the runs dir is unwritable", () => {
    const env = home();
    const run = runAt("interrogating", { id: "run-blocked" });
    // Occupy the run's directory path with a FILE so ensureDir/writeFileSync must fail.
    mkdirSync(join(runDir(run.id, undefined, env), ".."), { recursive: true });
    writeFileSync(runDir(run.id, undefined, env), "not a dir", "utf8");
    expect(saveRun(run, undefined, env)).toBe(false);
  });

  it("malformed or invalid run.json loads as null (fail-open)", () => {
    const env = home();
    const run = runAt("interrogating", { id: "run-bad" });
    expect(saveRun(run, undefined, env)).toBe(true);

    writeFileSync(runFile(run.id, "run.json", undefined, env), "{ not json", "utf8");
    expect(loadRun(run.id, undefined, env)).toBeNull();

    // Valid JSON, wrong shape (status not in the enum) — Zod must reject it.
    writeFileSync(runFile(run.id, "run.json", undefined, env), JSON.stringify({ ...run, status: "flying" }), "utf8");
    expect(loadRun(run.id, undefined, env)).toBeNull();
    expect(loadRun("run-never-existed", undefined, env)).toBeNull();
  });

  it("listRuns returns newest first and skips unreadable entries", () => {
    const env = home();
    const older = runAt("done", { id: "run-20260101000000-aaaa", createdAt: 100 });
    const newer = runAt("interrogating", { id: "run-20260102000000-bbbb", createdAt: 200 });
    saveRun(older, undefined, env);
    saveRun(newer, undefined, env);
    // A corrupt sibling must be skipped, not fatal.
    const broken = runAt("done", { id: "run-broken" });
    saveRun(broken, undefined, env);
    writeFileSync(runFile(broken.id, "run.json", undefined, env), "garbage", "utf8");
    // And a run folder with no run.json at all.
    mkdirSync(runDir("run-empty", undefined, env), { recursive: true });

    expect(listRuns(undefined, env).map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(listRuns(undefined, env)[0]).toEqual(newer); // full record survives the trip
  });

  it("listRuns on a project with no runs dir yet is empty, not an error", () => {
    expect(listRuns(undefined, home())).toEqual([]);
  });

  it("runRecordSchema round-trips what saveRun writes", () => {
    const env = home();
    const run = runAt("building", { id: "run-schema" });
    saveRun(run, undefined, env);
    const raw = JSON.parse(readFileSync(runFile(run.id, "run.json", undefined, env), "utf8")) as unknown;
    expect(runRecordSchema.parse(raw)).toEqual(run);
  });
});
