// The planner builds the checklist. It selects a template by the moment's type and folds the
// session reader's cues into each item; if no template matches, it makes ONE constrained selection
// call from a fixed menu rather than inventing items. Either way the result is capped at
// max_checklist_items. If the planner's own model call fails, a safe default checklist still runs —
// retrieval degrades to less precise, never to nothing (the In-flight tenet).
import type { RetrievalCues } from "../session/types";
import type { Provider } from "../providers/types";
import type { Effort } from "../config/schema";
import { applyEffort } from "../providers/effort";
import { resolvePrompt } from "../prompts/resolve";
import type { ChecklistItem } from "./types";
import type { RetrievalTemplate, TemplateFn } from "../plugins/types";
import { plannerOutputJsonSchema, plannerOutputSchema, type PlannerItem } from "./output-schema";
import { foldQuery } from "./templates/common";
import { codeEditTemplate } from "./templates/code-edit";
import { codeGenTemplate } from "./templates/code-gen";
import { explorationTemplate } from "./templates/exploration";
import { docsTemplate } from "./templates/docs";
import { configTemplate } from "./templates/config";

const TEMPLATES: Record<string, TemplateFn> = {
  "code-edit": codeEditTemplate,
  "code-gen": codeGenTemplate,
  exploration: explorationTemplate,
  docs: docsTemplate,
  config: configTemplate,
};

/** Built-ins plus plugin templates, with built-ins taking precedence so a plugin can ADD a moment type
 * but never silently override a core one. */
function templatesFor(extra: RetrievalTemplate[] | undefined): Record<string, TemplateFn> {
  if (!extra || extra.length === 0) return TEMPLATES;
  const merged: Record<string, TemplateFn> = {};
  for (const t of extra) merged[t.type] = t.build;
  return { ...merged, ...TEMPLATES };
}

export interface PlanInput {
  type: string;
  prompt: string;
  cues: RetrievalCues;
  maxItems: number;
}

export interface PlanDeps {
  provider: Provider;
  effort?: Effort;
  templates?: RetrievalTemplate[]; // plugin-contributed templates (corpocode-template-*)
}

export async function planChecklist(input: PlanInput, deps: PlanDeps): Promise<ChecklistItem[]> {
  const template = templatesFor(deps.templates)[input.type];
  const items = template ? template(input.cues, input.prompt) : await fallbackSelect(input, deps);
  return items.slice(0, input.maxItems);
}

/** The keyless safety net: a generic three-abstraction checklist used when the planner LLM is down. */
function defaultChecklist(input: PlanInput): ChecklistItem[] {
  const q = foldQuery(input.cues, input.prompt);
  return [
    { kind: "query_graph", label: "structure", priority: 0.8, query: q, budget: 800 },
    { kind: "ov_find", label: "reference", priority: 0.6, query: q, tier: "L0", limit: 4 },
    { kind: "mem_recall", label: "lessons", priority: 0.7, query: q, kinds: ["mistake", "rule", "decision"], limit: 5 },
  ];
}

function menuToItem(item: PlannerItem, priority: number): ChecklistItem {
  switch (item.kind) {
    case "query_graph":
      return { kind: "query_graph", label: `graph: ${item.query}`, priority, query: item.query, budget: 800 };
    case "ov_find":
      return { kind: "ov_find", label: `find: ${item.query}`, priority, query: item.query, tier: "L0", limit: 4 };
    case "mem_recall":
      return { kind: "mem_recall", label: `recall: ${item.query}`, priority, query: item.query, limit: 5 };
    case "get_node":
      return { kind: "get_node", label: `locate: ${item.query}`, priority, symbol: item.query };
  }
}

async function fallbackSelect(input: PlanInput, deps: PlanDeps): Promise<ChecklistItem[]> {
  try {
    const out = await deps.provider.chat(
      applyEffort(
        {
          system: resolvePrompt("retrieval"),
          responseFormat: "json",
          jsonSchema: plannerOutputJsonSchema,
          maxTokens: 300,
          messages: [{ role: "user", content: foldQuery(input.cues, input.prompt) }],
        },
        deps.effort,
      ),
    );
    const parsed = plannerOutputSchema.safeParse(JSON.parse(out.text));
    if (!parsed.success || parsed.data.items.length === 0) return defaultChecklist(input);
    return parsed.data.items.map((it, i) => menuToItem(it, Math.max(0.4, 0.75 - i * 0.05)));
  } catch {
    return defaultChecklist(input);
  }
}
