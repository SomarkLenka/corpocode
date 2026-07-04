// Pure translation of ONE NDJSON log record into a plain-language decision line. This is the shared
// core behind two surfaces: `corpocode why` narrates a whole session's log after the fact, and the
// monitor window's live Events feed narrates each record as it streams. One event→prose table, one
// home — so the CLI and the live window can never drift into telling two different stories.
//
// I/O-free and stateless: it takes a parsed record and returns text (or null when the event has no
// human translation). All rendering, windowing, and session logic lives in the callers.

/** A log line — only the always-present fields are named; everything else is read per-event via helpers. */
export interface LogRecord {
  ts?: string;
  event?: string;
  component?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Coerce an unknown log field to a display string (guards against missing/nested values). */
export function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Read a nested object field defensively (e.g. router's `decision`, `stage1_candidates`). */
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** The column label for a line: record.component, with two derived overrides so the column reads naturally. */
export function labelFor(rec: LogRecord): string {
  if (rec.event === "pattern") return s(rec.pattern) || "pattern";
  if (rec.event === "inject") return "injector"; // its component is "filter"; separate the read-slice story
  return typeof rec.component === "string" ? rec.component : s(rec.event);
}

/** Translate ONE record into a prose line, or null when the event has no translation (counted as "other"). */
export function describe(rec: LogRecord): string | null {
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
      if (rec.decision === "skipped") return `Skipped (${s(rec.reason)}).`; // pattern-generic
      // The shared `pattern` event schema, rendered per pattern (the intended compounding — spec A2 §5).
      let base =
        rec.pattern === "pre-write"
          ? `Ran: pre-write guidance — ${s(rec.warnings)} warning(s), injected ${s(rec.injected_tokens)} tokens`
          : `Ran: fanned out ${s(rec.files_fanned)} file-relevance agents, ${s(rec.survivors)} files implicated, injected ${s(rec.injected_tokens)} tokens of cited lines`;
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

/** One event → `{ label, text }` for display, or null when the event has no human translation.
 *  The convenience the live monitor uses per streamed record; `why` calls describe/labelFor directly. */
export function explain(rec: LogRecord): { label: string; text: string } | null {
  const text = describe(rec);
  if (text === null) return null;
  return { label: labelFor(rec), text };
}
