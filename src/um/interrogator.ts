// The cockpit's PURE spec state machine — zero IO, zero model calls. The loop (loop.ts) owns every
// side effect; this module only folds interrogator moves into an immutable SpecState. Every function
// returns a NEW state so the loop can checkpoint after each step and a pause never loses work.
import { z } from "zod";
import { SPEC_SECTIONS, type SpecSectionId } from "./types";
import type { DecisionRecord } from "./types";
import { acceptanceSchema, specSchema, taskSeedSchema, type Spec } from "./spec-schema";

export interface SpecState {
  spec: Spec;
  /** Decisions recorded so far — the interrogation-fatigue counter max_polls is checked against. */
  polls: number;
}

/** The additive Spec fragment a "content" move may carry. Reuses spec-schema's sub-schemas (defaults
 *  stripped — absent means "nothing to add", not "reset to empty") because the loop validates raw LLM
 *  payloads with it; unknown keys are stripped rather than rejected so a chatty model degrades softly. */
export const sectionPayloadSchema = z.object({
  entities: specSchema.shape.entities.removeDefault().optional(),
  contracts: specSchema.shape.contracts.removeDefault().optional(),
  constraints: z.array(z.string()).optional(),
  futureSeams: z.array(z.string()).optional(),
  compartments: specSchema.shape.compartments.removeDefault().optional(),
  scalePath: z.array(z.string()).optional(),
  reusableSystems: specSchema.shape.reusableSystems.removeDefault().optional(),
  acceptance: z.array(acceptanceSchema).optional(),
  taskSeeds: z.array(taskSeedSchema).optional(),
});
export type SectionPayload = z.infer<typeof sectionPayloadSchema>;

export function initialState(runId: string, task: string): SpecState {
  const sections = Object.fromEntries(SPEC_SECTIONS.map((s) => [s, "open" as const]));
  // Parse through the schema so every defaulted array exists — downstream merges never null-check.
  return { spec: specSchema.parse({ runId, task, sections }), polls: 0 };
}

/** A decided section leaves "open" but stays "complete" if already sealed — a late decision (mid-run
 *  escalation appends to the same ledger) must not reopen a green lamp. */
function bumpStatus(spec: Spec, section: SpecSectionId, complete: boolean): Spec["sections"] {
  const current = spec.sections[section];
  const next = complete ? "complete" : current === "complete" ? "complete" : "in-progress";
  return { ...spec.sections, [section]: next };
}

export function recordDecision(state: SpecState, record: DecisionRecord): SpecState {
  return {
    spec: {
      ...state.spec,
      decisions: [...state.spec.decisions, record],
      sections: bumpStatus(state.spec, record.section, false),
    },
    polls: state.polls + 1,
  };
}

/** Merge keyed items additively; a re-emitted key REPLACES the earlier item in place (the interrogator
 *  refines as the conversation deepens — the sharpened version wins, order is preserved). */
function mergeKeyed<T>(existing: readonly T[], incoming: readonly T[] | undefined, key: (item: T) => string): T[] {
  const out = [...existing];
  if (!incoming) return out;
  const index = new Map(out.map((item, i) => [key(item), i] as const));
  for (const item of incoming) {
    const at = index.get(key(item));
    if (at === undefined) {
      index.set(key(item), out.length);
      out.push(item);
    } else {
      out[at] = item;
    }
  }
  return out;
}

export function recordContent(
  state: SpecState,
  section: SpecSectionId,
  payload: SectionPayload,
  complete: boolean,
): SpecState {
  const spec = state.spec;
  return {
    spec: {
      ...spec,
      entities: mergeKeyed(spec.entities, payload.entities, (e) => e.name),
      contracts: mergeKeyed(spec.contracts, payload.contracts, (c) => c.name),
      constraints: mergeKeyed(spec.constraints, payload.constraints, (s) => s),
      futureSeams: mergeKeyed(spec.futureSeams, payload.futureSeams, (s) => s),
      compartments: mergeKeyed(spec.compartments, payload.compartments, (c) => c.name),
      scalePath: mergeKeyed(spec.scalePath, payload.scalePath, (s) => s),
      reusableSystems: mergeKeyed(spec.reusableSystems, payload.reusableSystems, (r) => r.name),
      acceptance: mergeKeyed(spec.acceptance, payload.acceptance, (a) => a.id),
      taskSeeds: mergeKeyed(spec.taskSeeds, payload.taskSeeds, (t) => t.id),
      sections: bumpStatus(spec, section, complete),
    },
    polls: state.polls,
  };
}

/** First non-complete section in charter order — the loop feeds it back as "what remains". */
export function nextOpenSection(state: SpecState): SpecSectionId | null {
  for (const section of SPEC_SECTIONS) {
    if (state.spec.sections[section] !== "complete") return section;
  }
  return null;
}

export function isComplete(state: SpecState): boolean {
  return nextOpenSection(state) === null;
}
