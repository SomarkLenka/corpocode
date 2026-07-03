// bug-hunt — the first live IntelligentRouter action-pattern (Phase 1 / A1). On a bug-shaped prompt it
// fans out one read-only `file-relevance` agent per top-ranked candidate file; each agent opens the file
// itself and returns whether it is implicated plus cited lines. The judge drops the not-implicated and
// low-confidence; the synthesizer folds the survivors into ONE cited-lines injection so the main model
// skips the reads. See docs/superpowers/specs/2026-07-02-bug-hunt-action-pattern-design.md.
//
// This module holds the four atomic pieces of the action-pattern contract (§3 of the spec): the pure
// plan producer, the (registered) prompt id, the synthesizer, and — added in the handler section — the
// thin gated handler adapter. The pure pieces below take no I/O so they unit-test directly.
import type { JsonSchema } from "../../agents/backend";
import type { HookContext } from "../../hooks/context";
import type { UserPromptSubmitEnvelope } from "../../hooks/envelope";
import { TAGS, tagged, type HookResponse } from "../../hooks/response";
import type { LogFields } from "../../log/ndjson";
import type { CachedDecision } from "../../session/decision-cache";
import { gather, type Candidates } from "../gather";
import { run } from "../engine";
import type { AgentTaskResult, Intent, OrchestrationPlan, OrchestrationResult } from "../types";
import { estTokens, raceDeadline } from "./shared";

/** Bug vocabulary — whole-word, case-insensitive, plus a few multi-word phrases. The gate scans the
 *  envelope prompt only (no model call). The exact list is intentionally tunable; see spec §4.1. */
export const BUG_SIGNAL =
  /\b(?:errors?|fail(?:s|ing|ed)?|broken|breaks?|throw(?:s|ing|n)?|exception|stack ?trace|traceback|regression|crash(?:es|ing)?|bug|unexpected)\b|\bnot working\b|\bdoesn['’]?t work\b|\bdoes not work\b|\bwrong output\b/i;

/** The moment types (from the categorizer's `type` enum) under which a bug investigation is plausible. */
const BUG_LIKE_TYPES = new Set(["code-edit", "exploration"]);

/**
 * The free, deterministic trigger gate. Fires only when the categorizer classified THIS turn's moment
 * (a fresh cache entry) as an edit/exploration AND the prompt carries bug vocabulary. Reuses the
 * decision the router already cached — no extra LLM call. A stale entry (its `ts` predates the turn,
 * which happens on the stage-1 trivial early-exit that writes nothing) is treated as "no decision".
 */
export function isBugLike(prompt: string, decision: CachedDecision | null, turnStartedAt: number): boolean {
  if (!decision) return false;
  if (decision.ts < turnStartedAt) return false; // stale prior-turn entry — never gate on it
  if (!BUG_LIKE_TYPES.has(decision.type)) return false;
  return BUG_SIGNAL.test(prompt);
}

/** What each file-relevance agent returns (validated defensively by the judge — the backend only parses). */
export interface BugRelevance {
  implicated: boolean;
  confidence: number; // 0..1
  lines?: Array<{ start: number; end: number; why: string }>;
}

/** JSON Schema handed to the agent. NOTE: the anthropic-cli backend parses but does not validate against
 *  this — malformed output surfaces as ok:false and is dropped; shape validation is the judge's job. */
export const BUG_RELEVANCE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["implicated", "confidence"],
  properties: {
    implicated: { type: "boolean" },
    confidence: { type: "number", description: "0..1" },
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["start", "end", "why"],
        properties: {
          start: { type: "integer" },
          end: { type: "integer" },
          why: { type: "string" },
        },
      },
    },
  },
};

/** Defensive shape + policy check: a real implicated boolean and a numeric confidence at/above the floor. */
function isRelevant(data: unknown, floor: number): data is BugRelevance {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.implicated === true && typeof d.confidence === "number" && d.confidence >= floor;
}

/** The pure knobs a plan needs. `taskPrompt` is the resolved (from the prompts registry) agent instruction;
 *  the handler resolves it so this producer stays I/O-free and directly testable. */
export interface BugHuntConfig {
  maxFiles: number;
  perAgentMs: number;
  confidenceFloor: number;
  maxInjectedTokens: number;
  taskPrompt: string;
}

/** Plan producer (pure). One read-only, ephemeral file-relevance task per top-`maxFiles` candidate file. */
export function planBugHunt(intent: Intent, candidates: Candidates, cfg: BugHuntConfig): OrchestrationPlan {
  const reasoning = intent.kind === "prompt" ? intent.prompt : "";
  const tasks = candidates.files.slice(0, cfg.maxFiles).map((f) => ({
    id: f.path,
    call: {
      component: "router" as const,
      taskKind: "file-relevance" as const,
      task: cfg.taskPrompt,
      inputs: { files: [f.path], reasoning }, // the PATH only — the agent reads the file itself
      tools: "read-only" as const,
      session: "ephemeral" as const,
      effort: "minimal" as const,
      timeoutMs: cfg.perAgentMs,
      schema: BUG_RELEVANCE_SCHEMA,
    },
  }));
  return {
    tasks,
    fanoutWidth: cfg.maxFiles,
    judge: (results) => results.filter((r) => r.result.ok && isRelevant(r.result.data, cfg.confidenceFloor)),
  };
}

/** Render one surviving task to a plain-text cited-lines block (structure/meaning only, never markup). */
function renderFinding(id: string, data: BugRelevance): string {
  const lines = (data.lines ?? []).filter(
    (l) => Number.isInteger(l.start) && Number.isInteger(l.end) && typeof l.why === "string",
  );
  const cited = lines.length
    ? lines.map((l) => `- L${l.start}-${l.end}: ${l.why}`).join("\n")
    : "- implicated (no specific lines cited)";
  return `## ${id}\n${cited}`;
}

/**
 * Synthesizer (§4.4): fold the surviving tasks into ONE tagged cited-lines injection, highest-confidence
 * first, within the injected-token budget (dropping lowest-confidence findings to fit). The strongest
 * finding is always kept even if it alone exceeds the budget. Returns "" when nothing survived → no-op.
 */
export function synthesizeBugHunt(result: OrchestrationResult, maxInjectedTokens: number): string {
  const findings = result.tasks
    .map((t: AgentTaskResult) => ({ id: t.id, data: t.result.data }))
    .filter((f): f is { id: string; data: BugRelevance } => isRelevant(f.data, 0))
    .sort((a, b) => b.data.confidence - a.data.confidence);
  if (findings.length === 0) return "";

  const header = "Bug-hunt investigated the candidate files. Cited lines below — the main model can skip re-reading these.";
  const blocks: string[] = [];
  let tokens = estTokens(header);
  for (const f of findings) {
    const block = renderFinding(f.id, f.data);
    // Always include the top (first) finding; add the rest only while they fit the budget.
    if (blocks.length === 0 || tokens + estTokens(block) <= maxInjectedTokens) {
      blocks.push(block);
      tokens += estTokens(block);
    }
  }
  return tagged(TAGS.intelligentRouter, [header, ...blocks].join("\n\n"));
}

// ── Handler adapter (§4.5) ──────────────────────────────────────────────────────────────────────────
// Thin and gated: builds the prompt Intent, gathers deterministic candidates, fans out the plan under a
// hard deadline backstop, and folds survivors into one injection. Reached only when ctx.agents is present
// AND the composed handler's gate (isBugLike) has already passed. Fully fail-open — any throw returns {}.

export async function handleBugHunt(
  envelope: UserPromptSubmitEnvelope,
  ctx: HookContext,
  _decision: CachedDecision,
): Promise<HookResponse> {
  const startedAt = Date.now();
  const base = { event: "pattern", pattern: "bug-hunt", surface: "UserPromptSubmit", session_id: envelope.session_id, decision: "ran" } as const;
  try {
    if (!ctx.agents) return {}; // defensive: the composed handler only calls us when agents are present
    const bh = ctx.config.agents.bug_hunt;
    const cfg: BugHuntConfig = {
      maxFiles: bh.max_files,
      perAgentMs: bh.per_agent_ms,
      confidenceFloor: bh.confidence_floor,
      maxInjectedTokens: bh.max_injected_tokens,
      taskPrompt: ctx.prompts.resolve("bug-hunt-file-relevance"),
    };
    const intent: Intent = {
      kind: "prompt",
      prompt: envelope.prompt,
      sessionId: envelope.session_id,
      transcriptPath: envelope.transcript_path,
    };
    const candidates = await gather(intent, { graph: ctx.graph, memory: ctx.memory, project: ctx.project, logger: ctx.logger });
    const plan = planBugHunt(intent, candidates, cfg);
    // The engine's log lines always carry `event` (agent_item / orchestrate) — safe to widen to LogFields.
    const { result, timedOut } = await raceDeadline(run(plan, { forTask: ctx.agents.forTask, log: (line) => ctx.logger.log(line as LogFields) }), bh.deadline_ms);
    const block = synthesizeBugHunt(result, cfg.maxInjectedTokens);
    const reason = timedOut ? "deadline" : plan.tasks.length === 0 ? "empty-candidates" : "ran";
    ctx.logger.log({
      ...base,
      reason,
      files_considered: candidates.files.length,
      files_fanned: plan.tasks.length,
      survivors: result.tasks.length,
      injected_tokens: block ? estTokens(block) : 0,
      cost_usd: result.usage.costUsd,
      latency_ms: Date.now() - startedAt,
    });
    return block ? { hookEventName: "UserPromptSubmit", additionalContext: block } : {};
  } catch (err) {
    ctx.logger.log({ ...base, reason: "error", message: err instanceof Error ? err.message : String(err), latency_ms: Date.now() - startedAt });
    return {};
  }
}
