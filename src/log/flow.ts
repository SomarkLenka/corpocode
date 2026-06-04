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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, flowCursorFile, flowLogFile } from "../config/paths";
import type { CorpoConfig } from "../config/schema";
import type { HookResponse } from "../hooks/response";
import type { TranscriptMessage } from "../compactor/types";
import { parseTranscriptSlice, readSlice } from "../session/reader";

// One transcript message can be enormous (a pasted file, a long tool result). Cap each so a single
// blob can't bloat the flow log past usefulness; the delta model means we never repeat content anyway.
const MAX_MESSAGE_CHARS = 8000;
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
  tool?: string;
}

/** Pull the fields every hook envelope carries; null if the transcript can't be located. */
function extractBase(raw: unknown): HookBase | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.session_id === "string" ? o.session_id : "";
  const transcriptPath = typeof o.transcript_path === "string" ? o.transcript_path : "";
  if (!sessionId || !transcriptPath) return null;
  return { sessionId, transcriptPath, tool: typeof o.tool_name === "string" ? o.tool_name : undefined };
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

function truncate(s: string): string {
  return s.length <= MAX_MESSAGE_CHARS ? s : `${s.slice(0, MAX_MESSAGE_CHARS)}\n… (truncated ${s.length - MAX_MESSAGE_CHARS} chars)`;
}

/** A one-line hint of the most salient tool input (file, command, …) for quick scanning. */
function inputHint(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const ti = (raw as Record<string, unknown>).tool_input;
  if (!ti || typeof ti !== "object") return undefined;
  const o = ti as Record<string, unknown>;
  const key = ["file_path", "command", "pattern", "path", "url", "prompt"].find((k) => typeof o[k] === "string");
  if (!key) return undefined;
  const value = String(o[key]).replace(/\s+/g, " ").trim();
  return `${key}: ${value.length > 160 ? `${value.slice(0, 160)}…` : value}`;
}

function renderMessages(messages: TranscriptMessage[]): string {
  if (messages.length === 0) return indent("(no new transcript content)", "  ");
  return messages.map((m) => indent(`[${m.role}] ${truncate(m.content)}`, "  ")).join("\n\n");
}

function renderOutput(response: HookResponse): string {
  const parts: string[] = [];
  if (response.additionalContext) parts.push(`additionalContext:\n${indent(response.additionalContext, "    ")}`);
  if (response.permissionDecision) {
    parts.push(`permissionDecision: ${response.permissionDecision}${response.permissionDecisionReason ? ` (${response.permissionDecisionReason})` : ""}`);
  }
  if (response.decision) parts.push(`decision: ${response.decision}${response.reason ? ` (${response.reason})` : ""}`);
  if (response.continue === false) parts.push(`continue: false${response.stopReason ? ` (${response.stopReason})` : ""}`);
  if (parts.length === 0) return indent("(no output — empty response)", "  ");
  return indent(parts.join("\n"), "  ");
}

function buildBlock(hookName: string, base: HookBase, raw: unknown, response: HookResponse, messages: TranscriptMessage[], ts: string): string {
  const toolPart = base.tool ? `  ·  ${base.tool}` : "";
  const head = `${RULE}\n▶ ${hookName}${toolPart}  ·  ${ts}  ·  session ${shortSession(base.sessionId)}\n${RULE}`;
  const hint = inputHint(raw);
  const hintLine = hint ? `\n  ${hint}` : "";
  const count = `${messages.length} new message${messages.length === 1 ? "" : "s"}`;
  return `\n${head}${hintLine}\n\n╶ transcript (${count}) ╴\n\n${renderMessages(messages)}\n\n╶ hook output ╴\n\n${renderOutput(response)}\n`;
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
      const messages = text.trim() ? parseTranscriptSlice(text) : [];
      write(buildBlock(hookName, base, raw, response, messages, now().toISOString()));
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
