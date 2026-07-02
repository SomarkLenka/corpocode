// `corpocode why` — read the NDJSON event log and explain, in plain language, the silent decisions
// CorpoCode made in a session: what the router picked, why a tool was denied, whether a file read was
// sliced, and what the IntelligentRouter's bug-hunt pattern did. It is the observability counterpart to
// the action-patterns: a pure translation of the events they already log into one line per decision.
//
// Mirrors src/commands/stats.ts exactly: a pure computeWhy(lines, opts) → WhyReport (the test seam) plus
// a thin runWhyCommand wrapper doing the file read + rendering. It adds no event and changes no hook.
import { existsSync, readFileSync } from "node:fs";
import { flowLogFile, logFile } from "../config/paths";
import { loadConfig } from "../config/load";

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

/** A log line — only the always-present fields are named; everything else is read per-event via helpers. */
interface LogRecord {
  ts?: string;
  event?: string;
  component?: string;
  session_id?: string;
  [key: string]: unknown;
}

const SESSIONLESS_ATTRIBUTION_NOTE =
  "Some engine-level events carry no session id; they are attributed to this session by timestamp, not identity.";

/** Coerce an unknown log field to a display string (guards against missing/nested values). */
function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Read a nested object field defensively (e.g. router's `decision`, `stage1_candidates`). */
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** The column label for a line: record.component, with two derived overrides so the column reads naturally. */
function labelFor(rec: LogRecord): string {
  if (rec.event === "pattern") return s(rec.pattern) || "pattern";
  if (rec.event === "inject") return "injector"; // its component is "filter"; separate the read-slice story
  return typeof rec.component === "string" ? rec.component : s(rec.event);
}

/** Translate ONE record into a prose line, or null when the event has no translation (counted as "other"). */
function describe(rec: LogRecord): string | null {
  switch (rec.event) {
    case "router": {
      if (rec.stage2_invoked === false) return "Trivial prompt — skipped analysis (free).";
      const d = obj(rec.decision);
      const extras: string[] = [];
      if (d.dispatch_retrieval) extras.push("dispatched retrieval");
      if (d.breakpoint) extras.push("flagged a design breakpoint");
      const files = obj(rec.stage1_candidates).files;
      if (Array.isArray(files) && files.length > 0) extras.push(`${files.length} candidate files`);
      const head = `Classified as ${s(d.type)} / ${s(d.complexity)} at ${s(d.effort)} effort`;
      return `${head}${extras.length ? `; ${extras.join(", ")}` : ""}.`;
    }
    case "delegation":
      return `Suggested delegating to ${s(rec.delegate_to)} (${s(rec.mode)}).`;
    case "filter": {
      const verb = rec.decision === "deny" ? "Denied" : rec.decision === "allow" ? "Allowed" : "Asked about";
      const matched = rec.matched ? ` (matched ${s(rec.matched)})` : "";
      const reason = rec.reason ? ` — ${s(rec.reason)}` : "";
      const advisory = rec.enforced === false ? " [advisory]" : "";
      return `${verb} \`${s(rec.tool)}\`${matched}${reason}${advisory}.`;
    }
    case "inject": {
      let base = rec.sliced ? `Sliced ${s(rec.file)} to the relevant section` : `Read ${s(rec.file)} whole`;
      if (!rec.sliced && !rec.purpose_known) base += " (purpose unknown)";
      const warnings = Number(rec.warnings ?? 0);
      if (warnings > 0) base += `; injected ${warnings} warning(s)`;
      return `${base}.`;
    }
    case "verifier":
      return `${s(rec.file)} — ${s(rec.violations)} of ${s(rec.checks)} tenets flagged ${rec.blocked ? "(BLOCKED)" : "(advisory)"}.`;
    case "review":
      return `Design review: ${s(rec.concerns)} concern(s) across ${s(rec.tenets)} tenets.`;
    case "retrieval":
      return `Gathered ${s(rec.refs)} refs from ${s(rec.items_succeeded)} of ${s(rec.checklist_items)} sources.`;
    case "toolbox":
      return rec.trigger === "sessionstart"
        ? `Session-start toolbox: ${s(rec.gated)} gated, ${s(rec.skipped)} skipped.`
        : `Surfaced ${s(rec.skills)} skills, ${s(rec.agents)} agents (${s(rec.trigger)}).`;
    case "pattern": {
      if (rec.decision === "skipped") return `Skipped (${s(rec.reason)}).`;
      let base = `Ran: fanned out ${s(rec.files_fanned)} file-relevance agents, ${s(rec.survivors)} files implicated, injected ${s(rec.injected_tokens)} tokens of cited lines`;
      if (rec.reason && rec.reason !== "ran") base += `; hit the ${s(rec.reason)} path`;
      return `${base}.`;
    }
    case "orchestrate":
      return `Agent fan-out: ${s(rec.succeeded)}/${s(rec.calls)} agents ran, ${s(rec.surviving)} survived.`;
    case "agent_item":
      return `${s(rec.task_kind)} agent on ${s(rec.id)} — ${rec.ok ? "ok" : "failed"}.`;
    case "compaction":
      return rec.error
        ? `Compaction failed open (${s(rec.error)}).`
        : `Compaction: preserved ${s(rec.preserved)}, compacted ${s(rec.compacted)} via ${s(rec.backend)}.`;
    case "git":
      return rec.op === "promote"
        ? `Promoted ${s(rec.applied)} of ${s(rec.planned)} commits to the clean branch (${s(rec.mode)}).`
        : `Trace-committed ${Array.isArray(rec.files) ? rec.files.join(", ") : s(rec.files)}.`;
    case "docs":
      return `Regenerated docs: ${s(rec.files)} files, ${s(rec.symbols)} symbols.`;
    case "gather_source_degraded":
      return `${s(rec.source)} unavailable (${s(rec.reason)}) — degraded to empty.`;
    case "hook_error":
      return `${s(rec.hook)} hook failed open (${s(rec.error)}).`;
    case "agent_session_put_failed":
      return `Failed to persist an agent session (${s(rec.reason)}).`;
    case "agent_sessions_evicted":
      return `Evicted ${s(rec.removed)} cached agent session(s); ${s(rec.remaining)} remain.`;
    default:
      return null;
  }
}

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
