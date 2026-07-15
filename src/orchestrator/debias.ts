// Position-swap debiasing for pairwise candidate comparison. A judge asked "is the first or the
// second better?" carries positional bias; running BOTH orderings and only trusting an agreement
// cancels it. Pure orchestration — the comparison itself is injected (and, in tests, faked).
//
// selectByVote is the CodeMonkeys test-vote fallback: pick the first candidate that passes its own
// verification, deterministically. No Math.random anywhere — same inputs, same winner, every time.

/** The debiased outcome of one pairwise comparison. `agreed` is false when the two orderings conflict. */
export interface Pairwise {
  pick: "left" | "right" | "tie";
  agreed: boolean;
}

/**
 * Compare two candidates in BOTH orderings and only declare a winner when the orderings agree on it.
 * order 1 is compare(left,right); order 2 is compare(right,left). A candidate wins only if order 1
 * names its slot AND order 2 names its (swapped) slot — otherwise the comparison is biased/inconsistent
 * and we return a non-agreed tie. Two genuine ties agree.
 */
export async function debiasedCompare(opts: {
  compare: (a: string, b: string) => Promise<"first" | "second" | "tie">;
  left: string;
  right: string;
}): Promise<Pairwise> {
  const first = await opts.compare(opts.left, opts.right); // slots: first=left, second=right
  const second = await opts.compare(opts.right, opts.left); // slots: first=right, second=left

  // left wins iff order 1 says its slot (first) AND order 2 says its slot (second)
  if (first === "first" && second === "second") return { pick: "left", agreed: true };
  // right wins iff order 1 says its slot (second) AND order 2 says its slot (first)
  if (first === "second" && second === "first") return { pick: "right", agreed: true };
  // genuine tie only when both orderings tie
  if (first === "tie" && second === "tie") return { pick: "tie", agreed: true };
  // anything else is a conflict (positional bias or a split decision)
  return { pick: "tie", agreed: false };
}

/**
 * Test-vote selection: return the first candidate that passes its predicate, in list order. A
 * deterministic tiebreak (earliest passing candidate wins), undefined when none pass. No randomness.
 */
export function selectByVote<T>(candidates: T[], passed: (c: T) => boolean): T | undefined {
  return candidates.find((c) => passed(c));
}
