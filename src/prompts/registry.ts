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
} as const;

export type PromptId = keyof typeof BUILTIN_PROMPTS;

export function isPromptId(id: string): id is PromptId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PROMPTS, id);
}

/** Every prompt id, for the scaffold writer and docs. */
export function allPromptIds(): PromptId[] {
  return Object.keys(BUILTIN_PROMPTS) as PromptId[];
}
