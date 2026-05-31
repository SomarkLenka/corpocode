// Stage 2 of the categorizer: one structured call through the configured router provider. It ranks
// the stage-one candidates and classifies the moment, then we VALIDATE that every preloaded file is
// actually in the candidate set — the ranker can't invent references. If the provider is
// unavailable or returns garbage, a safe default decision keeps the turn moving (the I tenet).
import type { Provider } from "../providers/types";
import type { ScoredFile } from "../backends/graph/types";
import type { ThoughtState } from "../session/types";
import { routerDecisionJsonSchema, routerDecisionSchema, type RouterDecision } from "./output-schema";

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

function buildSystemPrompt(input: RankInput, candidatePaths: string[]): string {
  return [
    "You are a routing classifier for a coding agent. Classify the user's current moment and pick",
    "which candidate files matter. Respond with ONLY a JSON object with these fields:",
    "type (code-edit|code-gen|exploration|docs|config|other), complexity (trivial|medium|hard),",
    "breakpoint (boolean), delegate_to (string, optional), dispatch_retrieval (boolean),",
    "effort (minimal|medium|high), context_files_to_preload (string[], a SUBSET of the candidates).",
    "",
    "Line of thought:",
    `  intent: ${input.thought.intent || "(unknown)"}`,
    input.thought.approach ? `  approach: ${input.thought.approach}` : "",
    input.thought.entities.length ? `  entities: ${input.thought.entities.join(", ")}` : "",
    "",
    "Candidate files (only choose context_files_to_preload from these):",
    ...(candidatePaths.length ? candidatePaths.map((p) => `  - ${p}`) : ["  (none)"]),
  ]
    .filter((line) => line !== "")
    .join("\n");
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

export async function stageTwo(provider: Provider, input: RankInput): Promise<RankResult> {
  const candidatePaths = input.candidates.map((c) => c.path);
  try {
    const out = await provider.chat({
      system: buildSystemPrompt(input, candidatePaths),
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
