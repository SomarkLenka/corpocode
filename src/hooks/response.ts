// Builds the JSON response envelope the host expects. The key field is `additionalContext` — the
// channel through which CorpoCode injects anything into the model's context. Injected content is
// wrapped in source-identifying tags, a convention established here and reused by later phases.

export interface HookResponse {
  hookEventName?: string;
  additionalContext?: string;
  // PreToolUse permission control (Phase 2 gives this teeth; Phase 1 leaves it unset).
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
  // PostToolUse / Stop blocking control (Phase 2).
  decision?: "block";
  reason?: string;
  continue?: boolean;
  stopReason?: string;
}

export const TAGS = {
  recommendation: "middle-management recommendation",
  retrievedContext: "middle-management retrieved-context",
  designReview: "middle-management design-review",
  verifier: "middle-management verifier",
  fileContext: "middle-management file-context",
  delegation: "middle-management delegation",
} as const;

/** Wrap injected content in a source-identifying tag. */
export function tagged(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

/** Join several injection blocks into one additionalContext string. */
export function joinBlocks(blocks: Array<{ tag: string; content: string } | string | null | undefined>): string {
  return blocks
    .filter((b): b is { tag: string; content: string } | string => Boolean(b))
    .map((b) => (typeof b === "string" ? b : tagged(b.tag, b.content)))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

export function emptyResponse(): string {
  return "{}";
}

export function buildResponse(r: HookResponse): string {
  const hookSpecificOutput: Record<string, unknown> = {};
  if (r.additionalContext !== undefined) hookSpecificOutput.additionalContext = r.additionalContext;
  if (r.permissionDecision) {
    hookSpecificOutput.permissionDecision = r.permissionDecision;
    if (r.permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = r.permissionDecisionReason;
  }

  const out: Record<string, unknown> = {};
  if (Object.keys(hookSpecificOutput).length > 0) {
    // Claude Code REQUIRES hookEventName whenever hookSpecificOutput is present, so it is stamped here
    // (the dispatcher guarantees r.hookEventName is set to the current hook). Without it Claude Code
    // rejects the output with "hookSpecificOutput is missing required field hookEventName".
    hookSpecificOutput.hookEventName = r.hookEventName ?? "";
    out.hookSpecificOutput = hookSpecificOutput;
  }
  if (r.decision) out.decision = r.decision;
  if (r.reason) out.reason = r.reason;
  if (r.continue !== undefined) out.continue = r.continue;
  if (r.stopReason) out.stopReason = r.stopReason;
  return JSON.stringify(out);
}
