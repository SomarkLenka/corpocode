// bug-hunt — the first action-pattern, and the proof that the whole IntelligentRouter infra composes
// end-to-end (the path Phases 3 + 5 follow). The shape: on a UserPromptSubmit, gather deterministic
// candidate files (graph-scored) + recalled mistakes/rules, then fan out ONE read-only `file-relevance`
// agent per candidate — each reads its single file, decides whether it is implicated in the problem the
// developer is chasing, and cites exact line spans. The judge keeps only confident, implicated findings;
// synthesize folds them into one cited-lines block so the main model can skip opening those files.
//
// It implements the four-piece action-pattern contract: (1) a pure plan producer, (2) an editable prompt
// id (`bug-hunt`, in prompts/registry.ts), (3) a synthesizer, (4) a thin gated handler adapter. Every
// boundary is fail-open (In-flight): a dead backend, an empty gather, or a thrown step degrades to "" —
// the host turn is never broken, and with `agents.enabled` off the handler path is not even reached.
import type { AgentBackend, AgentCall, AgentTaskKind, JsonSchema } from "../../agents/backend";
import type { KnowledgeGraph } from "../../backends/graph/types";
import type { MemoryStore } from "../../backends/memory/types";
import type { Logger } from "../../log/ndjson";
import type { PromptResolver } from "../../prompts/resolve";
import { TAGS, tagged } from "../../hooks/response";
import { gather } from "../gather";
import { run } from "../engine";
import { route } from "../router-router";
import type { AgentTaskResult, Intent, Judge, OrchestrationPlan, OrchestrationResult } from "../types";

/** The structured verdict ONE file-relevance agent returns about its single candidate file. */
export interface BugHuntFinding {
  implicated: boolean;
  confidence: number; // 0..1
  lines?: { start: number; end: number; why?: string }[];
}

/** Forced-output schema for each file-relevance task — strict, so the agent must cite or disclaim. */
export const BUG_HUNT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["implicated", "confidence"],
  properties: {
    implicated: { type: "boolean", description: "true ONLY if specific lines in this file are implicated" },
    confidence: { type: "number", description: "0..1 confidence that this file is implicated" },
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["start", "end"],
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          why: { type: "string", description: "why this span is implicated" },
        },
      },
    },
  },
};

/** The deferred concretions this pattern fixes in the plan it emits — each with a conservative default. */
export interface BugHuntConfig {
  fanoutWidth: number; // local parallelism vs the 45s hook budget
  confidenceFloor: number; // drop findings below this confidence
  maxFiles: number; // injected-token cap proxy: how many top candidates to investigate
}

export const DEFAULT_BUG_HUNT_CONFIG: BugHuntConfig = { fanoutWidth: 3, confidenceFloor: 0.5, maxFiles: 6 };

const TASK_KIND: AgentTaskKind = "file-relevance";

/** A finding survives only if its agent returned ok, marked the file implicated, and cleared the floor. */
function bugHuntJudge(floor: number): Judge {
  return (results) =>
    results.filter((r) => {
      if (!r.result.ok) return false;
      const finding = r.result.data as BugHuntFinding | undefined;
      return Boolean(finding?.implicated) && (finding?.confidence ?? 0) >= floor;
    });
}

/**
 * (1) Plan producer — pure, no I/O. One `file-relevance` task per top-N candidate file: read-only,
 * minimal-effort, ephemeral, structured. The file path rides in inputs.files and the problem statement in
 * inputs.reasoning, keeping the resolved `task` prompt byte-identical across files (a stable cacheable
 * prefix the later cacheGuard exploits). The judge — the confidence/fit filter — is part of the plan.
 */
export function planBugHunt(
  intent: Intent,
  candidates: { files: { path: string }[]; memories: { text: string }[] },
  cfg: BugHuntConfig,
  taskPrompt: string,
): OrchestrationPlan {
  const problem = intent.kind === "prompt" ? intent.prompt : "";
  const priorMistakes = candidates.memories.map((m) => m.text).filter(Boolean).join("; ");
  const tasks = candidates.files.slice(0, cfg.maxFiles).map((file) => ({
    id: file.path,
    call: {
      component: "router",
      taskKind: TASK_KIND,
      task: taskPrompt,
      inputs: {
        files: [file.path],
        reasoning: problem,
        ...(priorMistakes ? { decisions: priorMistakes } : {}),
      },
      tools: "read-only",
      effort: "minimal",
      schema: BUG_HUNT_SCHEMA,
      session: "ephemeral",
    } as AgentCall,
  }));
  return { tasks, fanoutWidth: cfg.fanoutWidth, judge: bugHuntJudge(cfg.confidenceFloor) };
}

/** Render one surviving finding: its file id, confidence, and each cited span. Structure/meaning only. */
function renderFinding(task: AgentTaskResult): string {
  const finding = task.result.data as BugHuntFinding | undefined;
  const conf = (finding?.confidence ?? 0).toFixed(2);
  const spans = (finding?.lines ?? []).map(
    (l) => `  - lines ${l.start}-${l.end}${l.why ? `: ${l.why}` : ""}`,
  );
  return [`## ${task.id} (confidence ${conf})`, ...spans].join("\n");
}

/**
 * (3) Synthesizer — fold surviving findings into ONE tagged cited-lines block under the IntelligentRouter
 * tag. No-op ("") when nothing survived, so the handler injects nothing and the turn stays unchanged.
 * Never HTML/markup beyond the plain structural text the rendering surface decides how to display.
 */
export function synthesizeBugHunt(result: OrchestrationResult): string {
  if (result.tasks.length === 0) return "";
  const header =
    "Files likely implicated in this problem, with cited line spans (CorpoCode pre-read these — you can " +
    "skip opening them and go straight to the cited lines):";
  const body = [header, ...result.tasks.map(renderFinding)].join("\n\n");
  return tagged(TAGS.intelligentRouter, body);
}

/** Everything the pattern needs, injected so it unit-tests against fakes (no HookContext in the seam). */
export interface BugHuntDeps {
  forTask: (kind: AgentTaskKind) => AgentBackend;
  graph: KnowledgeGraph;
  memory: MemoryStore;
  project: string;
  prompts: PromptResolver;
  logger?: Logger;
  routerRouter?: boolean; // the triage gate; false ⇒ always run (default mirrors config.agents.router_router)
  cfg?: Partial<BugHuntConfig>;
  now?: () => number;
}

/**
 * (4) The orchestration: router.route → gather → plan → engine.run → synthesize. Returns the synthesized
 * block, or "" when the moment is triaged dumb, nothing is gathered, or anything fails. NEVER throws.
 */
export async function runBugHunt(intent: Intent, deps: BugHuntDeps): Promise<string> {
  const cfg: BugHuntConfig = { ...DEFAULT_BUG_HUNT_CONFIG, ...deps.cfg };
  try {
    const decision = await route(intent, { forTask: deps.forTask, enabled: deps.routerRouter });
    if (decision.route === "dumb") {
      deps.logger?.log({ event: "bug_hunt", phase: "route", route: "dumb", reason: decision.reason });
      return "";
    }

    const candidates = await gather(intent, {
      graph: deps.graph,
      memory: deps.memory,
      project: deps.project,
      logger: deps.logger,
    });
    if (candidates.files.length === 0) {
      deps.logger?.log({ event: "bug_hunt", phase: "gather", files: 0 });
      return "";
    }

    const taskPrompt = deps.prompts.resolve("bug-hunt");
    const plan = planBugHunt(intent, candidates, cfg, taskPrompt);
    deps.logger?.log({ event: "bug_hunt", phase: "plan", candidates: candidates.files.length, tasks: plan.tasks.length });

    const result = await run(plan, {
      forTask: deps.forTask,
      now: deps.now,
      // The engine always stamps `event` on its lines; cast bridges its structural type to LogFields.
      log: (line) => deps.logger?.log(line as Parameters<Logger["log"]>[0]),
    });
    deps.logger?.log({ event: "bug_hunt", phase: "synthesize", surviving: result.tasks.length, cost_usd: result.usage.costUsd });
    return synthesizeBugHunt(result);
  } catch (err) {
    // Fail-open: a pattern that errors must still leave the turn untouched (the In-flight tenet).
    deps.logger?.log({ event: "bug_hunt", phase: "error", reason: err instanceof Error ? err.message : String(err) });
    return "";
  }
}
