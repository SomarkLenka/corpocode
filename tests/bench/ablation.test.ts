import { describe, expect, it } from "vitest";
import { computeAblation, type ReportLike } from "../../src/bench/ablation";

function report(
  label: string,
  tasksTotal: number,
  completed: number,
  totalCostUsd: number,
): ReportLike {
  return {
    label,
    tasksTotal,
    completed,
    totalCostUsd,
    costPerCompletedTaskUsd: completed > 0 ? totalCostUsd / completed : null,
  };
}

describe("computeAblation", () => {
  it("puts the dominating swarm point on the frontier and names it best", () => {
    // swarm resolves more than floor AND is cheaper per resolved than ceiling → dominates ceiling,
    // beats floor on resolve. Frontier should contain swarm (+floor, which is cheapest); ceiling off.
    const floor = report("floor", 10, 2, 2.0); // resolved 0.2, $1.00/resolved
    const swarm = report("swarm", 10, 8, 8.0); // resolved 0.8, $1.00/resolved
    const ceiling = report("ceiling", 10, 8, 40.0); // resolved 0.8, $5.00/resolved (dominated by swarm)
    const res = computeAblation([floor, swarm, ceiling]);

    const byLabel = Object.fromEntries(res.points.map((p) => [p.label, p]));
    expect(byLabel["ceiling"]!.onFrontier).toBe(false);
    expect(byLabel["swarm"]!.onFrontier).toBe(true);
    expect(res.frontier).not.toContain("ceiling");
    expect(res.frontier).toContain("swarm");
    // best = highest resolvedFraction on frontier (swarm at 0.8 beats floor at 0.2)
    expect(res.best).toBe("swarm");
    expect(byLabel["swarm"]!.resolvedFraction).toBeCloseTo(0.8, 10);
    expect(byLabel["swarm"]!.costPerResolvedUsd).toBeCloseTo(1.0, 10);
  });

  it("excludes a strictly-dominated point from the frontier", () => {
    const good = report("good", 10, 6, 6.0); // 0.6 resolved, $1/resolved
    const bad = report("bad", 10, 4, 8.0); // 0.4 resolved, $2/resolved — dominated by good
    const res = computeAblation([good, bad]);
    expect(res.frontier).toEqual(["good"]);
    expect(res.points.find((p) => p.label === "bad")!.onFrontier).toBe(false);
  });

  it("treats a run with zero completed as null cost, ranked worst", () => {
    const empty = report("empty", 5, 0, 3.0); // nothing resolved → costPerResolved null → +Inf
    const winner = report("winner", 5, 5, 5.0); // resolves everything
    const res = computeAblation([empty, winner]);
    const byLabel = Object.fromEntries(res.points.map((p) => [p.label, p]));
    expect(byLabel["empty"]!.costPerResolvedUsd).toBeNull();
    expect(byLabel["empty"]!.resolvedFraction).toBe(0);
    expect(byLabel["empty"]!.onFrontier).toBe(false);
    expect(res.best).toBe("winner");
  });

  it("keeps both endpoints of a classic Pareto tradeoff on the frontier", () => {
    // ceiling: highest resolve, priciest. floor: cheapest, lowest resolve. Neither dominates the
    // other → both on frontier. swarm dominates neither endpoint here but sits between; if it
    // strictly dominates one it appears too. Use a swarm that dominates floor (more resolve, same $).
    const floor = report("floor", 10, 3, 3.0); // 0.3, $1/resolved
    const ceiling = report("ceiling", 10, 9, 45.0); // 0.9, $5/resolved
    const swarm = report("swarm", 10, 6, 6.0); // 0.6, $1/resolved — dominates floor (more resolve, same cost)
    const res = computeAblation([floor, ceiling, swarm]);
    // floor dominated by swarm (>=resolve? no: swarm 0.6>0.3 resolve, cost equal 1.0) → floor off.
    expect(res.frontier).toContain("ceiling"); // priciest but highest resolve → not dominated
    expect(res.frontier).toContain("swarm");
    expect(res.frontier).not.toContain("floor");
    // best = highest resolvedFraction on frontier → ceiling (0.9)
    expect(res.best).toBe("ceiling");
  });

  it("keeps two mutually-non-dominating endpoints both on the frontier", () => {
    const cheap = report("cheap", 10, 2, 1.0); // 0.2 resolve, $0.5/resolved
    const rich = report("rich", 10, 9, 18.0); // 0.9 resolve, $2/resolved
    const res = computeAblation([cheap, rich]);
    // cheap has lower cost/resolved but lower resolve; rich has higher resolve but higher cost →
    // neither dominates → both on frontier.
    expect(res.frontier.sort()).toEqual(["cheap", "rich"]);
    // best = highest resolve → rich
    expect(res.best).toBe("rich");
  });

  it("returns an empty result for no reports", () => {
    const res = computeAblation([]);
    expect(res.points).toEqual([]);
    expect(res.frontier).toEqual([]);
    expect(res.best).toBeNull();
  });
});
