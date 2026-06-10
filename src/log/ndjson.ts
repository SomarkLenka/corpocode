// Append-only NDJSON logger: one JSON object per line at ~/.corpocode/logs/corpocode.ndjson.
//
// Two invariants define this module:
//  1. It must NEVER throw into its caller. Logging is a side effect; a failed side effect
//     (full disk, unwritable path) must not take down the hook that called it.
//  2. When logging is disabled in config, every call collapses to a no-op.
//
// Callers are responsible for not passing secrets/PII (the Logging tenet) — the logger writes
// faithfully whatever structured fields it is given.
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, logFile, sessionLogFile } from "../config/paths";
import type { CorpoConfig } from "../config/schema";

/** Structured fields for one log line. `ts` is stamped by the logger; everything else is the caller's. */
export interface LogFields {
  event: string;
  session_id?: string;
  component?: string;
  cost_usd?: number;
  latency_ms?: number;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface Logger {
  readonly enabled: boolean;
  log(fields: LogFields): void;
}

export interface NdjsonLoggerOptions {
  file: string;
  enabled: boolean;
  /** Per-session file every line is ALSO appended to, for single-session oversight. Absent ⇒ global only. */
  sessionFile?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable sink, used by tests to capture lines or force a write error. */
  sink?: (line: string) => void;
}

/** Append one line to a file, fail-open. Used for the per-session tee so its failure never touches the
 *  global write or the caller — a missing/locked session file degrades to "global only". */
function appendQuietly(file: string, line: string): void {
  try {
    ensureDir(dirname(file));
    appendFileSync(file, line, "utf8");
  } catch {
    // best-effort tee
  }
}

export function createLogger(opts: NdjsonLoggerOptions): Logger {
  const now = opts.now ?? (() => new Date());

  function log(fields: LogFields): void {
    if (!opts.enabled) return;
    try {
      const record = { ts: now().toISOString(), ...fields };
      const line = `${JSON.stringify(record)}\n`;
      if (opts.sink) {
        opts.sink(line);
        return;
      }
      ensureDir(dirname(opts.file));
      appendFileSync(opts.file, line, "utf8");
      // Tee to this session's own log too (best-effort, isolated): the global log keeps the
      // cross-session view; the per-session log gives atomic single-session oversight.
      if (opts.sessionFile) appendQuietly(opts.sessionFile, line);
    } catch {
      // Swallowed by design (invariant 1). We cannot log the logging failure to the same
      // sink, and must not surface it to the caller.
    }
  }

  return { enabled: opts.enabled, log };
}

/** A logger that does nothing — handy as a default in tests and non-logging code paths. */
export function nullLogger(): Logger {
  return { enabled: false, log: () => {} };
}

/** Build the process logger from config + paths. The dispatcher creates one and passes it down. When a
 *  sessionId is known (every hook carries one), each line is also teed into that session's own log. */
export function loggerFromConfig(
  config: Pick<CorpoConfig, "logging">,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date; sessionId?: string } = {},
): Logger {
  return createLogger({
    file: logFile(opts.cwd, opts.env), // project-local: <cwd>/.corpocode/logs/corpocode.ndjson
    sessionFile: opts.sessionId ? sessionLogFile(opts.sessionId, opts.cwd, opts.env) : undefined,
    enabled: config.logging.enabled,
    now: opts.now,
  });
}
