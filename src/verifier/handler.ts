// PostToolUse handler — the verifier with teeth. After a file write it fans out one check family
// per active tenet (the MOLAR-EDIT engine), and a single high-confidence `block` halts the edit
// (continue:false + stop reason). Warns and infos are surfaced to the model but never stop it.
//
// The write-back loop lives here: every violation is captured to memory as a file-anchored mistake,
// and a recall of this file's prior mistakes is taken FIRST so the log shows whether this is a
// repeat. That captured mistake is what the context injector reads back before the next edit to the
// same file — a violation today becoming a warning tomorrow. All memory work is best-effort: a
// memory failure must never break the turn (the In-flight tenet).
import type { HookContext } from "../hooks/context";
import { TAGS, tagged, type HookResponse } from "../hooks/response";
import type { PostToolUseEnvelope } from "../hooks/envelope";
import { createMolarEditEngine } from "../molar/engine";
import { recordWrite } from "../git/hook";
import { aggregateFindings, formatViolations } from "./aggregator";

function extractWrittenFile(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  }
  return null;
}

export async function handlePostToolUse(
  envelope: PostToolUseEnvelope,
  ctx: HookContext,
): Promise<HookResponse> {
  if (!ctx.config.molar_edit.verify_on_edit) return {};
  const file = extractWrittenFile(envelope.tool_name, envelope.tool_input);
  if (!file) return {};

  const engine = createMolarEditEngine({
    provider: ctx.registry.forComponent("verifier"),
    config: ctx.config,
    extraChecks: ctx.plugins.tenets,
  });
  if (engine.activeTenets().length === 0) return {};

  const findings = await engine.verify([file]);
  if (findings.length === 0) return {};

  const verdict = aggregateFindings(findings);
  const scope = { project: ctx.project, workspaceCascade: false };

  // Recall prior mistakes for this file BEFORE capturing the new ones, so `repeats` counts history
  // rather than what we are about to write this turn.
  let repeats = 0;
  if (verdict.violations.length) {
    try {
      repeats = (await ctx.memory.recall({ file, kinds: ["mistake"], scope, limit: 10 })).length;
    } catch {
      // recall is best-effort
    }
    for (const f of verdict.violations) {
      try {
        await ctx.memory.capture({
          kind: "mistake",
          text: `[${f.tenet}] ${f.message}`,
          files: [file],
          sessionId: envelope.session_id,
        });
      } catch {
        // capture is best-effort — never break the turn over a memory write
      }
    }
  }

  for (const f of findings) {
    ctx.logger.log({
      event: "verifier_check",
      session_id: envelope.session_id,
      component: "verifier",
      tenet: f.tenet,
      verdict: f.ok ? "ok" : "violation",
      severity: f.severity,
      confidence: f.confidence,
      message: f.message,
      file,
    });
  }
  ctx.logger.log({
    event: "verifier",
    session_id: envelope.session_id,
    component: "verifier",
    file,
    checks: findings.length,
    violations: verdict.violations.length,
    blocked: verdict.blocked,
    repeats,
    enforced: true, // Phase 2: the verifier now acts
  });

  // Record this write to the trace branch (Phase 3) — isolated from the user's branch, so safe to do
  // automatically. Best-effort: a non-repo or any git error must never affect the turn. Log the
  // repo-relative path that was actually committed, not the absolute envelope path.
  try {
    const committed = await recordWrite(ctx, file, envelope.session_id);
    if (committed) {
      ctx.logger.log({ event: "git", session_id: envelope.session_id, component: "git", op: "commit", branch: "trace", files: [committed] });
    }
  } catch {
    // git is best-effort
  }

  if (verdict.blocked) {
    return { continue: false, stopReason: verdict.stopReason };
  }
  if (verdict.violations.length) {
    return { hookEventName: "PostToolUse", additionalContext: tagged(TAGS.verifier, formatViolations(verdict.violations)) };
  }
  return {};
}
