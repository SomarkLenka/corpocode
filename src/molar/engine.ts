// The MOLAR-EDIT engine: the shared machinery the verifier (post-edit) and the design-review team
// (at a breakpoint) both run on. `verify()` fans out one check family per active tenet over changed
// files; `review()` fans out one reviewer per active tenet over a proposed approach. Both honor the
// moment's effort, and both isolate a thrown lens so it never sinks the others (the In-flight
// tenet). Plugin tenet packs extend the same registry the engine reads, never the engine itself.
import { z } from "zod";
import type { CorpoConfig, Effort } from "../config/schema";
import type { Provider } from "../providers/types";
import { applyEffort } from "../providers/effort";
import { resolvePrompt } from "../prompts/resolve";
import { checksForTenets } from "../verifier/tenets";
import { runChecks, type ReadFile } from "../verifier/worker";
import type { MolarEditEngine, Tenet, TenetCheck, TenetFinding } from "./types";

const TENET_LENS: Record<Tenet, string> = {
  M: "Maintainability",
  O: "Observability",
  L: "Logging",
  A: "Atomicity",
  R: "Responsiveness",
  E: "Extensibility",
  D: "Documentation",
  I: "In-flight",
  T: "Testing",
};

const reviewSchema = z.object({
  ok: z.boolean(),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
  message: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export interface MolarEngineOptions {
  provider: Provider;
  config: CorpoConfig;
  readFile?: ReadFile;
  effort?: Effort;
  perCheckTimeoutMs?: number;
  /** Plugin-contributed tenet checks (corpocode-tenet-*); merged into the same registry the engine reads. */
  extraChecks?: TenetCheck[];
}

function neutralReview(tenet: Tenet): TenetFinding {
  return { tenet, ok: true, severity: "info", message: `${TENET_LENS[tenet]} review unavailable`, confidence: 0 };
}

export function createMolarEditEngine(opts: MolarEngineOptions): MolarEditEngine {
  const active = opts.config.molar_edit.active_tenets as Tenet[];
  const timeout = opts.perCheckTimeoutMs ?? 8000;
  const extra = opts.extraChecks ?? [];

  const reviewOne = async (tenet: Tenet, designContext: string): Promise<TenetFinding> => {
    const check = checksForTenets([tenet], extra)[0];
    const rubric = check?.promptId
      ? resolvePrompt(check.promptId)
      : check?.prompt ?? `Evaluate the ${TENET_LENS[tenet]} tenet.`;
    try {
      const out = await opts.provider.chat(
        applyEffort(
          {
            system: resolvePrompt("review", { rubric }),
            responseFormat: "json",
            maxTokens: 300,
            timeoutMs: timeout,
            messages: [{ role: "user", content: designContext.slice(0, 6000) }],
          },
          opts.effort,
        ),
      );
      const parsed = reviewSchema.safeParse(JSON.parse(out.text));
      if (!parsed.success) return neutralReview(tenet);
      return {
        tenet,
        ok: parsed.data.ok,
        severity: parsed.data.severity,
        message: parsed.data.message,
        confidence: parsed.data.confidence,
      };
    } catch {
      return neutralReview(tenet);
    }
  };

  return {
    activeTenets: () => [...active],

    async verify(files: string[]): Promise<TenetFinding[]> {
      return runChecks(checksForTenets(active, extra), {
        files,
        provider: opts.provider,
        perCheckTimeoutMs: timeout,
        ...(opts.readFile ? { readFile: opts.readFile } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
      });
    },

    async review(designContext: string): Promise<TenetFinding[]> {
      // One reviewer per active tenet, in parallel; allSettled so one failing lens never blocks
      // the meeting.
      const settled = await Promise.allSettled(active.map((t) => reviewOne(t, designContext)));
      return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    },
  };
}
