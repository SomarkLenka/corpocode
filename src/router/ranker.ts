// Stage 2 of the categorizer: one structured call through the configured router provider. It ranks
// the stage-one candidates and classifies the moment, then we VALIDATE that every preloaded file is
// actually in the candidate set — the ranker can't invent references. If the provider is
// unavailable or returns garbage, a safe default decision keeps the turn moving (the I tenet).
import type { Provider } from "../providers/types";
import type { ScoredFile } from "../backends/graph/types";
import type { ThoughtState } from "../session/types";
import { routerDecisionJsonSchema, routerDecisionSchema, type RouterDecision } from "./output-schema";
import { resolvePrompt, type PromptResolver } from "../prompts/resolve";

export interface RankInput {
  prompt: string;
  thought: ThoughtState;
  candidates: ScoredFile[];
}

export interface RankResult {
  decision: RouterDecision;
  costUsd: number;
  model: string | null;
  latencyMs: number;
  invokedModel: boolean;
}

// Builds the router system prompt by filling the editable "router" template's {{placeholders}} with the
// distilled line-of-thought block and the bulleted candidate list. The static instructions live in the
// template (registry default or a user override); only the runtime data is computed here.
function buildSystemPrompt(input: RankInput, candidatePaths: string[], prompts?: PromptResolver): string {
  const lineOfThought =
    [
      `  intent: ${input.thought.intent || "(unknown)"}`,
      input.thought.approach ? `  approach: ${input.thought.approach}` : "",
      input.thought.entities.length ? `  entities: ${input.thought.entities.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n") || "  (none)";
  const candidates = candidatePaths.length ? candidatePaths.map((p) => `  - ${p}`).join("\n") : "  (none)";
  const vars = { lineOfThought, candidates };
  return prompts ? prompts.resolve("router", vars) : resolvePrompt("router", vars);
}

/** The graceful fallback decision when the model can't be reached or returns invalid output. */
export function defaultDecision(candidates: ScoredFile[]): RouterDecision {
  return {
    type: "other",
    complexity: "medium",
    breakpoint: false,
    dispatch_retrieval: candidates.length > 0,
    effort: "medium",
    context_files_to_preload: candidates.slice(0, 3).map((c) => c.path),
  };
}

export async function stageTwo(provider: Provider, input: RankInput, prompts?: PromptResolver): Promise<RankResult> {
  const candidatePaths = input.candidates.map((c) => c.path);
  try {
    const out = await provider.chat({
      system: buildSystemPrompt(input, candidatePaths, prompts),
      responseFormat: "json",
      jsonSchema: routerDecisionJsonSchema,
      maxTokens: 400,
      messages: [{ role: "user", content: input.prompt }],
    });
    const parsed = routerDecisionSchema.safeParse(JSON.parse(out.text));
    if (!parsed.success) {
      return { decision: defaultDecision(input.candidates), costUsd: out.costUsd, model: out.model, latencyMs: out.latencyMs, invokedModel: true };
    }
    const allowed = new Set(candidatePaths);
    const decision: RouterDecision = {
      ...parsed.data,
      // Validation: the ranker may only preload files that were actual candidates.
      context_files_to_preload: parsed.data.context_files_to_preload.filter((f) => allowed.has(f)),
    };
    return { decision, costUsd: out.costUsd, model: out.model, latencyMs: out.latencyMs, invokedModel: true };
  } catch {
    return { decision: defaultDecision(input.candidates), costUsd: 0, model: null, latencyMs: 0, invokedModel: false };
  }
}
