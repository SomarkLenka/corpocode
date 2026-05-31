// The git two-branch model's contract. CorpoCode keeps BOTH histories a coding agent's torrent of
// edits creates a dilemma over: an atomic, bisectable trace (the flight recorder) and a curated,
// readable clean branch (the narrative). Declared in the master spec, implemented in this module.
export type GitMode = "suggest" | "auto";
export type PromoteSignal = "verifier_clean" | "unit_boundary" | "tests_passed";

export interface CommitSet {
  files: string[];
  message: string; // structured: what changed, why, what to watch for (the D tenet)
  rationale: string;
}

export interface BranchPair {
  trace: string; // one atomic commit per write
  clean: string; // promoted, squashed sections
}

export interface GitManager {
  ensureBranches(name: string): Promise<BranchPair>;
  commitWrite(file: string, opts: { sessionId: string; mode: GitMode }): Promise<void>;
  planPromotion(repoRoot: string, since: string): Promise<CommitSet[]>;
  promote(sets: CommitSet[], mode: GitMode): Promise<void>;
  conflicts(repoRoot: string): Promise<string[]>;
}
