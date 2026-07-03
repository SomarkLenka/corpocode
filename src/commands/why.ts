// `corpocode why` — read the NDJSON event log and explain, in plain language, the silent decisions
// CorpoCode made in a session: what the router picked, why a tool was denied, whether a file read was
// sliced, and what the IntelligentRouter's action-patterns (bug-hunt, pre-write) did. It is the
// observability counterpart to the action-patterns: a pure translation of the events they already log
// into one line per decision.
//
// Mirrors src/commands/stats.ts exactly: a pure computeWhy(lines, opts) → WhyReport (the test seam) plus
// a thin runWhyCommand wrapper doing the file read + rendering. It adds no event and changes no hook.
import { existsSync, readFileSync } from "node:fs";
import { flowLogFile, logFile } from "../config/paths";
import { loadConfig } from "../config/load";
import { describe, labelFor, s, type LogRecord } from "../log/explain";

export interface WhyOptions {
  session?: string;
  days?: number;
  now?: number; // epoch ms; injectable for deterministic --days windows, matching stats/review
}

export interface WhyLine {
  ts: string;
  component: string;
  event: string;
  text: string;
  sessionless?: boolean; // attributed to the session by timestamp, not by a session_id it carries
}

export interface WhyReport {
  sessionId: string | null; // the session explained (null when the log has no session-scoped decision)
  started?: string;
  ended?: string;
  lines: WhyLine[]; // one per translated decision, time-ordered
  otherEvents: number; // in-session records with no translation (counted, never silently hidden)
  sessionsSeen: number; // distinct sessions in the window, so the reader knows there are more
  note?: string; // e.g. the sessionless best-effort caveat
}

const SESSIONLESS_ATTRIBUTION_NOTE =
  "Some engine-level events carry no session id; they are attributed to this session by timestamp, not identity.";

// The per-record translation (LogRecord, describe, labelFor, s) lives in ../log/explain — shared with
// the monitor window's live Events feed so the CLI narration and the live narration stay identical.

/** Build a WhyLine for a record whose translation is known non-null. */
function toLine(rec: LogRecord, text: string, sessionless: boolean): WhyLine {
  const line: WhyLine = { ts: rec.ts ?? "", component: labelFor(rec), event: s(rec.event), text };
  if (sessionless) line.sessionless = true;
  return line;
}

const parseTs = (ts?: string): number => (ts ? Date.parse(ts) : NaN);

export function computeWhy(lines: string[], opts: WhyOptions = {}): WhyReport {
  const now = opts.now ?? Date.now();
  const cutoff = opts.days ? now - opts.days * 86_400_000 : 0;

  // Parse + window-filter, exactly like stats.ts.
  const records: LogRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (cutoff) {
      const ts = parseTs(rec.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
    }
    records.push(rec);
  }

  const withSession = records.filter((r) => typeof r.session_id === "string");
  const distinct = new Set(withSession.map((r) => r.session_id as string));

  // Pick the target session: an explicit --session (exact or prefix) else the most recent one.
  let sessionId: string | null = null;
  if (opts.session) {
    sessionId = [...distinct].find((id) => id === opts.session || id.startsWith(opts.session!)) ?? null;
  } else {
    let best = -Infinity;
    for (const r of withSession) {
      const ts = parseTs(r.ts);
      if (!Number.isNaN(ts) && ts >= best) {
        best = ts;
        sessionId = r.session_id as string;
      }
    }
  }

  if (!sessionId) {
    return { sessionId: null, lines: [], otherEvents: 0, sessionsSeen: distinct.size };
  }

  const inSession = records.filter((r) => r.session_id === sessionId);
  const stamps = inSession.map((r) => parseTs(r.ts)).filter((n) => !Number.isNaN(n));
  const startedMs = stamps.length ? Math.min(...stamps) : NaN;
  const endedMs = stamps.length ? Math.max(...stamps) : NaN;

  const out: WhyLine[] = [];
  let otherEvents = 0;
  for (const rec of inSession) {
    const text = describe(rec);
    if (text) out.push(toLine(rec, text, false));
    else otherEvents += 1; // in-session but untranslated — counted, never hidden
  }

  // Best-effort: attribute translatable sessionless events that fall inside the session's time window.
  let attributedSessionless = 0;
  if (!Number.isNaN(startedMs)) {
    for (const rec of records) {
      if (typeof rec.session_id === "string") continue;
      const ts = parseTs(rec.ts);
      if (Number.isNaN(ts) || ts < startedMs || ts > endedMs) continue;
      const text = describe(rec);
      if (!text) continue; // untranslated strays are ignored (not this session's "other")
      out.push(toLine(rec, text, true));
      attributedSessionless += 1;
    }
  }

  out.sort((a, b) => parseTs(a.ts) - parseTs(b.ts));

  const report: WhyReport = {
    sessionId,
    lines: out,
    otherEvents,
    sessionsSeen: distinct.size,
  };
  if (!Number.isNaN(startedMs)) {
    report.started = inSession.find((r) => parseTs(r.ts) === startedMs)?.ts;
    report.ended = inSession.find((r) => parseTs(r.ts) === endedMs)?.ts;
  }
  if (attributedSessionless > 0) report.note = SESSIONLESS_ATTRIBUTION_NOTE;
  return report;
}

// ── I/O wrapper (not exported; the pure computeWhy is the test seam, per stats.ts) ───────────────────

function readLogLines(env?: NodeJS.ProcessEnv): string[] {
  try {
    return readFileSync(logFile(undefined, env), "utf8").split("\n"); // project-local log in the cwd
  } catch {
    return [];
  }
}

/** True when logging is turned off in config — so an empty report can say so honestly rather than imply silence. */
function loggingDisabled(env?: NodeJS.ProcessEnv): boolean {
  try {
    return loadConfig({ env }).logging.enabled === false;
  } catch {
    return false; // config unreadable → assume enabled; the empty-log message still applies
  }
}

interface WhyFlags {
  json: boolean;
  session?: string;
  days?: number;
}

function parseFlags(argv: string[]): WhyFlags {
  const flags: WhyFlags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") flags.json = true;
    else if (argv[i] === "--session") flags.session = argv[++i];
    else if (argv[i] === "--days") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) flags.days = n;
    }
  }
  return flags;
}

const shortId = (id: string): string => id.slice(0, 8);
const clock = (ts?: string): string => (ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString().slice(11, 19) : "??:??:??");

export function runWhyCommand(argv: string[], env?: NodeJS.ProcessEnv): void {
  const flags = parseFlags(argv);
  const report = computeWhy(readLogLines(env), { session: flags.session, days: flags.days });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (!report.sessionId) {
    process.stdout.write(loggingDisabled(env) ? "Logging is disabled (logging.enabled: false).\n" : "No CorpoCode decisions logged yet.\n");
    return;
  }

  const width = Math.max(0, ...report.lines.map((l) => l.component.length));
  const span = report.started && report.ended ? ` · ${clock(report.started)}–${clock(report.ended)}` : "";
  process.stdout.write(`Why — session ${shortId(report.sessionId)} · ${report.lines.length} decisions${span}\n\n`);
  for (const l of report.lines) {
    const mark = l.sessionless ? "~" : " ";
    process.stdout.write(`  ${clock(l.ts)} ${mark}${l.component.padEnd(width)}  ${l.text}\n`);
  }
  if (report.otherEvents > 0) process.stdout.write(`\n  (+${report.otherEvents} lower-level event(s) not shown)\n`);
  if (report.note) process.stdout.write(`\n  note: ${report.note}  (~ marks time-attributed lines)\n`);
  if (report.sessionsSeen > 1) process.stdout.write(`\n  ${report.sessionsSeen - 1} older session(s) in the log; use --session <id>.\n`);
  if (existsSync(flowLogFile(undefined, env))) process.stdout.write(`\nFull narrative: ${flowLogFile(undefined, env)}\n`);
}