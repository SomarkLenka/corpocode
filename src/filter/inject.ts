// The context injector. On a file read (Read/Glob/Grep) it hands back a focused slice and any
// relevant warnings instead of letting the whole noisy file pour into context. It assembles its
// response from three pieces already built: PURPOSE (why this file, from the session reader — a null
// purpose triggers a clarifying question rather than a guess), a SLICE (a relevance pass bounded by
// the file's graph neighborhood and scoped to the purpose), and WARNINGS (this file's past mistakes
// and rules, recalled from memory right before the edit).
//
// Two guardrails keep it from ever doing harm: an exploration moment gets the whole file (slicing
// would defeat the point), and a low-confidence relevance pass injects nothing and lets the full
// read proceed. A PreToolUse hook cannot substitute a Read's result, so the slice is delivered as a
// focusing hint in additionalContext — guidance, never a replacement that could hide what's needed.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Effort } from "../config/schema";
import { applyEffort } from "../providers/effort";
import type { HookContext } from "../hooks/context";
import { TAGS, tagged, type HookResponse } from "../hooks/response";
import type { PreToolUseEnvelope } from "../hooks/envelope";
import { readLastDecision } from "../session/decision-cache";
import type { ScoredMemory } from "../backends/memory/types";

const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
export const isFileReadTool = (toolName: string): boolean => FILE_READ_TOOLS.has(toolName);

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const SLICE_CONFIDENCE = 0.5; // below this we inject nothing and let the full read proceed

function targetFile(toolInput: Record<string, unknown>): string | null {
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.path === "string") return toolInput.path;
  return null;
}

const relevanceSchema = z.object({
  relevant: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  focus: z.string().default(""),
});

function warningsBlock(file: string, warnings: ScoredMemory[]): string | null {
  if (warnings.length === 0) return null;
  return (
    `Heads-up on ${baseName(file)} (recalled from past sessions):\n` +
    warnings.map((w) => `- [${w.kind}] ${w.text}`).join("\n")
  );
}

async function relevancePass(
  ctx: HookContext,
  file: string,
  purpose: string,
  neighbors: string[],
  effort: Effort | undefined,
): Promise<z.infer<typeof relevanceSchema> | null> {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null; // can't read it (e.g. a Glob pattern, not a real path) → no slice
  }
  try {
    const out = await ctx.registry.forComponent("filter").chat(
      applyEffort(
        {
          system:
            `You decide which part of a file matters for a stated purpose, to focus a reader.\n` +
            `Purpose: ${purpose}\n` +
            `Structurally related symbols (from the code graph): ${neighbors.join(", ") || "(none)"}\n` +
            `Return ONLY JSON {"relevant":boolean,"confidence":number 0..1,"focus":string}, where focus ` +
            `names the function(s)/section(s) to read for this purpose. If the whole file is needed or ` +
            `you are unsure, set relevant=false.`,
          responseFormat: "json",
          maxTokens: 200,
          messages: [{ role: "user", content: content.slice(0, 6000) }],
        },
        effort,
      ),
    );
    const parsed = relevanceSchema.safeParse(JSON.parse(out.text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function injectFileRead(envelope: PreToolUseEnvelope, ctx: HookContext): Promise<HookResponse> {
  const file = targetFile(envelope.tool_input);
  if (!file) return {}; // Glob/Grep without a concrete file → nothing to slice
  const scope = { project: ctx.project, workspaceCascade: false };
  const decision = readLastDecision(envelope.session_id, ctx.repoRoot, ctx.env);
  const effort = decision?.effort as Effort | undefined;

  // Warnings first — always attempt; these are the cheapest and most valuable.
  let warnings: ScoredMemory[] = [];
  try {
    warnings = await ctx.memory.recall({ file, kinds: ["mistake", "rule"], scope, limit: 3 });
  } catch {
    // recall is best-effort
  }
  const warnBlock = warningsBlock(file, warnings);

  // Purpose. A null purpose means the session doesn't make it obvious — ask rather than slice wrong.
  const purpose = await ctx.sessionReader.filePurpose(envelope.session_id, file);
  if (purpose === null) {
    const ask =
      `CorpoCode: it isn't clear from the session why ${baseName(file)} is being read. If this is a ` +
      `targeted change, state what you're looking for and I'll focus the read; otherwise the full file proceeds.`;
    ctx.logger.log({ event: "inject", session_id: envelope.session_id, component: "filter", file, purpose_known: false, sliced: false, warnings: warnings.length });
    return injectBlocks([ask, warnBlock]);
  }

  // Exploration → the model genuinely wants the whole file; never slice, only warn.
  if (decision?.type === "exploration") {
    ctx.logger.log({ event: "inject", session_id: envelope.session_id, component: "filter", file, purpose_known: true, sliced: false, exploration: true, warnings: warnings.length });
    return injectBlocks([warnBlock]);
  }

  // Slice: a relevance pass bounded by the file's graph neighborhood and scoped to the purpose.
  let neighbors: string[] = [];
  try {
    const node = await ctx.graph.getNode(baseName(file));
    if (node) {
      const hood = await ctx.graph.getNeighbors(node.id, { depth: 1 });
      neighbors = hood.nodes.map((n) => n.name).slice(0, 12);
    }
  } catch {
    // graph is best-effort context for the slice; absence just means a less-bounded pass
  }
  const slice = await relevancePass(ctx, file, purpose, neighbors, effort);
  const sliceBlock =
    slice && slice.relevant && slice.confidence >= SLICE_CONFIDENCE && slice.focus.trim()
      ? `Reading ${baseName(file)} for: ${purpose}\nFocus on: ${slice.focus}`
      : null;

  ctx.logger.log({
    event: "inject",
    session_id: envelope.session_id,
    component: "filter",
    file,
    purpose_known: true,
    sliced: Boolean(sliceBlock),
    warnings: warnings.length,
  });

  return injectBlocks([sliceBlock, warnBlock]);
}

/** Wrap the non-empty pieces in a single file-context tag, or return nothing to inject. */
function injectBlocks(parts: Array<string | null>): HookResponse {
  const body = parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");
  if (!body) return {};
  return { hookEventName: "PreToolUse", additionalContext: tagged(TAGS.fileContext, body) };
}
