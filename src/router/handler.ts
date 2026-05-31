// UserPromptSubmit handler — the moment categorizer, now the orchestrator of the whole opening of a
// turn. It reads the line of thought, runs stage 1 (free) then stage 2, recalls prior decisions,
// and then — new in Phase 2 — dispatches the retrieval team when the moment warrants it and the
// design-review team at a breakpoint, threading the selected effort into both. Everything it spawns
// is best-effort: a retrieval or review failure costs context, never the recommendation or the turn.
import type { HookContext } from "../hooks/context";
import { TAGS, joinBlocks, type HookResponse } from "../hooks/response";
import type { UserPromptSubmitEnvelope } from "../hooks/envelope";
import type { ScoredFile } from "../backends/graph/types";
import type { ScoredMemory } from "../backends/memory/types";
import type { Effort } from "../config/schema";
import { stageOne } from "./heuristics";
import { stageTwo } from "./ranker";
import { selectModelEffort, type ModelEffortChoice } from "./effort";
import type { RouterDecision } from "./output-schema";
import { writeLastDecision } from "../session/decision-cache";
import { runRetrieval } from "../retrieval/worker";
import { runDesignReview } from "../review/team";
import { planDelegation } from "./delegation";

function buildRecommendation(
  decision: RouterDecision,
  candidates: ScoredFile[],
  priorDecisions: ScoredMemory[],
): string {
  const lines: string[] = [];
  lines.push(
    `Moment: ${decision.type} · complexity ${decision.complexity} · effort ${decision.effort}` +
      (decision.model ? ` · model ${decision.model}` : ""),
  );
  const flags: string[] = [];
  if (decision.breakpoint) flags.push("design breakpoint");
  if (decision.dispatch_retrieval) flags.push("retrieval dispatched");
  if (decision.delegate_to) flags.push(`delegate → ${decision.delegate_to}`);
  if (flags.length) lines.push(flags.join(" · "));

  if (candidates.length) {
    lines.push("", "Relevant files (graph-scored):");
    for (const c of candidates.slice(0, 8)) {
      lines.push(`- ${c.path}${c.reason ? ` — ${c.reason}` : ""} (${c.score.toFixed(2)})`);
    }
  }
  if (decision.context_files_to_preload.length) {
    lines.push("", `Suggested to preload: ${decision.context_files_to_preload.join(", ")}`);
  }
  if (priorDecisions.length) {
    lines.push("", "Recalled from earlier:");
    for (const m of priorDecisions.slice(0, 5)) lines.push(`- [${m.kind}] ${m.text}`);
  }
  // Make the model/effort selection actionable advice, not just a logged afterthought.
  const guidance =
    decision.effort === "high"
      ? `Guidance: this is a hard moment — consider ${decision.model ?? "a stronger model"} at high effort.`
      : decision.effort === "minimal"
        ? "Guidance: a low-stakes moment — a cheaper model at minimal effort is appropriate."
        : null;
  if (guidance) lines.push("", guidance);
  return lines.join("\n");
}

export async function handleUserPromptSubmit(
  envelope: UserPromptSubmitEnvelope,
  ctx: HookContext,
): Promise<HookResponse> {
  const thought = await ctx.sessionReader.lineOfThought(envelope.session_id, envelope.transcript_path);
  const stage1 = await stageOne(
    envelope.prompt,
    thought,
    { graph: ctx.graph, repoRoot: ctx.repoRoot },
    ctx.config.router,
  );

  if (stage1.trivial) {
    ctx.logger.log({
      event: "router",
      session_id: envelope.session_id,
      component: "router",
      stage2_invoked: false,
      stage1_candidates: { files: [] },
      cost_usd: 0,
      decision: { type: "other", complexity: "trivial" },
    });
    return {}; // trivial prompt → free early exit, nothing injected
  }

  const provider = ctx.registry.forComponent("router");
  const rank = await stageTwo(provider, {
    prompt: envelope.prompt,
    thought,
    candidates: stage1.candidates,
  });

  const effortChoice: ModelEffortChoice = selectModelEffort(rank.decision.complexity, ctx.config);
  const effort: Effort = effortChoice.effort;
  const decision: RouterDecision = {
    ...rank.decision,
    effort,
    ...(effortChoice.model ? { model: effortChoice.model } : rank.decision.model ? { model: rank.decision.model } : {}),
  };

  let priorDecisions: ScoredMemory[] = [];
  try {
    priorDecisions = await ctx.memory.recall({
      query: envelope.prompt,
      kinds: ["decision", "approach"],
      scope: { project: ctx.project, workspaceCascade: false },
      limit: 5,
    });
  } catch {
    // Recall is best-effort; a memory failure must not cost us the recommendation (the I tenet).
  }

  // Cache the decision so PreToolUse (injector) sees the moment type and Stop (compactor) sees what
  // was recalled. Best-effort — a cache failure never breaks the turn.
  writeLastDecision(
    envelope.session_id,
    {
      type: decision.type,
      complexity: decision.complexity,
      breakpoint: decision.breakpoint,
      dispatch_retrieval: decision.dispatch_retrieval,
      effort: decision.effort,
      recalledIds: priorDecisions.map((m) => m.id),
      ts: Date.now(),
    },
    ctx.repoRoot,
    ctx.env,
  );

  ctx.logger.log({
    event: "router",
    session_id: envelope.session_id,
    component: "router",
    stage2_invoked: true,
    stage1_candidates: { files: stage1.candidates.map((c) => c.path), usedFallback: stage1.usedFallback },
    decision: {
      type: decision.type,
      complexity: decision.complexity,
      breakpoint: decision.breakpoint,
      dispatch_retrieval: decision.dispatch_retrieval,
      effort: decision.effort,
      model: decision.model,
      context_files_to_preload: decision.context_files_to_preload,
    },
    recalled: priorDecisions.length,
    cost_usd: rank.costUsd,
    latency_ms: rank.latencyMs,
    provider: provider.id,
    model: rank.model ?? provider.model,
  });

  const retrieved = decision.dispatch_retrieval ? await dispatchRetrieval(envelope, ctx, decision, effort) : null;
  const review =
    decision.breakpoint && ctx.config.molar_edit.review_on_breakpoint
      ? await dispatchReview(envelope, ctx, decision, thought, effort)
      : null;

  // Auto-delegation: turn the categorizer's delegate_to into a suggestion or (where the platform
  // supports subagents and mode is auto) a direct instruction. Logged so `corpocode review` can see it.
  const delegation = planDelegation(decision.delegate_to, ctx.config, ctx.platform);
  if (delegation) {
    ctx.logger.log({
      event: "delegation",
      session_id: envelope.session_id,
      component: "router",
      delegate_to: delegation.delegateTo,
      mode: delegation.mode,
      platform: ctx.platform,
    });
  }

  return {
    hookEventName: "UserPromptSubmit",
    additionalContext: joinBlocks([
      { tag: TAGS.recommendation, content: buildRecommendation(decision, stage1.candidates, priorDecisions) },
      retrieved ? { tag: TAGS.retrievedContext, content: retrieved } : null,
      review ? { tag: TAGS.designReview, content: review } : null,
      delegation ? { tag: TAGS.delegation, content: delegation.text } : null,
    ]),
  };
}

/** Run the retrieval team and return its injectable block, or null if it found nothing / failed. */
async function dispatchRetrieval(
  envelope: UserPromptSubmitEnvelope,
  ctx: HookContext,
  decision: RouterDecision,
  effort: Effort,
): Promise<string | null> {
  try {
    const cues = await ctx.sessionReader.retrievalCues(envelope.session_id);
    const pkg = await runRetrieval(
      { sessionId: envelope.session_id, type: decision.type, prompt: envelope.prompt, cues },
      {
        provider: ctx.registry.forComponent("retrieval"),
        backends: { graph: ctx.graph, context: ctx.context, memory: ctx.memory, scope: { project: ctx.project, workspaceCascade: false } },
        config: ctx.config.retrieval,
        logger: ctx.logger,
        effort,
        ...(ctx.plugins.templates.length > 0 ? { templates: ctx.plugins.templates } : {}),
      },
    );
    return pkg.refs.length > 0 ? pkg.block : null;
  } catch {
    return null; // retrieval is best-effort — its failure never costs the turn
  }
}

/** Run the design-review team at a breakpoint and return its injectable feedback, or null. */
async function dispatchReview(
  envelope: UserPromptSubmitEnvelope,
  ctx: HookContext,
  decision: RouterDecision,
  thought: { intent: string; approach?: string },
  effort: Effort,
): Promise<string | null> {
  try {
    const designContext = [
      `Task type: ${decision.type}`,
      thought.intent ? `Intent: ${thought.intent}` : "",
      thought.approach ? `Approach: ${thought.approach}` : "",
      `Prompt: ${envelope.prompt}`,
    ]
      .filter(Boolean)
      .join("\n");
    const result = await runDesignReview(
      { sessionId: envelope.session_id, designContext },
      { provider: ctx.registry.forComponent("router"), config: ctx.config, logger: ctx.logger, effort },
    );
    return result.feedback;
  } catch {
    return null; // review is best-effort
  }
}
