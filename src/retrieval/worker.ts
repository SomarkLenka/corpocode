// The retrieval team's dispatcher: plan → fan out → aggregate. Runs when the categorizer set
// `dispatch_retrieval`. Emits one `retrieval_item` log line per checklist item plus one `retrieval`
// summary, and returns a budget-bounded package the router injects as <retrieved-context>. Every
// failure mode (a dead backend, a slow item, a planner outage) degrades the package, never the turn.
//
// The optional coherence pass (config.retrieval.coherence_pass, default off) is a reserved
// post-merge reordering hook; it is intentionally not invoked here until a consumer needs it.
import type { Logger } from "../log/ndjson";
import type { Provider } from "../providers/types";
import type { CorpoConfig, Effort } from "../config/schema";
import type { RetrievalCues } from "../session/types";
import { planChecklist } from "./planner";
import { fanOut } from "./fanout";
import { aggregate } from "./aggregator";
import type { RetrievalBackends, RetrievalPackage } from "./types";
import type { RetrievalTemplate } from "../plugins/types";

export interface RetrievalRequest {
  sessionId: string;
  type: string;
  prompt: string;
  cues: RetrievalCues;
}

export interface RetrievalDeps {
  provider: Provider;
  backends: RetrievalBackends;
  config: CorpoConfig["retrieval"];
  logger: Logger;
  effort?: Effort;
  now?: () => number;
  templates?: RetrievalTemplate[]; // plugin-contributed retrieval templates
}

export async function runRetrieval(req: RetrievalRequest, deps: RetrievalDeps): Promise<RetrievalPackage> {
  const now = deps.now ?? (() => Date.now());
  const started = now();

  const items = await planChecklist(
    { type: req.type, prompt: req.prompt, cues: req.cues, maxItems: deps.config.max_checklist_items },
    {
      provider: deps.provider,
      ...(deps.effort ? { effort: deps.effort } : {}),
      ...(deps.templates ? { templates: deps.templates } : {}),
    },
  );

  const results = await fanOut(items, deps.backends, {
    maxParallel: deps.config.max_parallel_instances,
    perItemTimeoutMs: deps.config.per_item_timeout_ms,
    now: deps.now ?? (() => Date.now()),
  });

  for (const r of results) {
    deps.logger.log({
      event: "retrieval_item",
      session_id: req.sessionId,
      component: "retrieval",
      kind: r.kind,
      label: r.label,
      ok: r.ok,
      timed_out: r.timedOut,
      refs: r.refs.length,
      latency_ms: r.latencyMs,
    });
  }

  const pkg = aggregate(results, { budgetTokens: deps.config.package_token_budget });

  deps.logger.log({
    event: "retrieval",
    session_id: req.sessionId,
    component: "retrieval",
    checklist_items: items.length,
    items_succeeded: pkg.itemsSucceeded,
    refs: pkg.refs.length,
    tokens: pkg.tokensEstimate,
    latency_ms: now() - started,
  });

  return pkg;
}
