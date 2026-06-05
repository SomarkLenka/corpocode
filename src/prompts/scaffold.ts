// Write the built-in default prompts to ~/.corpocode/prompts/ as editable .md files, foldered by
// component (see PROMPT_META). Each file carries a header — stripped before the prompt reaches the
// model — naming the source that uses it and what editing it changes; a README.md indexes them all.
// Never clobbers an edited prompt file unless force=true; the README is always refreshed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, globalPromptsDir } from "../config/paths";
import { allPromptIds, BUILTIN_PROMPTS, type PromptId } from "./registry";
import { PROMPT_META, promptGroup, promptRelPath } from "./catalog";
import { templateVars } from "./render";

export interface ScaffoldResult {
  dir: string;
  wrote: PromptId[];
  skipped: PromptId[];
}

/** The on-disk form of a default prompt: a guidance header (stripped on read) + the template body. */
export function renderScaffold(id: PromptId): string {
  const body = BUILTIN_PROMPTS[id];
  const meta = PROMPT_META[id];
  const vars = templateVars(body);
  const header = [
    `<!-- CorpoCode prompt "${id}"`,
    `     Used by:           ${meta.source}`,
    `     Editing this sets: ${meta.effect}`,
    `     Overrides:         a project-local ./.corpocode/prompts/${meta.path} beats this global copy;`,
    `                        both beat the built-in default. Delete this file to revert.`,
    vars.length
      ? `     Placeholders:      filled at run time — keep them: ${vars.map((v) => `{{${v}}}`).join(", ")}`
      : `     Placeholders:      none.`,
    `-->`,
  ].join("\n");
  return `${header}\n\n${body}\n`;
}

/** A README that indexes every prompt by component group with its source and effect. */
export function renderReadme(): string {
  const byGroup = new Map<string, PromptId[]>();
  for (const id of allPromptIds()) {
    const arr = byGroup.get(promptGroup(id)) ?? [];
    arr.push(id);
    byGroup.set(promptGroup(id), arr);
  }
  const lines: string[] = [
    "# CorpoCode prompts",
    "",
    "Each file is a system prompt for one CorpoCode component — the folder names the component, so you",
    "can see where a prompt is used (and what editing it affects). A project-local",
    "`./.corpocode/prompts/<path>` overrides this global copy; both override the built-in default. Delete",
    "a file to revert. `{{placeholders}}` are filled at run time — keep them.",
    "",
  ];
  for (const [group, ids] of byGroup) {
    lines.push(`## ${group}`, "");
    for (const id of ids) {
      const m = PROMPT_META[id];
      lines.push(`- \`${m.path}\` — ${m.effect} · _${m.source}_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function scaffoldPrompts(opts: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): ScaffoldResult {
  const dir = globalPromptsDir(opts.env);
  ensureDir(dir);
  const wrote: PromptId[] = [];
  const skipped: PromptId[] = [];
  for (const id of allPromptIds()) {
    const path = join(dir, promptRelPath(id));
    if (existsSync(path) && !opts.force) {
      skipped.push(id);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderScaffold(id));
    wrote.push(id);
  }
  writeFileSync(join(dir, "README.md"), renderReadme()); // always refresh the index
  return { dir, wrote, skipped };
}
