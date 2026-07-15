// The objective "spec done" predicate: corpocode build refuses to decompose until this passes.
// Pure — the caller decides what to do with failures (report, poll, or --allow-incomplete).
import type { Spec } from "./spec-schema";

export interface CompletenessReport {
  ok: boolean;
  failures: string[];
}

const CLARIFICATION = /\[NEEDS CLARIFICATION[^\]]*\]/i;
// EARS: WHEN|IF|WHILE|WHERE <condition> ... SHALL <behavior> (Rolls-Royce requirements notation).
const EARS = /\b(WHEN|IF|WHILE|WHERE)\b[\s\S]+\bSHALL\b/i;

export function checkSpecCompleteness(spec: Spec): CompletenessReport {
  const failures: string[] = [];

  const pools: Array<[string, string]> = [
    ...spec.constraints.map((c, i): [string, string] => [`constraints[${i}]`, c]),
    ...spec.acceptance.map((a): [string, string] => [`acceptance[${a.id}]`, a.criterion]),
    ...spec.taskSeeds.map((t): [string, string] => [`taskSeeds[${t.id}]`, `${t.title} ${t.description}`]),
  ];
  for (const [where, text] of pools) {
    if (CLARIFICATION.test(text)) failures.push(`${where}: unresolved [NEEDS CLARIFICATION] marker`);
  }

  for (const a of spec.acceptance) {
    if (!EARS.test(a.criterion)) {
      failures.push(`acceptance[${a.id}]: not EARS-shaped (WHEN/IF/WHILE/WHERE … SHALL …)`);
    }
    if (a.verify.method === "command" && !a.verify.command) {
      failures.push(`acceptance[${a.id}]: verify.method "command" without a command`);
    }
  }

  const ids = new Set(spec.acceptance.map((a) => a.id));
  for (const t of spec.taskSeeds) {
    if (t.acceptanceRefs.length === 0) failures.push(`taskSeeds[${t.id}]: no acceptanceRefs — untraceable task`);
    for (const ref of t.acceptanceRefs) {
      if (!ids.has(ref)) failures.push(`taskSeeds[${t.id}]: unknown acceptance ref "${ref}"`);
    }
  }

  for (const [section, state] of Object.entries(spec.sections)) {
    if (state !== "complete") failures.push(`section ${section}: ${state}`);
  }

  return { ok: failures.length === 0, failures };
}
