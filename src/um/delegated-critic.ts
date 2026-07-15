// The delegated critic — a Planning-Critic-on-a-timer for forks the pilot handed off ("you decide")
// or that auto-timed-out to a delegate. One CHEAP read-only agent judges the fork's trade-offs and
// names the best option; it authors NOTHING (no code, no tests — just an optionId and a rationale).
//
// Fail-open, load-bearing: a dead critic, an invalid recommendation, or a missing optionId all degrade
// to the deterministic default (the poll-synth majority-of-axes winner). The critic never throws and
// never blocks — a delegated fork always resolves, worst case to the same default the loop already
// computed. Everything injected (backend); ADR-0001: no real model in tests.
import type { AgentBackend, JsonSchema, ModelRef } from "../agents/backend";
import type { Answer } from "../interact/types";
import type { DecisionFork } from "./types";

/** What the critic returns: which option, and why. optionId is validated against the fork after. */
export interface DelegatedRecommendationPayload {
  optionId: string;
  rationale: string;
}

export const RECO_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    optionId: { type: "string", description: "the id of the best option for this fork" },
    rationale: { type: "string", description: "one or two sentences: why this option wins the trade-off" },
  },
  required: ["optionId", "rationale"],
  additionalProperties: false,
};

export interface DelegatedCriticOptions {
  backend: AgentBackend;
  fork: DecisionFork;
  /** The deterministic default (poll-synth's recommendation) the critic degrades to. */
  defaultOptionId?: string;
  model?: ModelRef;
  log?: (fields: Record<string, unknown>) => void;
}

export interface DelegatedRecommendation {
  answer: Answer;
  via: "critic" | "fallback";
  rationale?: string;
}

/** The deterministic degrade path — the default the loop already computed, journaled as delegated. */
function fallback(fork: DecisionFork, defaultOptionId: string | undefined): DelegatedRecommendation {
  const answer: Answer =
    defaultOptionId !== undefined
      ? { pollId: fork.id, optionId: defaultOptionId, source: "delegated" }
      : { pollId: fork.id, source: "delegated" };
  return { answer, via: "fallback" };
}

/**
 * Ask a cheap critic to pick the best option for a delegated fork. On a valid recommendation the
 * choice flows through (source "delegated"); on anything else — dead backend, missing/invalid
 * optionId — it degrades to the deterministic default. Never throws.
 */
export async function recommendDelegated(
  opts: DelegatedCriticOptions,
): Promise<DelegatedRecommendation> {
  const { backend, fork, defaultOptionId, model, log } = opts;

  const res = await backend.invoke<DelegatedRecommendationPayload>({
    component: "um",
    taskKind: "consequence",
    task:
      "You are the delegated critic for a spec fork the pilot handed off. Judge the trade-offs " +
      "across the options and pick the single best option id. Author nothing else. Return the " +
      "chosen optionId (one of the fork's option ids) and a one- or two-sentence rationale.",
    inputs: { reasoning: JSON.stringify(fork) },
    effort: "minimal",
    schema: RECO_SCHEMA,
    tools: "none",
    session: "ephemeral",
    ...(model ? { model } : {}),
  });

  const chosen = res.ok ? res.data?.optionId : undefined;
  const valid = chosen !== undefined && fork.options.some((o) => o.id === chosen);

  if (valid) {
    log?.({ event: "delegated_critic", forkId: fork.id, via: "critic", optionId: chosen });
    return {
      answer: { pollId: fork.id, optionId: chosen, source: "delegated" },
      via: "critic",
      rationale: res.data?.rationale,
    };
  }

  log?.({ event: "delegated_critic", forkId: fork.id, via: "fallback", defaultOptionId });
  return fallback(fork, defaultOptionId);
}
