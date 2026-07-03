// Helpers shared by the action-patterns — hoisted from bug-hunt (A1) when pre-write (A2) became the
// second consumer. Pure and I/O-free; behavior is pinned by the existing bug-hunt tests.
import type { OrchestrationResult } from "../types";

/** Rough token estimate (length/4) — the same one-liner used in retrieval/aggregator and the OV adapter. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

export const EMPTY_RESULT: OrchestrationResult = {
  ok: false,
  tasks: [],
  usage: { costUsd: 0, latencyMs: 0, calls: 0, succeeded: 0 },
};

/** Race a run against a hard deadline. engine.run cannot be aborted (patterns must not modify it), so on
 *  deadline we resolve to an empty result — nothing is injected and the run finishes in the background.
 *  Never rejects; a backend error already resolves to a failed task inside run(). */
export function raceDeadline(
  runP: Promise<OrchestrationResult>,
  ms: number,
): Promise<{ result: OrchestrationResult; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ result: EMPTY_RESULT, timedOut: true }), ms);
    runP.then(
      (result) => {
        clearTimeout(timer);
        resolve({ result, timedOut: false });
      },
      () => {
        clearTimeout(timer);
        resolve({ result: EMPTY_RESULT, timedOut: false });
      },
    );
  });
}
