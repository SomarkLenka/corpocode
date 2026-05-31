// The shape stage two must return, validated with Zod. A strict schema here is what lets the
// categorizer reject a malformed or hallucinated ranker response and fall back gracefully.
import { z } from "zod";
import { difficultySchema, effortSchema } from "../config/schema";

export const routerDecisionSchema = z.object({
  type: z.enum(["code-edit", "code-gen", "exploration", "docs", "config", "other"]),
  complexity: difficultySchema, // trivial | medium | hard
  breakpoint: z.boolean(), // is this a design breakpoint? (acted on in Phase 2)
  delegate_to: z.string().optional(), // a subagent that could absorb this (acted on in Phase 3)
  dispatch_retrieval: z.boolean(), // should the retrieval team run? (the team is Phase 2)
  model: z.string().optional(), // from selectModelEffort
  effort: effortSchema, // minimal | medium | high
  context_files_to_preload: z.array(z.string()).default([]), // must be a subset of stage-one candidates
});

export type RouterDecision = z.infer<typeof routerDecisionSchema>;

/** A plain JSON-schema description handed to providers that support schema-constrained output. */
export const routerDecisionJsonSchema = {
  type: "object",
  properties: {
    type: { enum: ["code-edit", "code-gen", "exploration", "docs", "config", "other"] },
    complexity: { enum: ["trivial", "medium", "hard"] },
    breakpoint: { type: "boolean" },
    delegate_to: { type: "string" },
    dispatch_retrieval: { type: "boolean" },
    effort: { enum: ["minimal", "medium", "high"] },
    context_files_to_preload: { type: "array", items: { type: "string" } },
  },
  required: ["type", "complexity", "breakpoint", "dispatch_retrieval", "effort"],
} as const;
