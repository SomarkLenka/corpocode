// Maps a classified difficulty to a concrete model + effort by reading config.effort. In Phase 1
// this choice is emitted on the categorizer's output and logged; the parts that ACT on it (spawning
// a subagent with the chosen model) arrive in Phase 3.
import type { ComponentName, CorpoConfig, Difficulty, Effort } from "../config/schema";

export interface ModelEffortChoice {
  difficulty: Difficulty;
  providerComponent?: ComponentName;
  model?: string;
  effort: Effort;
}

const COMPONENT_NAMES: readonly string[] = ["router", "retrieval", "compactor", "filter", "verifier"];

export function selectModelEffort(difficulty: Difficulty, config: CorpoConfig): ModelEffortChoice {
  const entry = config.effort.difficulty_to_model[difficulty];
  if (!entry) return { difficulty, effort: "medium" };
  return {
    difficulty,
    effort: entry.effort,
    ...(entry.component && COMPONENT_NAMES.includes(entry.component)
      ? { providerComponent: entry.component as ComponentName }
      : {}),
    ...(entry.model ? { model: entry.model } : {}),
  };
}
