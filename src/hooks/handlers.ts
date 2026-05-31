// The registry of hook handlers:
//   UserPromptSubmit → moment categorizer + retrieval + design review
//   PreToolUse       → filter (deny/allow/ask) + context injector
//   PostToolUse      → verifier (MOLAR-EDIT fan-out, can block)
//   Stop             → compactor (sliding window + tiered digest + consolidation)
// Each handler is a thin function (envelope, ctx) → HookResponse. The dispatcher builds the
// context and routes the validated envelope to the matching handler.
import type { HookContext } from "./context";
import type { HookResponse } from "./response";
import type {
  PostToolUseEnvelope,
  PreToolUseEnvelope,
  SessionStartEnvelope,
  StopEnvelope,
  SubagentStartEnvelope,
  UserPromptSubmitEnvelope,
} from "./envelope";
import { handleUserPromptSubmit } from "../router/handler";
import { handlePreToolUse } from "../filter/handler";
import { handlePostToolUse } from "../verifier/handler";
import { handleStop } from "../compactor/worker";
import { handleSessionStart } from "../toolbox/session-start";

export type Handler<E> = (envelope: E, ctx: HookContext) => Promise<HookResponse>;

export interface HandlerMap {
  UserPromptSubmit: Handler<UserPromptSubmitEnvelope>;
  PreToolUse: Handler<PreToolUseEnvelope>;
  PostToolUse: Handler<PostToolUseEnvelope>;
  Stop: Handler<StopEnvelope>;
  SubagentStart: Handler<SubagentStartEnvelope>;
  SessionStart: Handler<SessionStartEnvelope>;
}

export function buildHandlers(): Partial<HandlerMap> {
  return {
    UserPromptSubmit: handleUserPromptSubmit,
    PreToolUse: handlePreToolUse,
    PostToolUse: handlePostToolUse,
    Stop: handleStop,
    SessionStart: handleSessionStart,
  };
}
