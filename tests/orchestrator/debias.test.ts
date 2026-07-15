import { describe, expect, it } from "vitest";
import { debiasedCompare, selectByVote } from "../../src/orchestrator/debias";

describe("debiasedCompare", () => {
  it("agreement on left across both orderings → decisive left", async () => {
    // order 1 (left,right) says "first"=left ; order 2 (right,left) says "second"=left
    const compare = async (a: string, _b: string) => (a === "L" ? "first" : "second") as "first" | "second" | "tie";
    const out = await debiasedCompare({ compare, left: "L", right: "R" });
    expect(out).toEqual({ pick: "left", agreed: true });
  });

  it("agreement on right across both orderings → decisive right", async () => {
    // whichever position "R" is in, it wins
    const compare = async (a: string, _b: string) => (a === "R" ? "first" : "second") as "first" | "second" | "tie";
    const out = await debiasedCompare({ compare, left: "L", right: "R" });
    expect(out).toEqual({ pick: "right", agreed: true });
  });

  it("disagreement (both orderings favor the first slot) → tie, not agreed", async () => {
    // positional bias: always pick whatever is presented first
    const compare = async (_a: string, _b: string) => "first" as "first" | "second" | "tie";
    const out = await debiasedCompare({ compare, left: "L", right: "R" });
    expect(out).toEqual({ pick: "tie", agreed: false });
  });

  it("both orderings say tie → agreed tie", async () => {
    const compare = async () => "tie" as "first" | "second" | "tie";
    const out = await debiasedCompare({ compare, left: "L", right: "R" });
    expect(out).toEqual({ pick: "tie", agreed: true });
  });

  it("one tie, one decisive → tie, not agreed", async () => {
    let n = 0;
    const compare = async () => (n++ === 0 ? "first" : "tie") as "first" | "second" | "tie";
    const out = await debiasedCompare({ compare, left: "L", right: "R" });
    expect(out.agreed).toBe(false);
    expect(out.pick).toBe("tie");
  });
});

describe("selectByVote", () => {
  it("returns the first candidate that passes (deterministic order tiebreak)", () => {
    const winner = selectByVote(["a", "b", "c"], (c) => c === "b" || c === "c");
    expect(winner).toBe("b");
  });

  it("returns undefined when none pass", () => {
    expect(selectByVote(["a", "b"], () => false)).toBeUndefined();
  });

  it("returns undefined on an empty candidate list", () => {
    expect(selectByVote([], () => true)).toBeUndefined();
  });
});
