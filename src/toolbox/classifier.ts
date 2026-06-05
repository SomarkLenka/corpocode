// The cheap-model classifier: given the gated catalog (each entry's ORIGINAL "when to use") and the
// user's request, pick the genuinely relevant skills/agents. Mirrors the router's stageTwo pattern —
// JSON response, applyEffort, Zod-validated, names checked against the catalog, capped, and fail-open
// to [] so a classifier outage never costs the turn or surfaces a wrong pick.
import { z } from "zod";
import type { Provider } from "../providers/types";
import type { Effort } from "../config/schema";
import { applyEffort } from "../providers/effort";
import { resolvePrompt } from "../prompts/resolve";
import type { ToolboxEntry, ToolboxKind } from "./types";

const selectionSchema = z.object({
  selected: z.array(z.object({ name: z.string(), reason: z.string().default("") })).default([]),
});

export interface Selected {
  name: string;
  reason: string;
  entry: ToolboxEntry;
}

export interface ClassifyInput {
  kind: ToolboxKind;
  prompt: string;
  candidates: ToolboxEntry[]; // catalog entries already filtered to this kind
  limit: number;
}

export async function classifyRelevant(
  input: ClassifyInput,
  deps: { provider: Provider; effort?: Effort },
): Promise<Selected[]> {
  if (input.candidates.length === 0 || input.limit === 0) return [];
  const menu = input.candidates.map((e) => `- ${e.name}: ${e.description}`).join("\n");
  const system = resolvePrompt("toolbox", { kind: input.kind, menu });
  try {
    const out = await deps.provider.chat(
      applyEffort(
        {
          system,
          responseFormat: "json",
          maxTokens: 250,
          messages: [{ role: "user", content: input.prompt.slice(0, 4000) }],
        },
        deps.effort,
      ),
    );
    const parsed = selectionSchema.safeParse(JSON.parse(out.text));
    if (!parsed.success) return [];
    const byName = new Map(input.candidates.map((e) => [e.name, e]));
    const seen = new Set<string>();
    const result: Selected[] = [];
    for (const s of parsed.data.selected) {
      const entry = byName.get(s.name);
      if (!entry || seen.has(s.name)) continue; // drop hallucinated / duplicate names
      seen.add(s.name);
      result.push({ name: s.name, reason: s.reason, entry });
      if (result.length >= input.limit) break;
    }
    return result;
  } catch {
    return [];
  }
}
