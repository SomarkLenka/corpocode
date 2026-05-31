// The design-review team. At a categorized breakpoint it weighs in on an APPROACH before the model
// commits to it — one reviewer per active tenet, in parallel (the MOLAR-EDIT engine's review path).
// Catching a design problem here is far cheaper than catching it after a dozen files are written
// against the flawed design. Like everything in this phase it degrades to silence on error: a failed
// reviewer becomes a neutral finding, never a broken turn.
import type { Logger } from "../log/ndjson";
import type { Provider } from "../providers/types";
import type { CorpoConfig, Effort } from "../config/schema";
import { createMolarEditEngine } from "../molar/engine";
import type { TenetFinding } from "../molar/types";
import { summarizeReview } from "./aggregator";

export interface ReviewRequest {
  sessionId: string;
  designContext: string;
}

export interface ReviewDeps {
  provider: Provider;
  config: CorpoConfig;
  logger: Logger;
  effort?: Effort;
}

export interface ReviewResult {
  findings: TenetFinding[];
  feedback: string | null; // formatted concerns to inject, or null when every lens is clean
}

export async function runDesignReview(req: ReviewRequest, deps: ReviewDeps): Promise<ReviewResult> {
  const engine = createMolarEditEngine({
    provider: deps.provider,
    config: deps.config,
    ...(deps.effort ? { effort: deps.effort } : {}),
  });

  const findings = await engine.review(req.designContext);

  for (const f of findings) {
    deps.logger.log({
      event: "review_check",
      session_id: req.sessionId,
      component: "review",
      tenet: f.tenet,
      verdict: f.ok ? "ok" : "concern",
      severity: f.severity,
      confidence: f.confidence,
    });
  }

  const concerns = findings.filter((f) => !f.ok);
  deps.logger.log({
    event: "review",
    session_id: req.sessionId,
    component: "review",
    tenets: findings.length,
    concerns: concerns.length,
  });

  return { findings, feedback: concerns.length ? summarizeReview(concerns) : null };
}
