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
import { ensureDir, logFile } from "../config/paths";
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
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable sink, used by tests to capture lines or force a write error. */
  sink?: (line: string) => void;
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

/** Build the process logger from config + paths. The dispatcher creates one and passes it down. */
export function loggerFromConfig(
  config: Pick<CorpoConfig, "logging">,
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Logger {
  return createLogger({
    file: logFile(opts.env),
    enabled: config.logging.enabled,
    now: opts.now,
  });
}
