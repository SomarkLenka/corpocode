// Three-point ablation → $/task Pareto frontier. Pure. Given a set of run reports (typically
// floor / swarm / ceiling), compute for each the resolved fraction and cost-per-resolved, then the
// Pareto frontier that MAXIMIZES resolvedFraction while MINIMIZING costPerResolvedUsd. A run that
// resolves nothing has null cost-per-resolved, treated as +Infinity (worst). Deterministic — no
// clock, no randomness; ties broken by explicit ordering rules.

export interface ReportLike {
  label: string;
  tasksTotal: number;
  completed: number;
  totalCostUsd: number;
  costPerCompletedTaskUsd: number | null;
}

export interface AblationPoint {
  label: string;
  resolvedFraction: number;
  costPerResolvedUsd: number | null;
  totalCostUsd: number;
  tasksTotal: number;
  completed: number;
  onFrontier: boolean;
}

export interface AblationResult {
  points: AblationPoint[];
  frontier: string[];
  best: string | null;
}

/** null cost-per-resolved (nothing completed) sorts as the worst possible cost. */
function effectiveCost(costPerResolvedUsd: number | null): number {
  return costPerResolvedUsd ?? Number.POSITIVE_INFINITY;
}

export function computeAblation(reports: ReportLike[]): AblationResult {
  const points: AblationPoint[] = reports.map((r) => ({
    label: r.label,
    resolvedFraction: r.tasksTotal > 0 ? r.completed / r.tasksTotal : 0,
    costPerResolvedUsd: r.costPerCompletedTaskUsd,
    totalCostUsd: r.totalCostUsd,
    tasksTotal: r.tasksTotal,
    completed: r.completed,
    onFrontier: false,
  }));

  // A point is dominated iff another point is at least as good on BOTH axes (resolve >=, cost <=)
  // and strictly better on at least one.
  for (const p of points) {
    const pCost = effectiveCost(p.costPerResolvedUsd);
    const dominated = points.some((q) => {
      if (q === p) return false;
      const qCost = effectiveCost(q.costPerResolvedUsd);
      const betterOrEqual = q.resolvedFraction >= p.resolvedFraction && qCost <= pCost;
      const strictlyBetter = q.resolvedFraction > p.resolvedFraction || qCost < pCost;
      return betterOrEqual && strictlyBetter;
    });
    p.onFrontier = !dominated;
  }

  const frontier = points.filter((p) => p.onFrontier).map((p) => p.label);

  // best = frontier point with highest resolvedFraction, tiebroken by lowest cost (null last).
  let best: AblationPoint | null = null;
  for (const p of points) {
    if (!p.onFrontier) continue;
    if (best === null) {
      best = p;
      continue;
    }
    if (p.resolvedFraction > best.resolvedFraction) {
      best = p;
    } else if (
      p.resolvedFraction === best.resolvedFraction &&
      effectiveCost(p.costPerResolvedUsd) < effectiveCost(best.costPerResolvedUsd)
    ) {
      best = p;
    }
  }

  return { points, frontier, best: best ? best.label : null };
}
