// Write every built-in default prompt to ~/.corpocode/prompts/<id>.md so the user has an editable
// starting point. Each file carries a header comment (stripped before the prompt reaches the model)
// listing its placeholders. Never overwrites an existing file unless force=true — a user's edits are safe.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, globalPromptsDir } from "../config/paths";
import { allPromptIds, BUILTIN_PROMPTS, type PromptId } from "./registry";
import { templateVars } from "./render";

export interface ScaffoldResult {
  dir: string;
  wrote: PromptId[];
  skipped: PromptId[];
}

/** Render the on-disk form of a default prompt: a guidance header (stripped on read) + the template. */
export function renderScaffold(id: PromptId): string {
  const body = BUILTIN_PROMPTS[id];
  const vars = templateVars(body);
  const header = [
    `<!-- CorpoCode prompt "${id}". Edit freely; this global copy is overridden by a project-local`,
    `     ./.corpocode/prompts/${id}.md, and both override the built-in default. Delete to revert.`,
    vars.length
      ? `     Placeholders are filled at run time — keep them: ${vars.map((v) => `{{${v}}}`).join(", ")}`
      : `     This prompt takes no placeholders.`,
    `-->`,
  ].join("\n");
  return `${header}\n\n${body}\n`;
}

export function scaffoldPrompts(opts: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): ScaffoldResult {
  const dir = globalPromptsDir(opts.env);
  ensureDir(dir);
  const wrote: PromptId[] = [];
  const skipped: PromptId[] = [];
  for (const id of allPromptIds()) {
    const path = join(dir, `${id}.md`);
    if (existsSync(path) && !opts.force) {
      skipped.push(id);
      continue;
    }
    writeFileSync(path, renderScaffold(id));
    wrote.push(id);
  }
  return { dir, wrote, skipped };
}
