// A small per-session cache of the categorizer's last decision, persisted so that hooks running in
// SEPARATE `corpocode hook` processes can see it: the context injector (PreToolUse) reads the moment
// type to decide whether to slice a read, and the compactor (Stop) reads the recalled ids to close
// the outcome loop. Written by the router each UserPromptSubmit. All reads/writes are best-effort —
// a missing or corrupt cache degrades to "unknown", never an error.
import { readFileSync, writeFileSync } from "node:fs";
import { ensureDir, sessionDecisionFile, sessionDir } from "../config/paths";

export interface CachedDecision {
  type: string;
  complexity: string;
  breakpoint: boolean;
  dispatch_retrieval: boolean;
  effort: string;
  recalledIds: string[];
  ts: number;
  /** Set once the toolbox has routed this coding phase (rate-limits the PreToolUse subagent recommend). */
  routedPhaseTs?: number;
}

export function writeLastDecision(
  sessionId: string,
  decision: CachedDecision,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): void {
  try {
    ensureDir(sessionDir(sessionId, cwd, env));
    writeFileSync(sessionDecisionFile(sessionId, cwd, env), JSON.stringify(decision));
  } catch {
    // best-effort: a cache write must never break the turn
  }
}

export function readLastDecision(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): CachedDecision | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionDecisionFile(sessionId, cwd, env), "utf8")) as CachedDecision;
    if (parsed && typeof parsed.type === "string") return parsed;
  } catch {
    // missing/corrupt → unknown
  }
  return null;
}
