// When no template matches the moment, the planner makes ONE constrained selection call: the model
// chooses items from a fixed menu of kinds rather than inventing them freely, so even the fallback
// path stays predictable and validatable. This Zod schema is that menu's contract.
import { z } from "zod";

export const plannerItemSchema = z.object({
  kind: z.enum(["query_graph", "ov_find", "mem_recall", "get_node"]),
  query: z.string().min(1),
});

export const plannerOutputSchema = z.object({
  items: z.array(plannerItemSchema).max(8).default([]),
});

export type PlannerItem = z.infer<typeof plannerItemSchema>;

/** A plain JSON-schema description for providers that support schema-constrained output. */
export const plannerOutputJsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { enum: ["query_graph", "ov_find", "mem_recall", "get_node"] },
          query: { type: "string" },
        },
        required: ["kind", "query"],
      },
    },
  },
  required: ["items"],
} as const;
