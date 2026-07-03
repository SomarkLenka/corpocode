// The registry of hook handlers:
//   UserPromptSubmit → moment categorizer + retrieval + design review
//   PreToolUse       → filter (deny/allow/ask) + context injector
//   PostToolUse      → verifier (MOLAR-EDIT fan-out, can block)
//   Stop             → compactor (sliding window + tiered digest + consolidation)
//   SessionStart     → toolbox gate (re-gate skills/agents)
//   SessionEnd       → agent-seam cleanup (release agent sessions + evict); a no-op until agents.enabled
// Each handler is a thin function (envelope, ctx) → HookResponse. The dispatcher builds the
// context and routes the validated envelope to the matching handler.
//
// The remaining surfaces (SubagentStart/Stop, Notification, PreCompact) carry no business logic — they
// are registered purely so the flow log can observe every hook Claude Code fires. They have no entry in
// buildHandlers(); the dispatcher records the flow block and returns an empty response for them.
import type { HookContext } from "./context";
import type { HookResponse } from "./response";
import type {
  NotificationEnvelope,
  PostToolUseEnvelope,
  PreCompactEnvelope,
  PreToolUseEnvelope,
  SessionEndEnvelope,
  SessionStartEnvelope,
  StopEnvelope,
  SubagentStartEnvelope,
  SubagentStopEnvelope,
  UserPromptSubmitEnvelope,
} from "./envelope";
import { handleUserPromptSubmit } from "../router/handler";
import { handlePreToolUse } from "../filter/handler";
import { handlePostToolUse } from "../verifier/handler";
import { handleStop } from "../compactor/worker";
import { handleSessionStart } from "../toolbox/session-start";
import { handleSessionEnd } from "../agents/session-end";
import { handleBugHunt, isBugLike } from "../intelligence/patterns/bug-hunt";
import { handlePreWrite, isWriteTool } from "../intelligence/patterns/pre-write";
import { readLastDecision, type CachedDecision } from "../session/decision-cache";

export type Handler<E> = (envelope: E, ctx: HookContext) => Promise<HookResponse>;

export interface HandlerMap {
  UserPromptSubmit: Handler<UserPromptSubmitEnvelope>;
  PreToolUse: Handler<PreToolUseEnvelope>;
  PostToolUse: Handler<PostToolUseEnvelope>;
  Stop: Handler<StopEnvelope>;
  SubagentStart: Handler<SubagentStartEnvelope>;
  SubagentStop: Handler<SubagentStopEnvelope>;
  SessionStart: Handler<SessionStartEnvelope>;
  SessionEnd: Handler<SessionEndEnvelope>;
  Notification: Handler<NotificationEnvelope>;
  PreCompact: Handler<PreCompactEnvelope>;
}

export function buildHandlers(): Partial<HandlerMap> {
  return {
    UserPromptSubmit: composeUserPromptSubmit(),
    PreToolUse: composePreToolUse(),
    PostToolUse: handlePostToolUse,
    Stop: handleStop,
    SessionStart: handleSessionStart,
    SessionEnd: handleSessionEnd, // agent-seam cleanup; a no-op until agents.enabled
  };
}

// ── UserPromptSubmit composition: base categorizer + gated bug-hunt action-pattern ───────────────────
// The base handler (router/handler.ts) is left untouched; here we wrap it so the IntelligentRouter's
// first pattern can append a cited-lines block AFTER it — but only when the agent seam is present
// (agents.enabled) and the free gate (isBugLike) recognizes a fresh bug-shaped moment. Flag off ⇒ the
// base output is returned verbatim (byte-identical). Seams are injectable so the composition unit-tests
// without disk or a live categorizer. See docs/superpowers/specs/2026-07-02-bug-hunt-action-pattern-design.md §4.6.

export interface UserPromptSubmitComposition {
  base?: Handler<UserPromptSubmitEnvelope>;
  readDecision?: (sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv) => CachedDecision | null;
  runBugHunt?: (envelope: UserPromptSubmitEnvelope, ctx: HookContext, decision: CachedDecision) => Promise<HookResponse>;
  now?: () => number;
}

export function composeUserPromptSubmit(deps: UserPromptSubmitComposition = {}): Handler<UserPromptSubmitEnvelope> {
  const base = deps.base ?? handleUserPromptSubmit;
  const readDecision = deps.readDecision ?? readLastDecision;
  const runBugHunt = deps.runBugHunt ?? handleBugHunt;
  const now = deps.now ?? ((): number => Date.now());
  return async (envelope, ctx) => {
    const turnStartedAt = now();
    const baseRes = await base(envelope, ctx);
    // Ships dark: no agent registry (agents.enabled off) or the pattern switched off ⇒ base output verbatim.
    if (!ctx.agents || !ctx.config.agents.bug_hunt.enabled) return baseRes;
    // Reuse the decision the base handler just cached — no second triage call. A stale (prior-turn)
    // entry, or a bug-free prompt, is a clean skip that leaves the base output untouched.
    const decision = readDecision(envelope.session_id, ctx.repoRoot, ctx.env);
    if (!isBugLike(envelope.prompt, decision, turnStartedAt)) {
      ctx.logger.log({
        event: "pattern",
        pattern: "bug-hunt",
        surface: "UserPromptSubmit",
        session_id: envelope.session_id,
        decision: "skipped",
        reason: !decision || decision.ts < turnStartedAt ? "gate:no-fresh-decision" : "gate:not-bug-like",
      });
      return baseRes;
    }
    const hunt = await runBugHunt(envelope, ctx, decision!);
    return mergeContext(baseRes, hunt);
  };
}

// ── PreToolUse composition: base filter/injector + gated pre-write action-pattern ────────────────────
// The base handler (filter/handler.ts) is left untouched; here we wrap it so the IntelligentRouter's
// second pattern (A2) can append architectural guidance AFTER it — but only when the agent seam is
// present (agents.enabled) and the tool call is a file write. Flag off ⇒ the base output is returned
// verbatim (byte-identical). mergeContext needs no change: handlePreWrite stamps "PreToolUse" on its
// non-empty response, so the fallback chain labels every merge case correctly (spec §4.7).

export interface PreToolUseComposition {
  base?: Handler<PreToolUseEnvelope>;
  runPreWrite?: (envelope: PreToolUseEnvelope, ctx: HookContext) => Promise<HookResponse>;
}

export function composePreToolUse(deps: PreToolUseComposition = {}): Handler<PreToolUseEnvelope> {
  const base = deps.base ?? handlePreToolUse;
  const runPreWrite = deps.runPreWrite ?? handlePreWrite;
  return async (envelope, ctx) => {
    const baseRes = await base(envelope, ctx);
    // Ships dark: no agent registry (agents.enabled off) or the pattern switched off ⇒ base output verbatim.
    if (!ctx.agents || !ctx.config.agents.pre_write.enabled) return baseRes;
    if (!isWriteTool(envelope.tool_name)) return baseRes; // free check — no event logged on the hot path
    const guidance = await runPreWrite(envelope, ctx);
    return mergeContext(baseRes, guidance);
  };
}

/** Append an extra handler's additionalContext block onto the base's, preserving the base's other fields. */
export function mergeContext(base: HookResponse, extra: HookResponse): HookResponse {
  if (!extra.additionalContext) return base;
  const additionalContext = base.additionalContext
    ? `${base.additionalContext}\n\n${extra.additionalContext}`
    : extra.additionalContext;
  return { ...base, additionalContext, hookEventName: base.hookEventName ?? extra.hookEventName ?? "UserPromptSubmit" };
}
