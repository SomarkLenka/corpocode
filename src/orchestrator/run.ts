// The orchestrator run's state machine + persistence. A run is the unit the cockpit operates on:
// one task, one lifecycle, one folder under `runs/` holding everything the run produced. The
// transition logic is PURE (advance never touches disk or clock beyond the `now` it's handed) so the
// full matrix is testable without IO; persistence is a thin Zod-validated JSON file beside the run's
// other artifacts.
//
// Fail-open on reads (a corrupt run.json reads as null and listRuns skips it), but NOT on writes:
// a run that cannot persist its state must surface that to the caller — silently losing a phase
// transition would leave the on-disk record lying about where the run is — so saveRun returns a
// boolean instead of swallowing.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { runDir, runFile, runsDir, ensureDir } from "../config/paths";

// Full lifecycle declared now so later phases don't need a schema migration; Phase 1 only exercises
// interrogating/specified/paused/failed.
export type RunStatus =
  | "interrogating"
  | "specified"
  | "planned"
  | "building"
  | "verifying"
  | "rescuing"
  | "promoting"
  | "done"
  | "failed"
  | "paused";

const RUN_STATUSES = [
  "interrogating",
  "specified",
  "planned",
  "building",
  "verifying",
  "rescuing",
  "promoting",
  "done",
  "failed",
  "paused",
] as const;

export interface RunRecord {
  id: string;
  task: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  pausedReason?: string;
  resumeStatus?: RunStatus; // where pause left off, so resume lands back in the right phase
}

export const runRecordSchema = z.object({
  id: z.string().min(1),
  task: z.string(),
  status: z.enum(RUN_STATUSES),
  createdAt: z.number(),
  updatedAt: z.number(),
  pausedReason: z.string().optional(),
  resumeStatus: z.enum(RUN_STATUSES).optional(),
});

export type RunEvent =
  | { type: "spec-approved" }
  | { type: "pause"; reason: string }
  | { type: "resume" }
  | { type: "fail"; reason: string }
  | { type: "phase"; to: Exclude<RunStatus, "paused" | "failed"> };

// The legal forward edges. verifying<->rescuing is the only cycle: verify can hand a failing task to
// rescue, and rescue hands it back for re-verification.
const PHASE_EDGES: Partial<Record<RunStatus, RunStatus[]>> = {
  interrogating: ["specified"],
  specified: ["planned"],
  planned: ["building"],
  building: ["verifying"],
  verifying: ["rescuing", "promoting"],
  rescuing: ["verifying"],
  promoting: ["done"],
};

export function createRun(id: string, task: string, now: number): RunRecord {
  return { id, task, status: "interrogating", createdAt: now, updatedAt: now };
}

/**
 * Pure transition function. An ILLEGAL event returns the run unchanged except updatedAt — never
 * throws, because the caller (the loop) is mid-run and must keep going; it logs the rejection.
 * done/failed are terminal and absorb everything, including pause/resume.
 */
export function advance(run: RunRecord, event: RunEvent, now: number): RunRecord {
  const rejected = (): RunRecord => ({ ...run, updatedAt: now });

  if (run.status === "done" || run.status === "failed") return rejected();

  switch (event.type) {
    case "fail":
      // Failing is always legal from a live run — it's how the loop records an unrecoverable error.
      return { ...run, status: "failed", pausedReason: event.reason, resumeStatus: undefined, updatedAt: now };

    case "pause": {
      if (run.status === "paused") return rejected(); // already paused — don't clobber resumeStatus
      return { ...run, status: "paused", pausedReason: event.reason, resumeStatus: run.status, updatedAt: now };
    }

    case "resume": {
      if (run.status !== "paused" || !run.resumeStatus) return rejected();
      return { ...run, status: run.resumeStatus, pausedReason: undefined, resumeStatus: undefined, updatedAt: now };
    }

    case "spec-approved": {
      if (run.status !== "interrogating") return rejected();
      return { ...run, status: "specified", updatedAt: now };
    }

    case "phase": {
      if (run.status === "paused") return rejected(); // must resume first — a phase jump would lose resumeStatus
      const legal = PHASE_EDGES[run.status] ?? [];
      if (!legal.includes(event.to)) return rejected();
      return { ...run, status: event.to, updatedAt: now };
    }
  }
}

/**
 * Filesystem-safe, lexically sortable id: run-<yyyymmddhhmmss>-<4 hex>. UTC so ids sort the same
 * regardless of the machine's timezone; the hex suffix disambiguates two runs started in one second.
 */
export function newRunId(now: () => number, random: () => number = Math.random): string {
  const d = new Date(now());
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const hex = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `run-${stamp}-${hex}`;
}

/** Persist run.json into the run's folder. Returns false on failure — the caller must react (a run
 *  whose state can't be saved would resume from a stale phase), so this is NOT swallowed silently. */
export function saveRun(run: RunRecord, cwd?: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    ensureDir(runDir(run.id, cwd, env));
    writeFileSync(runFile(run.id, "run.json", cwd, env), JSON.stringify(run, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The persisted record, or null when absent/corrupt/invalid (fail-open — caller treats as no run). */
export function loadRun(runId: string, cwd?: string, env?: NodeJS.ProcessEnv): RunRecord | null {
  try {
    const parsed = runRecordSchema.safeParse(JSON.parse(readFileSync(runFile(runId, "run.json", cwd, env), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every readable run, newest first (by createdAt, id as tiebreak since ids sort chronologically).
 *  Unreadable entries are skipped, not fatal — one corrupt run must not hide the rest. */
export function listRuns(cwd?: string, env?: NodeJS.ProcessEnv): RunRecord[] {
  let names: string[];
  try {
    names = readdirSync(runsDir(cwd, env));
  } catch {
    return []; // no runs dir yet
  }
  const out: RunRecord[] = [];
  for (const name of names) {
    const rec = loadRun(name, cwd, env);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return out;
}
