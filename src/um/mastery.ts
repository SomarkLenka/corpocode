// The mastery model — Phase 1 is constantPoll: the treatment never adapts, but every pilot answer
// is journaled from day one so the Phase-5 EMA/hysteresis model lands on real history instead of a
// cold start. The MasteryModel seam (src/um/types.ts) is the contract that must not move when the
// adaptive model swaps in.
//
// The file is GLOBAL (masteryFile under corpocodeHome), deliberately not per-project: mastery is a
// property of the user, not of a repo — the cockpit's question set must not reset in every new project.
//
// Fail-open throughout (the In-flight tenet): a malformed or missing file reads as a fresh shape, and
// every fs failure in observe() is swallowed — recording is best-effort by design and must never block
// or crash the cockpit.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { masteryFile, ensureDir } from "../config/paths";
import type { MasteryModel, MasteryOutcome, MasteryTreatment } from "./types";

export interface MasteryRecord {
  concept: string;
  observations: { at: number; confident: boolean; delegated: boolean }[];
}

export interface MasteryFileShape {
  version: 1;
  concepts: Record<string, MasteryRecord>;
}

export const masteryFileSchema = z.object({
  version: z.literal(1),
  concepts: z.record(
    z.object({
      concept: z.string(),
      observations: z.array(
        z.object({ at: z.number(), confident: z.boolean(), delegated: z.boolean() }),
      ),
    }),
  ),
});

export interface MasteryModelOptions {
  file?: string; // defaults to masteryFile(env) — global, see header comment
  env?: NodeJS.ProcessEnv;
  teach: boolean;
  /** Gates the FUTURE adaptive (Phase-5) behavior only — Phase 1 ignores it for treatment. */
  enabled: boolean;
  now?: () => number;
  // Injected fs seams (ADR 0001) so tests exercise failure paths without touching disk.
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, text: string) => boolean;
}

export function createMasteryModel(opts: MasteryModelOptions): MasteryModel {
  const path = opts.file ?? masteryFile(opts.env);
  const now = opts.now ?? Date.now;
  const read =
    opts.readFile ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const write =
    opts.writeFile ??
    ((p: string, text: string): boolean => {
      try {
        ensureDir(dirname(p));
        writeFileSync(p, text);
        return true;
      } catch {
        return false;
      }
    });

  function load(): MasteryFileShape {
    // Tolerant load: unreadable, unparsable, or shape-drifted files all degrade to a fresh shape.
    // Losing history costs only future adaptivity, never a crash.
    const text = read(path);
    if (text === null) return { version: 1, concepts: {} };
    try {
      return masteryFileSchema.parse(JSON.parse(text));
    } catch {
      return { version: 1, concepts: {} };
    }
  }

  return {
    treatment(): MasteryTreatment {
      // constantPoll: NEVER "assume" in Phase 1, regardless of history and regardless of
      // opts.enabled (enabled gates the Phase-5 adaptive model, not this one). The only dial that
      // matters yet is teach.
      return opts.teach ? "teach-then-poll" : "poll";
    },
    observe(concept: string, outcome: MasteryOutcome): void {
      try {
        const shape = load();
        const record = shape.concepts[concept] ?? { concept, observations: [] };
        record.observations.push({
          at: now(),
          confident: outcome.confident,
          delegated: outcome.delegated,
        });
        shape.concepts[concept] = record;
        write(path, JSON.stringify(shape, null, 2));
      } catch {
        // Best-effort by design — even a throwing injected seam must not reach the cockpit.
      }
    },
  };
}
