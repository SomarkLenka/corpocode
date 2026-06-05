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
    UserPromptSubmit: handleUserPromptSubmit,
    PreToolUse: handlePreToolUse,
    PostToolUse: handlePostToolUse,
    Stop: handleStop,
    SessionStart: handleSessionStart,
    SessionEnd: handleSessionEnd, // agent-seam cleanup; a no-op until agents.enabled
  };
}
