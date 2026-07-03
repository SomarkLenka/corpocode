// pre-write — the second live IntelligentRouter action-pattern (Phase 3 / A2). On a Write/Edit/MultiEdit
// at PreToolUse it gathers the target file's blast radius (graph neighbors + file memories), runs ONE
// read-only `pre-write-guidance` agent over those paths, and injects architectural guidance ("what not
// to touch, how this breaks Y") BEFORE the write lands. Advisory only — it never blocks or delays-to-veto
// a write. See docs/superpowers/specs/2026-07-02-pre-write-action-pattern-design.md.
//
// Same four atomic pieces as bug-hunt (§3 of the spec): the pure plan producer, the (registered) prompt
// id, the synthesizer, and the thin gated handler adapter. The pure pieces take no I/O so they unit-test
// directly.
import type { JsonSchema } from "../../agents/backend";
import type { HookContext } from "../../hooks/context";
import type { PreToolUseEnvelope } from "../../hooks/envelope";
import { TAGS, tagged, type HookResponse } from "../../hooks/response";
import type { LogFields } from "../../log/ndjson";
import { gather, type Candidates } from "../gather";
import { run } from "../engine";
import type { AgentTaskResult, Intent, OrchestrationPlan, OrchestrationResult } from "../types";
import { estTokens, raceDeadline } from "./shared";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** The free composition-layer check: is this tool call a file write at all? */
export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/** What the write is about to do — the file plus the proposed content (the one thing not on disk yet). */
export interface PreWriteTarget {
  file: string;
  proposedContent?: string;
}

/**
 * Pull the target file + proposed content out of an untyped tool_input, defensively. Mirrors the
 * verifier's module-local `extractWrittenFile` (verifier/handler.ts) but additionally needs the proposed
 * content, which nothing reads today: Write → `content`, Edit → `new_string`, MultiEdit → the joined
 * `edits[].new_string`. Content is capped at `maxProposedChars` — it rides inline in the agent call.
 */
export function extractPreWriteTarget(
  toolName: string,
  toolInput: Record<string, unknown>,
  maxProposedChars: number,
): PreWriteTarget | null {
  if (!isWriteTool(toolName)) return null;
  if (typeof toolInput.file_path !== "string") return null;
  let content: string | undefined;
  if (toolName === "Write" && typeof toolInput.content === "string") content = toolInput.content;
  else if (toolName === "Edit" && typeof toolInput.new_string === "string") content = toolInput.new_string;
  else if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    content = toolInput.edits
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).new_string : undefined))
      .filter((s): s is string => typeof s === "string")
      .join("\n");
  }
  return { file: toolInput.file_path, ...(content !== undefined ? { proposedContent: content.slice(0, maxProposedChars) } : {}) };
}

/** One architectural warning from the guidance agent. `severity:"block"` labels the warning's importance
 *  — it is NOT a permission decision; the pattern only ever injects (spec §4.1). */
export interface GuidanceWarning {
  claim: string;
  severity: "info" | "warn" | "block";
  refs?: string[];
}

export interface PreWriteGuidance {
  warnings: GuidanceWarning[];
}

/** JSON Schema handed to the agent. NOTE: the anthropic-cli backend parses but does not validate against
 *  this — malformed output surfaces as ok:false and is dropped; shape validation is the judge's job. */
export const GUIDANCE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["warnings"],
  properties: {
    warnings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "severity"],
        properties: {
          claim: { type: "string" },
          severity: { enum: ["info", "warn", "block"] },
          refs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const SEVERITY_RANK: Record<GuidanceWarning["severity"], number> = { block: 0, warn: 1, info: 2 };

function isValidWarning(w: unknown): w is GuidanceWarning {
  if (typeof w !== "object" || w === null) return false;
  const d = w as Record<string, unknown>;
  if (typeof d.claim !== "string") return false;
  if (typeof d.severity !== "string" || !(d.severity in SEVERITY_RANK)) return false;
  if (d.refs !== undefined && !(Array.isArray(d.refs) && d.refs.every((r) => typeof r === "string"))) return false;
  return true;
}

/** Defensive shape + policy check: a non-empty array of shape-valid warnings (empty → nothing to inject). */
function isGuidance(data: unknown): data is PreWriteGuidance {
  if (typeof data !== "object" || data === null) return false;
  const warnings = (data as Record<string, unknown>).warnings;
  return Array.isArray(warnings) && warnings.length > 0 && warnings.every(isValidWarning);
}

/** The pure knobs a plan needs. `taskPrompt` is the resolved (from the prompts registry) agent instruction;
 *  the handler resolves it so this producer stays I/O-free and directly testable. */
export interface PreWriteConfig {
  maxFiles: number;
  perAgentMs: number;
  maxInjectedTokens: number;
  maxProposedChars: number;
  taskPrompt: string;
}

/** Neighbor file paths from the gathered blast radius: deduped, target excluded, capped at maxFiles. */
function neighborPaths(candidates: Candidates, target: string, maxFiles: number): string[] {
  const seen = new Set<string>([target]);
  const out: string[] = [];
  for (const nb of candidates.neighborhoods) {
    for (const node of nb.nodes) {
      if (!node.path || seen.has(node.path)) continue;
      seen.add(node.path);
      out.push(node.path);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

/** Plan producer (pure). ONE read-only, ephemeral pre-write-guidance task — not a fan-out (spec §4.3).
 *  `inputs.files` carries PATHS the agent reads itself; the capped proposed content is the documented,
 *  necessary exception to "paths not contents" (the write hasn't happened, so it isn't on disk). */
export function planPreWrite(intent: Intent, candidates: Candidates, cfg: PreWriteConfig): OrchestrationPlan {
  const file = intent.kind === "pre-write" ? intent.file : "";
  const proposed = intent.kind === "pre-write" && intent.proposedContent ? intent.proposedContent.slice(0, cfg.maxProposedChars) : "";
  const reasoning = `Proposed change to ${file}:\n\n${proposed || "(proposed content unavailable)"}`;
  return {
    tasks: [
      {
        id: file,
        call: {
          component: "router" as const,
          taskKind: "pre-write-guidance" as const,
          task: cfg.taskPrompt,
          inputs: { files: [file, ...neighborPaths(candidates, file, cfg.maxFiles)], reasoning },
          tools: "read-only" as const,
          session: "ephemeral" as const,
          effort: "minimal" as const,
          timeoutMs: cfg.perAgentMs,
          schema: GUIDANCE_SCHEMA,
        },
      },
    ],
    fanoutWidth: 1,
    judge: (results) => results.filter((r) => r.result.ok && isGuidance(r.result.data)),
  };
}

/** Render one warning as a plain-text line (structure/meaning only, never markup). */
function renderWarning(w: GuidanceWarning): string {
  const refs = w.refs && w.refs.length ? ` (refs: ${w.refs.join(", ")})` : "";
  return `- [${w.severity}] ${w.claim}${refs}`;
}

/**
 * Synthesizer (§4.5): a pattern-specific renderer (the generic synthesize() would emit a raw JSON blob).
 * Folds the surviving warnings into ONE tagged block, highest severity first, within the injected-token
 * budget (dropping lowest-severity warnings to fit). The top warning is always kept even if it alone
 * exceeds the budget. Returns "" when nothing survived → no-op.
 */
export function synthesizePreWriteGuidance(result: OrchestrationResult, maxInjectedTokens: number): string {
  const survivors = result.tasks.filter((t: AgentTaskResult) => isGuidance(t.result.data));
  if (survivors.length === 0) return "";
  const file = survivors[0]!.id;
  const warnings = survivors
    .flatMap((t) => (t.result.data as PreWriteGuidance).warnings)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const header = `Pre-write guidance for ${file} — architectural risks before you write:`;
  const lines: string[] = [];
  let tokens = estTokens(header);
  for (const w of warnings) {
    const line = renderWarning(w);
    // Always include the top (highest-severity) warning; add the rest only while they fit the budget.
    if (lines.length === 0 || tokens + estTokens(line) <= maxInjectedTokens) {
      lines.push(line);
      tokens += estTokens(line);
    }
  }
  return tagged(TAGS.intelligentRouter, [header, ...lines].join("\n"));
}

// ── Handler adapter (§4.6) ──────────────────────────────────────────────────────────────────────────
// Thin and gated: extracts the write target, gathers the deterministic blast radius, applies the free
// no-blast-radius gate, runs the single-task plan under a hard deadline backstop, and injects the
// synthesized guidance. Reached only when ctx.agents is present AND the composed handler's write-tool
// check has already passed. Fully fail-open — any throw returns {}. Advisory only — the response never
// carries a permissionDecision; a non-empty response stamps hookEventName:"PreToolUse" so the unmodified
// mergeContext labels the merged response correctly (§4.7).

/** The no-blast-radius gate (§4.2): no graph node, no neighbors, and no file memories ⇒ nothing
 *  architectural to say — skip before any agent spend. gather is deterministic, so this gate is free. */
function blastRadiusEmpty(candidates: Candidates): boolean {
  const neighbors = candidates.neighborhoods.reduce((n, nb) => n + nb.nodes.length, 0);
  return candidates.nodes.length === 0 && neighbors === 0 && candidates.memories.length === 0;
}

export async function handlePreWrite(envelope: PreToolUseEnvelope, ctx: HookContext): Promise<HookResponse> {
  const startedAt = Date.now();
  const base = { event: "pattern", pattern: "pre-write", surface: "PreToolUse", session_id: envelope.session_id } as const;
  try {
    if (!ctx.agents) return {}; // defensive: the composed handler only calls us when agents are present
    const pw = ctx.config.agents.pre_write;
    const target = extractPreWriteTarget(envelope.tool_name, envelope.tool_input, pw.max_proposed_chars);
    if (!target) return {};
    const cfg: PreWriteConfig = {
      maxFiles: pw.max_files,
      perAgentMs: pw.per_agent_ms,
      maxInjectedTokens: pw.max_injected_tokens,
      maxProposedChars: pw.max_proposed_chars,
      taskPrompt: ctx.prompts.resolve("pre-write-guidance"),
    };
    const intent: Intent = {
      kind: "pre-write",
      file: target.file,
      proposedContent: target.proposedContent,
      sessionId: envelope.session_id,
      transcriptPath: envelope.transcript_path,
    };
    const candidates = await gather(intent, { graph: ctx.graph, memory: ctx.memory, project: ctx.project, logger: ctx.logger });
    if (blastRadiusEmpty(candidates)) {
      ctx.logger.log({ ...base, decision: "skipped", reason: "gate:no-blast-radius", latency_ms: Date.now() - startedAt });
      return {};
    }
    const plan = planPreWrite(intent, candidates, cfg);
    // The engine's log lines always carry `event` (agent_item / orchestrate) — safe to widen to LogFields.
    const { result, timedOut } = await raceDeadline(run(plan, { forTask: ctx.agents.forTask, log: (line) => ctx.logger.log(line as LogFields) }), pw.deadline_ms);
    const block = synthesizePreWriteGuidance(result, cfg.maxInjectedTokens);
    const warnings = result.tasks.reduce((n, t) => n + (isGuidance(t.result.data) ? (t.result.data as PreWriteGuidance).warnings.length : 0), 0);
    const reason = timedOut ? "deadline" : plan.tasks.length === 0 ? "empty-candidates" : block ? "ran" : "no-warnings";
    ctx.logger.log({
      ...base,
      decision: "ran",
      reason,
      files_considered: plan.tasks[0]?.call.inputs?.files?.length ?? 0,
      warnings,
      injected_tokens: block ? estTokens(block) : 0,
      cost_usd: result.usage.costUsd,
      latency_ms: Date.now() - startedAt,
    });
    return block ? { hookEventName: "PreToolUse", additionalContext: block } : {};
  } catch (err) {
    ctx.logger.log({ ...base, decision: "ran", reason: "error", message: err instanceof Error ? err.message : String(err), latency_ms: Date.now() - startedAt });
    return {};
  }
}
