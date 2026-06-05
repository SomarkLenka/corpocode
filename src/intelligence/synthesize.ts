// synthesize — the last step of the IntelligentRouter: fold an OrchestrationResult into ONE injection
// block the main model sees. This is the generic default (a pattern may supply its own synthesizer for a
// richer shape); it renders each surviving task's payload under its id and wraps the whole thing in the
// single `intelligentRouter` tag, so the model gets one coherent, source-identified block instead of N.
//
// Two invariants: (1) structure/meaning only — never HTML/markup (the one rule); payloads are emitted as
// plain text / JSON, the rendering surface decides appearance. (2) Fail-open / no-op — when nothing
// survived (empty result, or every task lacked usable output) it returns "" so the handler injects nothing.
import { TAGS, tagged } from "../hooks/response";
import type { OrchestrationResult, AgentTaskResult } from "./types";

export interface SynthesizeOptions {
  tag?: string; // override the wrapping tag (defaults to the IntelligentRouter tag)
  header?: string; // optional one-line lead before the per-task sections
}

/** Render one task's payload to text: prefer the agent's prose, else its structured data as JSON. */
function renderTask(t: AgentTaskResult): string | null {
  const r = t.result;
  if (typeof r.text === "string" && r.text.trim().length > 0) return `## ${t.id}\n${r.text.trim()}`;
  if (r.data !== undefined && r.data !== null) return `## ${t.id}\n${JSON.stringify(r.data, null, 2)}`;
  return null; // nothing usable from this task — drop it from the injection
}

/**
 * Build the single tagged injection from an orchestration result. Returns "" when there is nothing to
 * inject (so the caller emits an empty response and the turn is byte-identical to no IntelligentRouter).
 */
export function synthesize(result: OrchestrationResult, opts: SynthesizeOptions = {}): string {
  const sections = result.tasks.map(renderTask).filter((s): s is string => s !== null);
  if (sections.length === 0) return "";
  const body = [opts.header?.trim(), ...sections].filter(Boolean).join("\n\n");
  return tagged(opts.tag ?? TAGS.intelligentRouter, body);
}
