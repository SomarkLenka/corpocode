// Resolve an editable prompt's TEMPLATE with local-over-global-over-built-in precedence, then fill its
// {{placeholders}}. Resolution is fail-open at every step: an unreadable or empty override file is
// skipped, and if everything is absent the compiled-in default is used — a prompt call never breaks
// because a file is missing or malformed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globalPromptsDir, promptsDir } from "../config/paths";
import { BUILTIN_PROMPTS, type PromptId } from "./registry";
import { promptRelPath } from "./catalog";
import { renderTemplate } from "./render";

export interface PromptResolverOptions {
  cwd?: string; // project root — where ./.corpocode/prompts is looked up
  env?: NodeJS.ProcessEnv;
  /** Test seam: read a file's text or return null if absent. Defaults to a fail-open fs read. */
  readFile?: (path: string) => string | null;
}

function fsRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // missing/unreadable → fall through
  }
}

/** Strip a leading `<!-- ... -->` editing-guidance header (and BOM/whitespace) so it never reaches the
 *  model. Scaffolded files carry such a header; the built-in defaults don't, so this is a no-op there. */
function stripHeaderComment(text: string): string {
  return text.replace(/^﻿?\s*<!--[\s\S]*?-->\s*/, "");
}

/** The template for a prompt: project-local file → global file → built-in default. */
export function resolveTemplate(id: PromptId, opts: PromptResolverOptions = {}): string {
  const read = opts.readFile ?? fsRead;
  const rel = promptRelPath(id);
  for (const dir of [promptsDir(opts.cwd, opts.env), globalPromptsDir(opts.env)]) {
    const raw = read(join(dir, rel));
    if (raw == null) continue;
    const text = stripHeaderComment(raw);
    if (text.trim()) return text; // a present-but-empty override is treated as "not set"
  }
  return BUILTIN_PROMPTS[id];
}

/** Resolve a prompt's template and fill its {{placeholders}} with the call site's runtime variables. */
export function resolvePrompt(id: PromptId, vars: Record<string, string> = {}, opts: PromptResolverOptions = {}): string {
  return renderTemplate(resolveTemplate(id, opts), vars);
}

/** A resolver bound to one project root + env, carried on HookContext so components resolve uniformly. */
export interface PromptResolver {
  resolve(id: PromptId, vars?: Record<string, string>): string;
}

export function createPromptResolver(opts: PromptResolverOptions = {}): PromptResolver {
  return { resolve: (id, vars) => resolvePrompt(id, vars, opts) };
}
