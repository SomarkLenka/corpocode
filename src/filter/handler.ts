// PreToolUse handler — the filter, now with teeth. It does two distinct jobs depending on the tool:
//
//   • File reads (Read/Glob/Grep) → the context injector: a focused slice plus file-anchored
//     warnings. It never denies a read; the worst case is the full read proceeds.
//   • Command tools (Bash/Shell) → classification with teeth: deny a destructive command before the
//     model can act, auto-allow a clearly safe one so the user isn't prompted, and route the honest
//     middle to `ask` so the human decides. The soft LLM classifier only runs on the `ask` leftover.
//
// Non-command, non-read tools (Write, Edit, WebFetch, …) get no permission decision — the verifier
// guards writes after the fact, and the filter must not silently approve everything. Everything is
// fail-open: any error returns an empty response and the host proceeds untouched.
import type { Effort } from "../config/schema";
import type { HookContext } from "../hooks/context";
import { TAGS, tagged, type HookResponse } from "../hooks/response";
import type { PreToolUseEnvelope } from "../hooks/envelope";
import { classifyToolCall, extractCommand, softClassify, type FilterClassification } from "./classify";
import { injectFileRead, isFileReadTool } from "./inject";
import { readLastDecision } from "../session/decision-cache";
import { maybeRouteHeavyCoding } from "../toolbox/route";

export async function handlePreToolUse(
  envelope: PreToolUseEnvelope,
  ctx: HookContext,
): Promise<HookResponse> {
  if (isFileReadTool(envelope.tool_name)) {
    try {
      return await injectFileRead(envelope, ctx);
    } catch {
      return {}; // never break a read — fall back to the full read
    }
  }

  const command = extractCommand(envelope.tool_name, envelope.tool_input);
  if (command === null) {
    // Non-command tool (Write/Edit/…): no permission teeth, but on a write entering a heavy coding
    // phase the toolbox recommends a subagent + skills with context (best-effort, once per phase).
    const route = await maybeRouteHeavyCoding(envelope, ctx);
    return route ? { additionalContext: tagged(TAGS.toolbox, route) } : {};
  }

  let classification = classifyToolCall(envelope.tool_name, envelope.tool_input);
  // Only the uncertain middle consults the LLM; deny/allow are already confident and free.
  if (classification.decision === "ask") {
    const effort = readLastDecision(envelope.session_id, ctx.repoRoot, ctx.env)?.effort as Effort | undefined;
    classification = await softClassify(command, ctx.registry.forComponent("filter"), effort);
  }

  ctx.logger.log({
    event: "filter",
    session_id: envelope.session_id,
    component: "filter",
    tool: envelope.tool_name,
    decision: classification.decision,
    reason: classification.reason,
    matched: classification.matched,
    enforced: true, // Phase 2: the filter now sets the permission decision
  });

  return toResponse(classification);
}

function toResponse(c: FilterClassification): HookResponse {
  return { permissionDecision: c.decision, permissionDecisionReason: c.reason };
}
