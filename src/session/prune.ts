// Garbage-collect dead sessions. Every live session accumulates a small folder under
// `.corpocode/sessions/<session>/` (the SessionReader cache, the decision cache, the flow-log cursor).
// Nothing deletes them on its own — a session just stops being touched when the user moves on — so
// without a sweep the folder count grows without bound. This prunes any session folder whose last
// write is older than the TTL, run once per session at SessionStart (off the prompt hot path).
//
// Fully fail-open (the In-flight tenet): a missing sessions dir, a locked file, or a stat error
// degrades that entry to "skip", never a throw — pruning must never disrupt the hook that triggered it.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "../config/paths";

/** How long a session's state is retained after its last write before it is considered dead. 2 days. */
export const SESSION_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface PruneOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxAgeMs?: number; // override the TTL (tests inject a small value)
  now?: () => number; // injectable clock for deterministic tests
}

/**
 * Remove session folders under `.corpocode/sessions/` whose most recent modification is older than the
 * TTL. Returns the count removed. Never throws: a per-entry error is swallowed so one bad folder can't
 * stop the sweep, and an unreadable sessions dir yields 0.
 */
export function pruneOldSessions(opts: PruneOptions = {}): number {
  const maxAgeMs = opts.maxAgeMs ?? SESSION_TTL_MS;
  const now = opts.now ? opts.now() : Date.now();
  const dir = sessionsDir(opts.cwd, opts.env);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // no sessions dir yet (or unreadable) → nothing to prune
  }

  let removed = 0;
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      // Only session FOLDERS are pruned; any legacy flat file is left untouched (skipped here).
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // per-entry best-effort: skip an entry we can't stat or remove
    }
  }
  return removed;
}
