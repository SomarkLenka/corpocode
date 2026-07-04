// Where each prompt lives on disk and what it does — the single source for the prompts/ folder layout,
// each file's self-documenting header, and the generated README. Internal ids stay flat (call sites are
// unchanged); only the on-disk FILE is foldered by component, so a user browsing ~/.corpocode/prompts/
// sees at a glance which CorpoCode component a prompt drives and what editing it changes.
import { allPromptIds, type PromptId } from "./registry";

export interface PromptMeta {
  path: string; // relative file path under prompts/, foldered by component
  source: string; // the code that uses it
  effect: string; // one line: what changing this prompt changes
}

export const PROMPT_META: Record<PromptId, PromptMeta> = {
  router: { path: "router/rank.md", source: "src/router/ranker.ts", effect: "how your prompt's moment is classified and which files preload" },
  retrieval: { path: "retrieval/plan.md", source: "src/retrieval/planner.ts", effect: "what the retrieval team gathers when no template matches" },
  compactor: { path: "compactor/digest.md", source: "src/compactor/worker.ts", effect: "how an older transcript slice is summarized at Stop" },
  skillgen: { path: "skillgen/distill.md", source: "src/loops/skillgen.ts", effect: "how mined memories become skill candidates" },
  "filter-classify": { path: "filter/classify.md", source: "src/filter/classify.ts", effect: "how an uncertain shell command is judged deny/allow/ask" },
  "filter-inject": { path: "filter/inject.md", source: "src/filter/inject.ts", effect: "how a file read is narrowed to the relevant slice" },
  "session-reader": { path: "session/reader.md", source: "src/session/reader.ts", effect: "how the line-of-thought is distilled from the transcript" },
  toolbox: { path: "toolbox/classify.md", source: "src/toolbox/classifier.ts", effect: "which gated skills/agents are surfaced as relevant" },
  "docs-facet": { path: "docs/facet.md", source: "src/docs/generator.ts", effect: "each what-code-does facet (impacts, risks, input, …)" },
  "docs-inline": { path: "docs/inline.md", source: "src/docs/generator.ts", effect: "the inline doc-comment writer" },
  verifier: { path: "verifier/wrapper.md", source: "src/verifier/worker.ts", effect: "the JSON framing around every post-edit tenet check" },
  review: { path: "review/wrapper.md", source: "src/molar/engine.ts", effect: "the JSON framing around every design-review tenet check" },
  "verifier-maintainability": { path: "verifier/tenets/maintainability.md", source: "src/verifier/tenets/maintainability.ts", effect: "the Maintainability (M) standard the verifier enforces" },
  "verifier-observability": { path: "verifier/tenets/observability.md", source: "src/verifier/tenets/observability.ts", effect: "the Observability (O) standard the verifier enforces" },
  "verifier-logging": { path: "verifier/tenets/logging.md", source: "src/verifier/tenets/logging.ts", effect: "the Logging (L) standard the verifier enforces" },
  "verifier-atomicity": { path: "verifier/tenets/atomicity.md", source: "src/verifier/tenets/atomicity.ts", effect: "the Atomicity (A) standard the verifier enforces" },
  "verifier-responsiveness": { path: "verifier/tenets/responsiveness.md", source: "src/verifier/tenets/responsiveness.ts", effect: "the Responsiveness (R) standard (UI files only)" },
  "verifier-extensibility": { path: "verifier/tenets/extensibility.md", source: "src/verifier/tenets/extensibility.ts", effect: "the Extensibility (E) standard the verifier enforces" },
  "verifier-documentation": { path: "verifier/tenets/documentation.md", source: "src/verifier/tenets/documentation.ts", effect: "the Documentation (D) standard the verifier enforces" },
  "verifier-in-flight": { path: "verifier/tenets/in-flight.md", source: "src/verifier/tenets/in-flight.ts", effect: "the In-flight (I) standard the verifier enforces" },
  "verifier-testing": { path: "verifier/tenets/testing.md", source: "src/verifier/tenets/testing.ts", effect: "the Testing (T) standard the verifier enforces" },
  "um-interrogate": { path: "um/interrogate.md", source: "src/um/loop.ts", effect: "how the cockpit drives the spec conversation (harvested superpowers v0)" },
  "um-decompose": { path: "um/decompose.md", source: "src/orchestrator/decompose.ts (Phase 2/3)", effect: "how an approved spec becomes a task graph" },
  "um-axis": { path: "um/axis/generic.md", source: "src/um/loop.ts", effect: "the fallback rubric for a user-configured consequence axis" },
  "um-axis-performance": { path: "um/axis/performance.md", source: "src/um/loop.ts", effect: "how an option's performance consequence is priced in a poll" },
  "um-axis-maintainability": { path: "um/axis/maintainability.md", source: "src/um/loop.ts", effect: "how an option's maintainability cost is priced in a poll" },
  "um-axis-extensibility": { path: "um/axis/extensibility.md", source: "src/um/loop.ts", effect: "how an option's extensibility tax is priced in a poll" },
  "um-axis-failure-modes": { path: "um/axis/failure-modes.md", source: "src/um/loop.ts", effect: "how an option's failure modes are priced in a poll" },
  "um-axis-idiom": { path: "um/axis/idiom.md", source: "src/um/loop.ts", effect: "how an option's idiomatic fit is priced in a poll" },
};

/** Relative on-disk path for a prompt id (foldered by component). */
export function promptRelPath(id: PromptId): string {
  return PROMPT_META[id].path;
}

/** Top-level component group a prompt belongs to (the first path segment), for grouping in the README. */
export function promptGroup(id: PromptId): string {
  return PROMPT_META[id].path.split("/")[0]!;
}

/** Fail fast if a new prompt id is ever added without catalog metadata. */
export function assertCatalogComplete(): void {
  for (const id of allPromptIds()) {
    if (!PROMPT_META[id]) throw new Error(`prompt "${id}" has no catalog metadata — add it to PROMPT_META`);
  }
}
