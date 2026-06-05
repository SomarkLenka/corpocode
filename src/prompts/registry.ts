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
} as const;

export type PromptId = keyof typeof BUILTIN_PROMPTS;

export function isPromptId(id: string): id is PromptId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PROMPTS, id);
}

/** Every prompt id, for the scaffold writer and docs. */
export function allPromptIds(): PromptId[] {
  return Object.keys(BUILTIN_PROMPTS) as PromptId[];
}
