// Turns the gated catalog into injected recommendations. `pickToolbox` runs the two classifiers
// (skills + agents) in parallel; `formatToolboxBlock` renders the injection text; `maybeRouteHeavyCoding`
// is the PreToolUse trigger — when the cached decision says the model is entering a medium/hard
// code-edit/code-gen phase and is about to write, it recommends a subagent WITH context, once per phase.
// Agents are always recommended, never auto-spawned. Everything is best-effort / fail-open.
import type { HookContext } from "../hooks/context";
import type { PreToolUseEnvelope } from "../hooks/envelope";
import type { Provider } from "../providers/types";
import type { Effort } from "../config/schema";
import { catalogFile } from "../config/paths";
import { readLastDecision, writeLastDecision } from "../session/decision-cache";
import { loadCatalog } from "./catalog";
import { classifyRelevant, type Selected } from "./classifier";
import type { ToolboxCatalog } from "./types";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const HEAVY_TYPES = new Set(["code-edit", "code-gen"]);
const HEAVY_COMPLEXITY = new Set(["medium", "hard"]);

export interface ToolboxPicks {
  skills: Selected[];
  agents: Selected[];
}

export async function pickToolbox(opts: {
  prompt: string;
  catalog: ToolboxCatalog;
  provider: Provider;
  maxSkills: number;
  maxAgents: number;
  effort?: Effort;
}): Promise<ToolboxPicks> {
  const deps = { provider: opts.provider, ...(opts.effort ? { effort: opts.effort } : {}) };
  const [skills, agents] = await Promise.all([
    classifyRelevant({ kind: "skill", prompt: opts.prompt, candidates: opts.catalog.entries.filter((e) => e.kind === "skill"), limit: opts.maxSkills }, deps),
    classifyRelevant({ kind: "agent", prompt: opts.prompt, candidates: opts.catalog.entries.filter((e) => e.kind === "agent"), limit: opts.maxAgents }, deps),
  ]);
  return { skills, agents };
}

/** Render the picks as an injectable block, or null if nothing was selected. */
export function formatToolboxBlock(picks: ToolboxPicks, agentContext?: string): string | null {
  const lines: string[] = [];
  if (picks.skills.length) {
    lines.push("Relevant skills for this task — invoke them by name as needed:");
    for (const s of picks.skills) lines.push(`- ${s.name}${s.reason ? ` — ${s.reason}` : ""}`);
  }
  if (picks.agents.length) {
    if (lines.length) lines.push("");
    lines.push("Relevant agents — ask the model to run them WITH the context below (do not auto-spawn):");
    for (const a of picks.agents) lines.push(`- ${a.name}${a.reason ? ` — ${a.reason}` : ""}`);
    if (agentContext) lines.push("", `Context to hand the agent: ${agentContext}`);
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * PreToolUse: when the model is entering a heavy coding phase and about to write, recommend a subagent
 * (and skills) with context — once per phase. Returns the injectable block, or null when it shouldn't
 * fire. Fail-open: any error → null.
 */
export async function maybeRouteHeavyCoding(envelope: PreToolUseEnvelope, ctx: HookContext): Promise<string | null> {
  try {
    if (!ctx.config.toolbox.enabled || !ctx.config.toolbox.route_on_heavy_coding) return null;
    if (!WRITE_TOOLS.has(envelope.tool_name)) return null;

    const decision = readLastDecision(envelope.session_id, ctx.repoRoot, ctx.env);
    if (!decision || !HEAVY_TYPES.has(decision.type) || !HEAVY_COMPLEXITY.has(decision.complexity)) return null;
    if (decision.routedPhaseTs) return null; // already routed this coding phase (rate-limit)

    const catalog = loadCatalog(catalogFile(ctx.env));
    if (catalog.entries.length === 0) return null;

    const thought = await ctx.sessionReader.lineOfThought(envelope.session_id, envelope.transcript_path);
    const file = typeof envelope.tool_input.file_path === "string" ? envelope.tool_input.file_path : "";
    const prompt = [thought.intent, thought.approach, `about to edit ${file}`].filter(Boolean).join(" — ");
    const picks = await pickToolbox({
      prompt,
      catalog,
      provider: ctx.registry.forComponent("toolbox"),
      maxSkills: ctx.config.toolbox.max_skills,
      maxAgents: ctx.config.toolbox.max_agents,
    });

    const block = formatToolboxBlock(picks, [thought.intent, ...thought.entities].filter(Boolean).join(", ") || undefined);
    if (!block) return null;

    // Mark this phase routed so we don't re-classify on every edit in the same phase.
    writeLastDecision(envelope.session_id, { ...decision, routedPhaseTs: Date.now() }, ctx.repoRoot, ctx.env);
    ctx.logger.log({
      event: "toolbox",
      session_id: envelope.session_id,
      component: "toolbox",
      trigger: "pretooluse",
      skills: picks.skills.length,
      agents: picks.agents.length,
    });
    return block;
  } catch {
    return null;
  }
}
