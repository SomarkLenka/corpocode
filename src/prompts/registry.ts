// The built-in default for every editable system prompt, keyed by id. These are the fallback when no
// project-local (`./.corpocode/prompts/<id>.md`) or global (`~/.corpocode/prompts/<id>.md`) override
// exists, AND the source `corpocode prompts --scaffold` writes out for the user to edit. {{placeholders}}
// are filled by the call site at run time — keep them intact when editing, or the data won't appear.
//
// One id per LLM call site across the caretakers. Adding a new LLM call means adding its default here.
export const BUILTIN_PROMPTS = {
  // router/ranker.ts — stage-2 moment categorizer. {{lineOfThought}} = the distilled intent/approach/
  // entities block; {{candidates}} = the bulleted candidate-file list.
  router: [
    "You are a routing classifier for a coding agent. Classify the user's current moment and pick",
    "which candidate files matter. Respond with ONLY a JSON object with these fields:",
    "type (code-edit|code-gen|exploration|docs|config|other), complexity (trivial|medium|hard),",
    "breakpoint (boolean), delegate_to (string, optional), dispatch_retrieval (boolean),",
    "effort (minimal|medium|high), context_files_to_preload (string[], a SUBSET of the candidates).",
    "",
    "Line of thought:",
    "{{lineOfThought}}",
    "",
    "Candidate files (only choose context_files_to_preload from these):",
    "{{candidates}}",
  ].join("\n"),

  // intelligence/patterns/bug-hunt.ts — one read-only file-relevance agent. The file PATH and the bug
  // description arrive via the call's structured inputs, so this instruction carries no {{placeholders}}.
  "bug-hunt-file-relevance": [
    "You are given ONE file path (in the inputs) and a bug description. Read the file with your",
    "read-only tools. Decide whether this file is implicated in the bug. If it is, cite the exact line",
    "ranges and a one-line reason for each. Be strict: default implicated=false unless the file",
    "plausibly contains the fault. Respond with ONLY JSON:",
    '{"implicated":boolean,"confidence":number 0..1,"lines":[{"start":int,"end":int,"why":string}]}.',
  ].join(" "),

  // intelligence/patterns/pre-write.ts — one read-only architectural-guidance agent before a write. The
  // target + neighbor file PATHS and the proposed-change summary arrive via the call's structured inputs,
  // so this instruction carries no {{placeholders}}.
  "pre-write-guidance": [
    "You are shown a file about to be edited, its structurally related files (paths in the inputs — read",
    "them with your read-only tools), and a summary of the proposed change. Warn ONLY about concrete",
    "breakage the diff can't see: callers that rely on current behavior, invariants, contracts. Be terse",
    "and specific; cite files. No style nits. Respond with ONLY JSON:",
    '{"warnings":[{"claim":string,"severity":"info"|"warn"|"block","refs":[string]}]} — return empty warnings if nothing is at risk.',
  ].join(" "),

  // filter/classify.ts — the soft safety classifier for shell commands (the `ask` leftover).
  "filter-classify": [
    "You are a safety classifier for shell commands run inside a coding session. Decide: deny",
    "(clearly destructive or dangerous — wipes data, exfiltrates secrets, modifies the system),",
    "allow (clearly safe — read-only inspection, a test/build/lint run), or ask (uncertain — let",
    'the human decide). Default to ask when unsure. Respond with ONLY JSON {"decision":...,"reason":...}.',
  ].join(" "),

  // session/reader.ts — distills the agent's line of thought from the newest transcript slice.
  "session-reader": [
    "You track a coding agent's line of thought across a session. Given the prior ThoughtState and",
    "the newest transcript slice, return the UPDATED ThoughtState as JSON. Carry forward the prior",
    "intent unless the new slice clearly changes it. Keep arrays short and concrete. Fields:",
    "intent (string), approach (string, optional), openQuestions (string[]), recentDecisions",
    "(string[]), entities (string[] of files/symbols/concepts in active play).",
  ].join(" "),

  // retrieval/planner.ts — the keyless fallback that plans a retrieval checklist for the moment.
  retrieval: [
    "You plan a retrieval checklist for a coding agent. Choose a short list of items, each from this",
    "menu of kinds: query_graph (code structure), ov_find (reference docs), mem_recall (past",
    "decisions/mistakes), get_node (locate a named symbol). Each item has a focused `query`. Respond",
    'with ONLY JSON: {"items":[{"kind":...,"query":...}]}.',
  ].join(" "),

  // compactor/worker.ts — digests an older transcript slice at Stop.
  compactor: [
    "Summarize the following older slice of a coding session into a compact digest that preserves the",
    "decisions made, problems solved, files touched, and any open threads. Be concise and factual; no",
    "preamble.",
  ].join(" "),

  // loops/skillgen.ts — distills recorded mistakes/approaches into reusable skill candidates.
  skillgen: [
    "You turn an agent's recorded mistakes and approaches into reusable skill candidates. Cluster the",
    "memories by recurring theme; for each strong, generalizable theme propose one skill as",
    "{ name, description, body }: a short kebab-case name, a one-line description of when to use it, and",
    "a body of concrete guidance. Only propose a skill when a theme recurs or is clearly reusable —",
    "prefer fewer, higher-quality candidates. Respond as JSON: { candidates: [...] }.",
  ].join(" "),

  // toolbox/classifier.ts — picks the relevant gated skills/agents. {{kind}} = "skill"|"agent";
  // {{menu}} = the bulleted "name: when-to-use" catalog for that kind.
  toolbox: [
    "You pick which {{kind}}s are relevant to the user's request, from this catalog (name: when-to-use):",
    "{{menu}}",
    "",
    'Pick ONLY the genuinely relevant ones — often zero. Respond with ONLY JSON: {"selected":[{"name":string,"reason":string}]}. Use exact names from the catalog.',
  ].join("\n"),

  // filter/inject.ts — picks the relevant slice of a file being read. {{purpose}} = why it's read;
  // {{neighbors}} = structurally related symbols from the graph.
  "filter-inject": [
    "You decide which part of a file matters for a stated purpose, to focus a reader.",
    "Purpose: {{purpose}}",
    "Structurally related symbols (from the code graph): {{neighbors}}",
    'Return ONLY JSON {"relevant":boolean,"confidence":number 0..1,"focus":string}, where focus names the function(s)/section(s) to read for this purpose. If the whole file is needed or you are unsure, set relevant=false.',
  ].join("\n"),

  // docs/generator.ts — one JSON facet about a symbol. {{instruction}} = the facet question;
  // {{symbol}} = the symbol under analysis.
  "docs-facet": "{{instruction}} Focus only on the symbol `{{symbol}}`. Respond as JSON.",

  // docs/generator.ts — inline doc-comment writer. {{symbol}} = the symbol to document.
  "docs-inline": [
    "Write a concise documentation comment for the named symbol. Return only the comment text",
    "(no code, no fences), explaining what it does and any non-obvious why. Under 6 lines.",
    "Symbol: `{{symbol}}`.",
  ].join(" "),

  // verifier/worker.ts — wraps a per-tenet rubric for a post-edit check. {{rubric}} = the active
  // tenet's check prompt. (The 9 tenet rubrics themselves live in src/verifier/tenets/*.ts.)
  verifier: [
    "{{rubric}}",
    "",
    'Respond with ONLY JSON: {"ok":boolean,"severity":"info"|"warn"|"block","message":string,"confidence":number 0..1}. ok=true means the tenet is satisfied.',
  ].join("\n"),

  // molar/engine.ts — wraps a per-tenet rubric for reviewing a PROPOSED APPROACH. {{rubric}} = the
  // active tenet's check prompt.
  review: [
    "You review a PROPOSED APPROACH (not finished code) through one lens.",
    "{{rubric}}",
    "",
    'Respond with ONLY JSON: {"ok":boolean,"severity":"info"|"warn"|"block","message":string,"confidence":number 0..1}. ok=true means the approach is sound on this tenet.',
  ].join("\n"),

  // The 9 MOLAR-EDIT tenet rubrics (src/verifier/tenets/*.ts). Each is the {{rubric}} the `verifier`
  // (post-edit) and `review` (design) wrappers fill, so a user can retune any single tenet's standard.
  "verifier-maintainability":
    "Assess Maintainability (M): is this change isolated to the files it needs, with accurate names that hold no surprises, magic values named, and no dead or commented-out code? Flag a change that sprawls across unrelated files, names that lie (an isValid() that mutates, a getUser() that creates), unexplained magic numbers/strings, and commented-out code kept 'just in case' (git remembers).",
  "verifier-observability":
    "Assess Observability (O): do critical paths emit a latency metric and a success/failure signal, do readiness checks verify real downstream reachability rather than mere process liveness, and do trace IDs propagate across every async/queue boundary? Flag a critical path with no metric, a /health that returns 200 just because the process is up, and high-cardinality metric labels.",
  "verifier-logging":
    "Assess Logging (L): are errors logged once, at the layer that handles them, with structured, actionable context (what failed, where, why, what to check next)? Flag bare catch blocks that swallow errors, console.log debug statements, unstructured string logs, and any logging of secrets or PII.",
  "verifier-atomicity":
    "Assess Atomicity (A): does each unit in this file do ONE thing, named for that one thing in five words or fewer, with a call graph that reads as a line rather than a tree of unrelated conditionals? Flag functions/files that do several unrelated things, names containing 'and', and junk-drawer modules.",
  "verifier-responsiveness":
    "Assess Responsiveness (R) for this UI file: does it work at a ≤375px viewport, is every flow completable by keyboard alone, does every image carry meaningful alt and every control an associated <label>, is color reinforced by text/icon/pattern rather than being the sole signal, and does any API return structure (blocks/types) rather than presentation (HTML/CSS)? Flag desktop-only layouts, click handlers on non-focusable elements, missing alt/labels, and color-only signals.",
  "verifier-extensibility":
    "Assess Extensibility (E): is new behavior placed behind an abstraction that can be swapped, with core logic separated from the concrete implementation, so an alternative can be added without editing call sites? Flag a concrete vendor or implementation hard-wired into business logic where an interface seam belongs.",
  "verifier-documentation":
    "Assess Documentation (D): is the WHY recorded for any non-obvious choice (the constraint, the alternative considered, the trade-off, an ADR link), do comments explain intent rather than restate the code, and does this change leave no doc stale? Flag comments that merely restate the line below, an ADR-worthy decision made with no durable record, and a doc the code now contradicts.",
  "verifier-in-flight":
    "Assess In-flight (I): does every external call (HTTP, DB, queue, cache) have a timeout, a bounded and jittered retry, and a defined fallback, and does the code keep flying when a dependency is down instead of crashing? Flag an await with no timeout, unbounded/unjittered retries, a cache miss that hard-fails the request, and 'crash and let the orchestrator restart' used as the recovery plan.",
  "verifier-testing":
    "Assess Testing (T): does a bug fix arrive with a regression test that fails WITHOUT the fix, are failure paths (timeout, 5xx, malformed input) tested as deliberately as the happy path, and do tests assert caller-visible behavior rather than internals or call counts? Flag new logic with no test, untested error paths, and any .only/.skip shipped to main.",
} as const;

export type PromptId = keyof typeof BUILTIN_PROMPTS;

export function isPromptId(id: string): id is PromptId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PROMPTS, id);
}

/** Every prompt id, for the scaffold writer and docs. */
export function allPromptIds(): PromptId[] {
  return Object.keys(BUILTIN_PROMPTS) as PromptId[];
}
