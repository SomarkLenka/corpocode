// RouterRouter — the cheapest possible triage gate on top of the IntelligentRouter. Before CorpoCode
// spends the full orchestration workspace on a moment, this decides whether the moment even deserves it:
//
//   DUMB  → absurdly simple, directly handleable by the caller (a greeting, a one-file read, a commit).
//           CorpoCode steps back; the host keeps full control. The cheapest path.
//   SMART → anything with real discovery to do. An action-pattern runs.
//
// It is a thin, REMOVABLE layer: with `enabled:false` everything routes SMART, so the concept can be
// nixed without touching the router. Two checks, cheapest first: (1) a free deterministic trivial test
// (reused from the categorizer), then (2) ONE minimal-effort, tool-less triage call through the agnostic
// AgentBackend seam. The bias is STRICT toward SMART — we only dumb-route on a confident `true`; any
// error, malformed reply, or uncertainty falls open to SMART, so context is never withheld on doubt.
import { isTrivialPrompt } from "../router/heuristics";
import type { AgentBackend, AgentTaskKind, JsonSchema } from "../agents/backend";
import type { Intent } from "./types";

export type RouteDecision =
  | { route: "dumb"; reason: string; directAction?: string }
  | { route: "smart"; reason: string };

export interface RouterRouterDeps {
  forTask: (kind: AgentTaskKind) => AgentBackend; // resolve the triage backend (from ctx.agents)
  enabled?: boolean; // default true; false ⇒ always SMART (the gate is nixed)
  isTrivial?: (prompt: string) => boolean; // injectable for tests; defaults to the categorizer's check
}

/** What the triage agent must return — kept tiny so the call is as cheap as a single token of judgement. */
interface TriageVerdict {
  dumb: boolean;
  reason: string;
  directAction?: string;
}

const TRIAGE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["dumb", "reason"],
  properties: {
    dumb: { type: "boolean", description: "true ONLY if absurdly simple: handleable directly with no codebase discovery" },
    reason: { type: "string" },
    directAction: { type: "string", description: "if dumb, the single direct action (e.g. 'git commit', 'read one file')" },
  },
};

const TRIAGE_TASK =
  "Decide if this coding-assistant moment is absurdly simple — directly handleable by a single agent " +
  "with NO codebase discovery (e.g. a greeting, a trivial Q&A, one file read, a git add/commit). " +
  "Default to dumb=false. Only dumb=true when you are confident no investigation is needed.";

/** The short description of the moment handed to the triage agent — structure only, no transcript dump. */
function describe(intent: Intent): string {
  switch (intent.kind) {
    case "prompt":
      return `User prompt: ${intent.prompt}`;
    case "pre-write":
      return `About to write file: ${intent.file}`;
    case "pre-read":
      return `About to read file: ${intent.file}`;
    case "post-write":
      return `Just wrote file: ${intent.file}`;
  }
}

/**
 * Route a moment to DUMB (caller keeps control) or SMART (run the IntelligentRouter). Never throws.
 * STRICT: dumb only on a confident agent `true`; deterministic-trivial prompts short-circuit to dumb
 * for free; everything uncertain → smart.
 */
export async function route(intent: Intent, deps: RouterRouterDeps): Promise<RouteDecision> {
  if (deps.enabled === false) return { route: "smart", reason: "router-router disabled" };

  // (1) Free deterministic check — trivial prompts never deserve the workspace.
  const trivial = deps.isTrivial ?? isTrivialPrompt;
  if (intent.kind === "prompt" && trivial(intent.prompt)) {
    return { route: "dumb", reason: "deterministically trivial prompt" };
  }

  // (2) One minimal, tool-less triage call. Any failure or doubt → SMART (never withhold context).
  let backend: AgentBackend;
  try {
    backend = deps.forTask("triage");
  } catch {
    return { route: "smart", reason: "no triage backend — defaulting to full router" };
  }

  const res = await backend.invoke<TriageVerdict>({
    component: "router",
    taskKind: "triage",
    task: TRIAGE_TASK,
    inputs: { reasoning: describe(intent) },
    tools: "none",
    effort: "minimal",
    schema: TRIAGE_SCHEMA,
    session: "ephemeral",
  });

  if (!res.ok || !res.data) return { route: "smart", reason: res.error?.message ?? "triage inconclusive" };
  if (res.data.dumb === true) {
    return { route: "dumb", reason: res.data.reason || "triaged simple", directAction: res.data.directAction };
  }
  return { route: "smart", reason: res.data.reason || "triaged non-trivial" };
}
