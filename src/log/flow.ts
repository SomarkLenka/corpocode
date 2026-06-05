// Human-readable companion to the NDJSON event log. Where corpocode.ndjson answers "what did each
// component decide?" in machine-parseable lines, this writes corpocode-flow.log: a narrative that
// interleaves, on EVERY hook surface, the transcript that accrued since the last hook with the hook's
// own output. Read top-to-bottom, it reconstructs the conversation as the hooks saw it — model turn,
// then the hook that fired, then the next model turn — so the flow is intuitive to follow.
//
// It shares the ndjson logger's two invariants:
//  1. It must NEVER throw into its caller. A flow-log failure (full disk, unreadable transcript) is a
//     side effect that must not disturb the hook running inside the host's turn.
//  2. When disabled in config, every call collapses to a no-op.
//
// The transcript "diff" is a byte-offset cursor kept per session, DISTINCT from the SessionReader's
// offset, so the two advance independently and neither steals the other's unread slice.
//
// Transcript rendering is flow-LOCAL (not the SessionReader's text-only parser) because following the
// flow requires the structure that parser discards: a transcript message's `role` is "assistant" for
// tool CALLS (tool_use blocks) but "user" for tool RESULTS (tool_result blocks). Rendering by role
// alone makes a tool result look like a user message that appears AFTER the tool call. So we classify
// each content block (text / tool_use / tool_result) and keep file order, which is true chat order.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, flowCursorFile, flowLogFile } from "../config/paths";
import type { CorpoConfig } from "../config/schema";
import type { HookResponse } from "../hooks/response";
import { readSlice } from "../session/reader";

// One transcript entry can be enormous (a pasted file, a long tool result). Cap each so a single blob
// can't bloat the flow log past usefulness; the delta model means we never repeat content anyway.
const MAX_ENTRY_CHARS = 8000;
const RULE = "═".repeat(76);

export interface FlowLogger {
  readonly enabled: boolean;
  /** Append one block for a hook: its header, the transcript delta, and the hook's output. */
  record(hookName: string, raw: unknown, response: HookResponse): void;
}

export interface FlowLoggerOptions {
  enabled: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable write sink; tests use it to capture blocks or force a write error. */
  sink?: (block: string) => void;
}

interface HookBase {
  sessionId: string;
  transcriptPath: string;
}

/** Pull the fields every hook envelope carries; null if the transcript can't be located. */
function extractBase(raw: unknown): HookBase | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.session_id === "string" ? o.session_id : "";
  const transcriptPath = typeof o.transcript_path === "string" ? o.transcript_path : "";
  if (!sessionId || !transcriptPath) return null;
  return { sessionId, transcriptPath };
}

function shortSession(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function indent(text: string, pad: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => pad + l)
    .join("\n");
}

function cap(s: string): string {
  return s.length <= MAX_ENTRY_CHARS ? s : `${s.slice(0, MAX_ENTRY_CHARS)}\n… (truncated ${s.length - MAX_ENTRY_CHARS} chars)`;
}

/** Flatten an Anthropic content value (string or block array) to plain text, for tool_result bodies. */
function coerceText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** A compact, single-line summary of a tool input — the most salient field, else its key set. */
function compactInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const key = ["file_path", "command", "pattern", "path", "url", "prompt", "description", "query"].find((k) => typeof o[k] === "string");
  if (key) {
    const v = String(o[key]).replace(/\s+/g, " ").trim();
    return `${key}: ${v.length > 120 ? `${v.slice(0, 120)}…` : v}`;
  }
  const keys = Object.keys(o);
  return keys.length ? `{ ${keys.join(", ")} }` : "";
}

/** Render one transcript JSONL slice into ordered, classified, labeled entries (true chat order). */
function renderTranscriptSlice(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const top = obj as Record<string, unknown>;
    const msg = (top.message && typeof top.message === "object" ? top.message : top) as Record<string, unknown>;
    const roleRaw = String(msg.role ?? top.type ?? "");
    const role = roleRaw === "assistant" ? "assistant" : roleRaw === "system" ? "system" : "user";
    const content = msg.content ?? top.content ?? top.text;

    if (typeof content === "string") {
      if (content.trim()) out.push(cap(`[${role}] ${content}`));
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === "string") {
        if (block.trim()) out.push(cap(`[${role}] ${block}`));
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text": {
          const t = typeof b.text === "string" ? b.text : "";
          if (t.trim()) out.push(cap(`[${role}] ${t}`));
          break;
        }
        case "tool_use": {
          const name = typeof b.name === "string" ? b.name : "tool";
          const inp = compactInput(b.input);
          out.push(cap(`[${role} ▶ ${name}]${inp ? ` ${inp}` : ""}`));
          break;
        }
        case "tool_result": {
          const body = coerceText(b.content).replace(/\s+/g, " ").trim();
          out.push(cap(`[tool result${b.is_error === true ? " ✗" : ""}]${body ? ` ${body}` : ""}`));
          break;
        }
        // thinking / redacted_thinking / unknown blocks are intentionally skipped — they bloat the
        // log and aren't needed to follow the hook↔tool flow.
        default:
          break;
      }
    }
  }
  return out;
}

/** Event-specific header annotation (e.g. the session source, the notified type, the tool + input). */
function headerDetail(hookName: string, raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  switch (hookName) {
    case "PreToolUse":
    case "PostToolUse": {
      const name = str("tool_name");
      const inp = compactInput(o.tool_input);
      return name ? `${name}${inp ? ` ${inp}` : ""}` : undefined;
    }
    case "SessionStart":
      return str("source");
    case "SessionEnd":
      return str("reason");
    case "Notification":
      return str("notification_type") ?? str("title");
    case "PreCompact":
      return str("trigger");
    case "SubagentStart":
    case "SubagentStop":
      return str("agent_type") ?? str("subagent_type");
    default:
      return undefined;
  }
}

// Events whose VALUE lives in the payload, not the transcript or a HookResponse. Returning a note for
// these keeps their block from being suppressed as "empty" and surfaces the payload. SessionStart /
// SessionEnd / SubagentStart deliberately return nothing here: bare boundary markers with no
// transcript and no output are noise (the spammy empty-SessionStart case), so they get suppressed.
function eventNote(hookName: string, raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  switch (hookName) {
    case "Notification": {
      const parts = [str("notification_type"), str("message")].filter(Boolean);
      return parts.length ? `notification: ${parts.join(" — ")}` : undefined;
    }
    case "PreCompact": {
      const t = str("trigger");
      return `compaction triggered${t ? ` (${t})` : ""}`;
    }
    case "SubagentStop": {
      const agent = str("agent_type");
      const last = str("last_assistant_message");
      const lines = [agent ? `subagent ${agent} finished` : "subagent finished", last ? `last: ${cap(last)}` : ""].filter(Boolean);
      return lines.join("\n");
    }
    default:
      return undefined;
  }
}

function renderTranscript(entries: string[]): string {
  if (entries.length === 0) return indent("(no new transcript content)", "  ");
  return entries.map((e) => indent(e, "  ")).join("\n\n");
}

function renderOutput(response: HookResponse, note: string | undefined): string {
  const parts: string[] = [];
  if (note) parts.push(note);
  if (response.additionalContext) parts.push(`additionalContext:\n${indent(response.additionalContext, "    ")}`);
  if (response.permissionDecision) {
    parts.push(`permissionDecision: ${response.permissionDecision}${response.permissionDecisionReason ? ` (${response.permissionDecisionReason})` : ""}`);
  }
  if (response.decision) parts.push(`decision: ${response.decision}${response.reason ? ` (${response.reason})` : ""}`);
  if (response.continue === false) parts.push(`continue: false${response.stopReason ? ` (${response.stopReason})` : ""}`);
  if (parts.length === 0) return indent("(no output — empty response)", "  ");
  return indent(parts.join("\n"), "  ");
}

/** True when the hook's RESPONSE carries something worth recording (independent of the transcript). */
function hasResponseSignal(response: HookResponse): boolean {
  return Boolean(response.additionalContext || response.permissionDecision || response.decision || response.continue === false);
}

function buildBlock(hookName: string, base: HookBase, raw: unknown, response: HookResponse, entries: string[], note: string | undefined, ts: string): string {
  const detail = headerDetail(hookName, raw);
  const detailPart = detail ? `  ·  ${detail}` : "";
  const head = `${RULE}\n▶ ${hookName}${detailPart}  ·  ${ts}  ·  session ${shortSession(base.sessionId)}\n${RULE}`;
  const count = `${entries.length} new entr${entries.length === 1 ? "y" : "ies"}`;
  return `\n${head}\n\n╶ transcript (${count}) ╴\n\n${renderTranscript(entries)}\n\n╶ hook output ╴\n\n${renderOutput(response, note)}\n`;
}

export function createFlowLogger(opts: FlowLoggerOptions): FlowLogger {
  const now = opts.now ?? (() => new Date());
  const logFilePath = flowLogFile(opts.cwd, opts.env);

  const write =
    opts.sink ??
    ((block: string) => {
      ensureDir(dirname(logFilePath));
      appendFileSync(logFilePath, block, "utf8");
    });

  const loadOffset = (sessionId: string): number => {
    try {
      const n = Number.parseInt(readFileSync(flowCursorFile(sessionId, opts.cwd, opts.env), "utf8").trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0; // missing/corrupt cursor → start from the top
    }
  };

  const saveOffset = (sessionId: string, offset: number): void => {
    try {
      const file = flowCursorFile(sessionId, opts.cwd, opts.env);
      ensureDir(dirname(file));
      writeFileSync(file, String(offset));
    } catch {
      // Persisting the cursor is best-effort; failure means the next hook re-reads the same slice
      // (a duplicated block) rather than losing it — we prefer over-reporting to a gap.
    }
  };

  function record(hookName: string, raw: unknown, response: HookResponse): void {
    if (!opts.enabled) return;
    try {
      const base = extractBase(raw);
      if (!base) return; // no transcript to diff (shouldn't happen for a real hook envelope)
      const { text, newOffset } = readSlice(base.transcriptPath, loadOffset(base.sessionId));
      const entries = text.trim() ? renderTranscriptSlice(text) : [];
      const note = eventNote(hookName, raw);

      // Suppress pure-noise blocks: a hook that added no transcript, produced no response, and carries
      // no payload note is not worth a block — this is what silences the repeated empty SessionStarts.
      // Still advance the cursor so the consumed (e.g. thinking-only) bytes aren't re-read next time.
      if (entries.length === 0 && !note && !hasResponseSignal(response)) {
        saveOffset(base.sessionId, newOffset);
        return;
      }

      write(buildBlock(hookName, base, raw, response, entries, note, now().toISOString()));
      saveOffset(base.sessionId, newOffset); // advance only after a successful write
    } catch {
      // Swallowed by design (invariant 1): a flow-log failure must never surface to the hook.
    }
  }

  return { enabled: opts.enabled, record };
}

/** A flow logger that does nothing — the default when flow logging is off or in non-logging paths. */
export function nullFlowLogger(): FlowLogger {
  return { enabled: false, record: () => {} };
}

/** Build the flow logger from config + paths. Gated by BOTH `logging.enabled` and `transcript_flow`. */
export function flowLoggerFromConfig(
  config: Pick<CorpoConfig, "logging">,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): FlowLogger {
  return createFlowLogger({
    enabled: config.logging.enabled && config.logging.transcript_flow,
    cwd: opts.cwd,
    env: opts.env,
    now: opts.now,
  });
}
