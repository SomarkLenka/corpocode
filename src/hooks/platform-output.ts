// Per-platform output serialization. Almost all of CorpoCode is platform-agnostic; the one axis on
// which platforms differ for OUR output is the stdout envelope shape that carries injected context
// and permission decisions. Claude Code uses a `hookSpecificOutput` wrapper; the others use a flat
// object whose context field name differs. This module is the single seam that absorbs that.
//
// HONESTY NOTE: the exact envelope each non-Claude platform expects must be confirmed against that
// platform's current hook documentation at integration time. These are documented best-effort
// shapes; keeping them in one function means confirming them is a one-line change here, not a hunt
// through the codebase.
import { buildResponse, type HookResponse } from "./response";

export type PlatformId = "claude-code" | "codex" | "opencode" | "cursor" | "gemini-cli";

export const PLATFORM_IDS: readonly PlatformId[] = ["claude-code", "codex", "opencode", "cursor", "gemini-cli"];

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

// The field each non-Claude platform reads injected context from (confirm per platform docs).
const CONTEXT_FIELD: Record<Exclude<PlatformId, "claude-code">, string> = {
  codex: "additional_context",
  opencode: "context",
  cursor: "additionalContext",
  "gemini-cli": "systemContext",
};

// Whether a platform exposes a subagent/Task mechanism the main model can be directed to use. This
// gates AUTO delegation — on a platform without subagents, the categorizer can only suggest. Set
// conservatively true only where confirmed; the suggest path works everywhere regardless.
const SUBAGENT_CAPABLE: Record<PlatformId, boolean> = {
  "claude-code": true,
  codex: false,
  opencode: false,
  cursor: false,
  "gemini-cli": false,
};

export function platformSupportsSubagents(platform: PlatformId): boolean {
  return SUBAGENT_CAPABLE[platform];
}

function flatEnvelope(r: HookResponse, contextField: string): string {
  const out: Record<string, unknown> = {};
  if (r.additionalContext !== undefined) out[contextField] = r.additionalContext;
  if (r.permissionDecision) out.permissionDecision = r.permissionDecision;
  if (r.permissionDecisionReason) out.permissionDecisionReason = r.permissionDecisionReason;
  if (r.continue !== undefined) out.continue = r.continue;
  if (r.stopReason) out.stopReason = r.stopReason;
  return JSON.stringify(out);
}

/** Serialize a canonical hook response into the platform's expected stdout shape. */
export function serializeForPlatform(r: HookResponse, platform: PlatformId): string {
  if (platform === "claude-code") return buildResponse(r);
  return flatEnvelope(r, CONTEXT_FIELD[platform]);
}
