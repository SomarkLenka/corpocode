// Soft polls — the confidence-gated, timed-auto-proceed wrapper around one cockpit poll. Two dials
// meet here, both ahead of the human keystroke:
//   1. a CONFIDENCE gate BEFORE asking: when the mastery model is confident enough about a concept
//      ("assume") and the poll carries a recommendation, the cockpit resolves the default instead of
//      interrupting the pilot — the swarm's economics reward not asking what the human already trusts.
//   2. a TIMER while asking: if the pilot goes quiet, a fork WITH a recommendation auto-proceeds on
//      that default; a contested fork WITHOUT one PAUSES. A contested decision is never coin-flipped
//      while nobody is watching — that invariant is load-bearing and must not soften.
//
// Everything is injected (ask + awaitTimeout as thunks, mastery treatment as a value) so this module
// is pure/deterministic and touches no real timer, model, or clock. The loop wiring is a follow-up.
import type { Answer, Poll } from "../interact/types";
import type { MasteryTreatment } from "./types";

export type SoftAction = "ask" | "auto-confidence" | "auto-timeout" | "pause";

export interface SoftDecision {
  action: SoftAction;
  answer?: Answer;
}

/** Resolve the default option as a `source: "default"` answer — the shared shape both auto paths emit. */
function defaultAnswer(poll: Poll): Answer {
  return { pollId: poll.id, optionId: poll.defaultOptionId, source: "default" };
}

/**
 * The confidence gate, evaluated BEFORE the human is asked. When mastery is confident ("assume") and
 * the poll carries a recommendation, skip the human and resolve that recommendation. Any other
 * treatment — or a confident treatment with nothing to fall back to — still asks.
 */
export function resolveSoftPreAsk(poll: Poll, treatment: MasteryTreatment): SoftDecision {
  if (treatment === "assume" && poll.defaultOptionId !== undefined) {
    return { action: "auto-confidence", answer: defaultAnswer(poll) };
  }
  return { action: "ask" };
}

/**
 * The timer verdict, evaluated when the soft timer fires with no pilot answer. A recommendation makes
 * auto-proceed safe (the deterministic majority-of-axes default); its absence means the fork is
 * genuinely contested, and an unwatched contested fork must PAUSE, never coin-flip.
 */
export function resolveOnTimeout(poll: Poll): SoftDecision {
  if (poll.defaultOptionId !== undefined) {
    return { action: "auto-timeout", answer: defaultAnswer(poll) };
  }
  return { action: "pause" };
}

export interface SoftAskDeps {
  poll: Poll;
  treatment: MasteryTreatment;
  /** Ask the pilot (already wired to the Interactor). Resolves the answer, or null on a dead channel. */
  ask: () => Promise<Answer | null>;
  /** Resolves "timeout" when the soft timer fires. Injected so tests need no real setTimeout. */
  awaitTimeout: () => Promise<"timeout">;
  log?: (fields: Record<string, unknown>) => void;
}

/**
 * Orchestrate one soft poll: confidence gate first (may skip the human entirely), otherwise race the
 * pilot against the soft timer. Whoever resolves first decides — a pilot answer flows through as-is,
 * a timeout defers to resolveOnTimeout. Never uses a real timer: `awaitTimeout` is the injected clock.
 */
export async function softAsk(
  deps: SoftAskDeps,
): Promise<{ answer: Answer | null; via: SoftAction }> {
  const { poll, treatment, ask, awaitTimeout, log } = deps;

  const pre = resolveSoftPreAsk(poll, treatment);
  if (pre.action !== "ask") {
    log?.({ event: "soft_poll", pollId: poll.id, via: pre.action });
    return { answer: pre.answer ?? null, via: pre.action };
  }

  // Race the human against the soft timer. Tag each branch so the winner is unambiguous even if the
  // pilot answers null (a dead channel is still an ask result, distinct from a timeout).
  const asked = ask().then((answer) => ({ kind: "ask" as const, answer }));
  const timed = awaitTimeout().then(() => ({ kind: "timeout" as const }));
  const winner = await Promise.race([asked, timed]);

  if (winner.kind === "ask") {
    log?.({ event: "soft_poll", pollId: poll.id, via: "ask" });
    return { answer: winner.answer, via: "ask" };
  }

  const onTimeout = resolveOnTimeout(poll);
  log?.({ event: "soft_poll", pollId: poll.id, via: onTimeout.action });
  return { answer: onTimeout.answer ?? null, via: onTimeout.action };
}
