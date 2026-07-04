// The spec artifact's authoritative shape — spec.json is the structure the swarm executes against
// and spec.md is DERIVED from it, one direction only (structure, not presentation). Zod-validated on
// every write and read, so a hand-edited or truncated spec is a clear error, never silent drift.
//
// The decisions ledger lives INSIDE the spec: the spec is not complete without the audit trail of
// every human choice that shaped it (source: pilot | delegated | default — never a silent guess).
import { z } from "zod";
import { SPEC_SECTIONS } from "./types";

export const axisFindingSchema = z.object({
  axis: z.string(),
  optionId: z.string(),
  summary: z.string(),
  severity: z.enum(["info", "warn", "risk"]),
  ok: z.boolean(),
});

export const answerSchema = z.object({
  pollId: z.string(),
  optionId: z.string().optional(),
  freeText: z.string().optional(),
  source: z.enum(["pilot", "delegated", "default"]),
});

export const specSectionIdSchema = z.enum(SPEC_SECTIONS);

export const decisionRecordSchema = z.object({
  pollId: z.string(),
  section: specSectionIdSchema,
  concept: z.string(),
  question: z.string(),
  options: z.array(
    z.object({ id: z.string(), label: z.string(), findings: z.array(axisFindingSchema).default([]) }),
  ),
  answer: answerSchema,
  at: z.number(),
});
export type DecisionRecordShape = z.infer<typeof decisionRecordSchema>;

/** One acceptance criterion with an explicit verification method. `command` criteria become task
 *  verifyCommands in decompose; `manual` ones surface at the landing poll. */
export const acceptanceSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  verify: z.object({
    method: z.enum(["command", "test", "manual"]),
    command: z.string().optional(), // required in spirit for method=command|test; validated in decompose
  }),
});

/** A seed the decompose stage grows into a full task. Seeds come out of the interrogation
 *  (the parallelization section) so the task graph is decided WITH the human, not invented after.
 *  modelTier/userGate carry the pcvelz/superpowers task-metadata discipline: tier routes the
 *  implementer's capability, userGate marks a task the pilot ordered as a verification gate. */
export const taskSeedSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  files: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  verifyCommand: z.string().optional(), // authored at decompose when absent; never silently dropped
  acceptanceRefs: z.array(z.string()).default([]),
  modelTier: z.enum(["mechanical", "standard", "frontier"]).optional(),
  userGate: z.boolean().optional(),
  tags: z.array(z.string()).default([]),
});

export const specSchema = z.object({
  version: z.literal(1).default(1),
  runId: z.string(),
  task: z.string(), // the original task statement handed to `corpocode start`
  entities: z
    .array(z.object({ name: z.string(), description: z.string(), fields: z.array(z.string()).default([]) }))
    .default([]),
  contracts: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["api", "function", "event", "cli", "schema"]),
        signature: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
  constraints: z.array(z.string()).default([]),
  futureSeams: z.array(z.string()).default([]),
  compartments: z
    .array(z.object({ name: z.string(), responsibility: z.string(), reasonToChange: z.string() }))
    .default([]),
  scalePath: z.array(z.string()).default([]),
  reusableSystems: z.array(z.object({ name: z.string(), purpose: z.string() })).default([]),
  acceptance: z.array(acceptanceSchema).default([]),
  taskSeeds: z.array(taskSeedSchema).default([]),
  decisions: z.array(decisionRecordSchema).default([]),
  /** The section ledger at completion — every lamp must be "complete" before the approve poll. */
  sections: z.record(specSectionIdSchema, z.enum(["open", "in-progress", "complete"])).default({}),
  approvedAt: z.number().optional(), // set when the pilot answers the final approve poll
});
export type Spec = z.infer<typeof specSchema>;
export type TaskSeed = z.infer<typeof taskSeedSchema>;

/** Derive the human-readable spec.md from spec.json — one direction only, never parsed back. */
export function renderSpecMarkdown(spec: Spec): string {
  const lines: string[] = [`# Spec — ${spec.task}`, "", `Run: ${spec.runId}`, ""];
  const section = (title: string, rows: string[]): void => {
    if (!rows.length) return;
    lines.push(`## ${title}`, "", ...rows, "");
  };
  section(
    "Entities",
    spec.entities.map((e) => `- **${e.name}** — ${e.description}${e.fields.length ? ` (${e.fields.join(", ")})` : ""}`),
  );
  section(
    "Contracts",
    spec.contracts.map((c) => `- **${c.name}** (${c.kind}): \`${c.signature}\` — ${c.description}`),
  );
  section("Constraints", spec.constraints.map((c) => `- ${c}`));
  section("Future seams (must not foreclose)", spec.futureSeams.map((s) => `- ${s}`));
  section(
    "Compartments",
    spec.compartments.map((c) => `- **${c.name}** — ${c.responsibility} (changes when: ${c.reasonToChange})`),
  );
  section("Path to scale", spec.scalePath.map((s) => `- ${s}`));
  section("Reusable systems", spec.reusableSystems.map((r) => `- **${r.name}** — ${r.purpose}`));
  section(
    "Acceptance",
    spec.acceptance.map((a) => `- [${a.id}] ${a.criterion} — verify: ${a.verify.method}${a.verify.command ? ` (\`${a.verify.command}\`)` : ""}`),
  );
  section(
    "Task seeds",
    spec.taskSeeds.map(
      (t) => `- [${t.id}] **${t.title}** — ${t.description}${t.dependsOn.length ? ` (after ${t.dependsOn.join(", ")})` : ""}`,
    ),
  );
  section(
    "Decisions",
    spec.decisions.map((d) => {
      const chosen = d.answer.optionId
        ? d.options.find((o) => o.id === d.answer.optionId)?.label ?? d.answer.optionId
        : d.answer.freeText ?? "(unanswered)";
      return `- [${d.section}] ${d.question} → **${chosen}** (${d.answer.source})`;
    }),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
