// The tasks.json mirror — a versioned SUPERSET of the superpowers plan schema, so a spec-only run
// hands back a task graph that superpowers-equipped Claude Code can execute today, while carrying
// the orchestrator's extra fields (dependsOn, specRefs, modelTier, budgetUsd) that superpowers
// simply ignores. Fusion contract discipline (docs/SUPERPOWERING-SUPERPOWERS.md): the parse side
// is TOLERANT — unknown keys stripped, missing arrays defaulted — because the file may have been
// written by either plane, hand-edited, or truncated, and a read must never brick a session.
import { z } from "zod";
import type { Spec } from "../spec-schema";

const taskEntrySchema = z
  .object({
    id: z.string(),
    // superpowers plan files carry only a description — no title — so title must default rather
    // than reject the very artifact this mirror exists to read.
    title: z.string().default(""),
    description: z.string().default(""),
    files: z.array(z.string()).default([]),
    verifyCommand: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).default([]),
    dependsOn: z.array(z.string()).default([]),
    status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
    modelTier: z.string().optional(),
    budgetUsd: z.number().optional(),
    specRefs: z.array(z.string()).default([]),
    // pcvelz/superpowers gate metadata (task-format-reference.md) — carried, never interpreted here.
    userGate: z.boolean().optional(),
    tags: z.array(z.string()).default([]),
    requiresUserSpecification: z.boolean().optional(),
    estimatedScope: z.enum(["small", "medium", "large"]).optional(),
  })
  .strip();

export const tasksFileSchema = z
  .object({
    version: z.literal(1).default(1),
    tasks: z.array(taskEntrySchema).default([]),
  })
  .strip();
export type TasksFile = z.infer<typeof tasksFileSchema>;

/** Tolerant parse of a tasks.json payload. Null on any failure — never throws (fail-open: a
 *  corrupt plan file reads as "no plan", the caller degrades). */
export function parseTasksFile(raw: unknown): TasksFile | null {
  const result = tasksFileSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// The pcvelz/superpowers NATIVE persistence shape (`<plan>.md.tasks.json`, writing-plans "Task
// Persistence"): numeric ids, `subject` instead of title, `blockedBy` instead of dependsOn, and
// all task metadata embedded as a ```json:metadata``` fence INSIDE the description (their
// workaround for TaskGet not returning the metadata parameter). Tolerated loosely for the same
// reason as above: this file is written by the plugin, resumed across sessions, and hand-edited.
const nativeTaskSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    subject: z.string().default(""),
    status: z.string().default("pending"),
    blockedBy: z.array(z.union([z.number(), z.string()])).default([]),
    description: z.string().default(""),
  })
  .strip();

const nativePlanSchema = z
  .object({
    planPath: z.string().optional(),
    tasks: z.array(nativeTaskSchema).default([]),
  })
  .strip();

const metadataFenceSchema = z
  .object({
    files: z.array(z.string()).default([]),
    verifyCommand: z.string().optional(),
    acceptanceCriteria: z.array(z.string()).default([]),
    modelTier: z.string().optional(),
    userGate: z.boolean().optional(),
    tags: z.array(z.string()).default([]),
    requiresUserSpecification: z.boolean().optional(),
    estimatedScope: z.enum(["small", "medium", "large"]).optional(),
  })
  .strip();

function normalizeStatus(status: string): "pending" | "in_progress" | "completed" {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

/** Extract the `json:metadata` fence from a native task description. A missing or malformed
 *  fence degrades to empty metadata — the task still imports, just without routing hints. */
function fenceMetadata(description: string): z.infer<typeof metadataFenceSchema> {
  const empty = metadataFenceSchema.parse({});
  const match = description.match(/```json:metadata\s*\n([\s\S]*?)```/);
  if (!match) return empty;
  try {
    const parsed = metadataFenceSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : empty;
  } catch {
    return empty;
  }
}

/** Parse a pcvelz/superpowers native plan file into the orchestrator's TasksFile. Null on any
 *  failure — the caller falls back to parseTasksFile (the flat superset shape) or reports. */
export function parseNativePlanFile(raw: unknown): TasksFile | null {
  const result = nativePlanSchema.safeParse(raw);
  if (!result.success || result.data.tasks.length === 0) return null;
  const tasks = result.data.tasks.map((t) => {
    const meta = fenceMetadata(t.description);
    return {
      id: String(t.id),
      title: t.subject,
      description: t.description,
      files: meta.files,
      ...(meta.verifyCommand !== undefined ? { verifyCommand: meta.verifyCommand } : {}),
      acceptanceCriteria: meta.acceptanceCriteria,
      dependsOn: t.blockedBy.map(String),
      status: normalizeStatus(t.status),
      ...(meta.modelTier !== undefined ? { modelTier: meta.modelTier } : {}),
      specRefs: [],
      ...(meta.userGate !== undefined ? { userGate: meta.userGate } : {}),
      tags: meta.tags,
      ...(meta.requiresUserSpecification !== undefined
        ? { requiresUserSpecification: meta.requiresUserSpecification }
        : {}),
      ...(meta.estimatedScope !== undefined ? { estimatedScope: meta.estimatedScope } : {}),
    };
  });
  return { version: 1, tasks };
}

/** Emit tasks.json from an approved spec's taskSeeds. Minimal validation for Phase 1 (the full
 *  validator battery is Phase 2), but the two failures that would wedge the swarm's scheduler —
 *  a dependsOn naming no seed, and a dependency cycle — are rejected here with the offending ids
 *  named, because a broken graph must fail at emit time, not mid-run. verifyCommand is carried
 *  through when present and NEVER invented (authoring absent commands is the decompose stage's
 *  job); acceptanceRefs become specRefs, and the referenced criteria are inlined so a
 *  superpowers-only consumer sees the criterion text without the spec in hand. */
export function emitTasksFile(spec: Spec): { ok: true; file: TasksFile } | { ok: false; error: string } {
  const seedIds = new Set(spec.taskSeeds.map((s) => s.id));

  const unknownDeps: string[] = [];
  for (const seed of spec.taskSeeds) {
    for (const dep of seed.dependsOn) {
      if (!seedIds.has(dep)) unknownDeps.push(`${seed.id} -> ${dep}`);
    }
  }
  if (unknownDeps.length > 0) {
    return { ok: false, error: `dependsOn names unknown task seeds: ${unknownDeps.join(", ")}` };
  }

  // Iterative DFS with a three-color mark: a back edge (revisiting a node on the current path)
  // is a cycle. Iterative because a pathological seed graph must not blow the stack.
  const edges = new Map(spec.taskSeeds.map((s) => [s.id, s.dependsOn] as const));
  const state = new Map<string, "visiting" | "done">();
  for (const root of seedIds) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = edges.get(frame.id) ?? [];
      if (frame.next < deps.length) {
        const dep = deps[frame.next++];
        const mark = state.get(dep);
        if (mark === "visiting") {
          const path = stack.map((f) => f.id).slice(stack.findIndex((f) => f.id === dep));
          return { ok: false, error: `dependsOn cycle: ${[...path, dep].join(" -> ")}` };
        }
        if (mark === undefined) {
          state.set(dep, "visiting");
          stack.push({ id: dep, next: 0 });
        }
      } else {
        state.set(frame.id, "done");
        stack.pop();
      }
    }
  }

  const criterionById = new Map(spec.acceptance.map((a) => [a.id, a.criterion] as const));
  const tasks = spec.taskSeeds.map((seed) => ({
    id: seed.id,
    title: seed.title,
    description: seed.description,
    files: [...seed.files],
    // A ref with no matching acceptance entry stays in specRefs (the audit trail keeps it) but
    // resolves to no criterion text — fail-open, not fail-loud, until Phase 2's validators.
    ...(seed.verifyCommand !== undefined ? { verifyCommand: seed.verifyCommand } : {}),
    acceptanceCriteria: seed.acceptanceRefs.flatMap((ref) => {
      const criterion = criterionById.get(ref);
      return criterion === undefined ? [] : [criterion];
    }),
    dependsOn: [...seed.dependsOn],
    status: "pending" as const,
    ...(seed.modelTier !== undefined ? { modelTier: seed.modelTier } : {}),
    specRefs: [...seed.acceptanceRefs],
    ...(seed.userGate !== undefined ? { userGate: seed.userGate } : {}),
    tags: [...seed.tags],
  }));

  return { ok: true, file: { version: 1, tasks } };
}
