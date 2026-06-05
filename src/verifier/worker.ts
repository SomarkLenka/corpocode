// Verifier check runner — the fan-out primitive. Each applicable check runs as its own provider
// call, in parallel; a failed or timed-out check degrades to a neutral finding rather than taking
// the others down (the In-flight tenet). The MOLAR-EDIT engine and the PostToolUse handler both
// build on this. The set of checks is PASSED IN, which is why growing from two to nine tenets was
// purely additive — the registry under tenets/ grew, this runner did not change shape.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Provider } from "../providers/types";
import type { Effort } from "../config/schema";
import { applyEffort } from "../providers/effort";
import { resolvePrompt } from "../prompts/resolve";
import type { TenetCheck, TenetFinding } from "../molar/types";

export type ReadFile = (path: string) => string | null;

const findingSchema = z.object({
  ok: z.boolean(),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
  message: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export interface RunChecksOptions {
  files: string[];
  provider: Provider;
  readFile?: ReadFile;
  perCheckTimeoutMs?: number;
  effort?: Effort;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function neutral(check: TenetCheck): TenetFinding {
  return { tenet: check.tenet, ok: true, severity: "info", message: `${check.name}: check unavailable`, confidence: 0 };
}

async function runOneCheck(
  check: TenetCheck,
  file: string,
  content: string,
  provider: Provider,
  timeoutMs: number,
  effort: Effort | undefined,
): Promise<TenetFinding> {
  try {
    const out = await provider.chat(
      applyEffort(
        {
          system: resolvePrompt("verifier", {
            rubric: check.promptId ? resolvePrompt(check.promptId) : check.prompt ?? "",
          }),
          responseFormat: "json",
          maxTokens: 250,
          timeoutMs,
          messages: [{ role: "user", content: `File: ${file}\n\n${content.slice(0, 6000)}` }],
        },
        effort,
      ),
    );
    const parsed = findingSchema.safeParse(JSON.parse(out.text));
    if (!parsed.success) return neutral(check);
    return {
      tenet: check.tenet,
      ok: parsed.data.ok,
      severity: parsed.data.severity,
      message: parsed.data.message,
      confidence: parsed.data.confidence,
    };
  } catch {
    return neutral(check);
  }
}

/**
 * Run each applicable check against each file, in parallel. Returns one finding per (check, file)
 * pair. allSettled (not all) so that even an unexpected throw in one slot is isolated and the other
 * lenses still report — a single broken check never sinks the whole verification.
 */
export async function runChecks(checks: TenetCheck[], opts: RunChecksOptions): Promise<TenetFinding[]> {
  const readFile = opts.readFile ?? defaultReadFile;
  const timeoutMs = opts.perCheckTimeoutMs ?? 8000;
  const tasks: Promise<TenetFinding>[] = [];
  for (const file of opts.files) {
    const content = readFile(file);
    if (content === null) continue;
    for (const check of checks) {
      if (check.appliesTo({ path: file })) {
        tasks.push(runOneCheck(check, file, content, opts.provider, timeoutMs, opts.effort));
      }
    }
  }
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
}
