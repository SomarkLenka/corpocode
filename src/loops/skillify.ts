// The promote half of the skill loop: take reviewed candidate memos and install them as real skills
// under ~/.claude/skills/<name>/SKILL.md. This is the explicit, user-driven step — it only runs when
// the user asks for it (`corpocode skillify --promote`), and it only acts on memos that already passed
// the validity gate (a name and a description). A memo missing either is skipped, never installed.
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../config/paths";
import { candidatesDir, slugify } from "./skillgen";

/** ~/.claude/skills (honoring CLAUDE_CONFIG_DIR), the installed-skill library. */
export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "skills");
}

export interface Frontmatter {
  name?: string;
  description?: string;
}

/** Minimal frontmatter reader: the `---` block at the top, `key: value` lines only (no YAML deps). */
export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Frontmatter = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const key = kv[1]!;
      if (key === "name" || key === "description") fm[key] = kv[2]!.trim();
    }
  }
  return { fm, body: m[2] ?? "" };
}

export interface PromoteOptions {
  fromDir?: string;
  toDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Remove a memo after it is promoted (default true; tests set false to inspect). */
  removeAfter?: boolean;
}

export interface PromoteResult {
  promoted: string[];
  skipped: string[];
}

export function promoteCandidates(opts: PromoteOptions = {}): PromoteResult {
  const from = opts.fromDir ?? candidatesDir(opts.env);
  const to = opts.toDir ?? skillsDir(opts.env);
  let files: string[];
  try {
    files = readdirSync(from).filter((f) => f.endsWith(".md"));
  } catch {
    return { promoted: [], skipped: [] }; // no candidates dir → nothing to promote
  }

  const promoted: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const path = join(from, f);
    const raw = readFileSync(path, "utf8");
    const { fm } = parseFrontmatter(raw);
    const slug = fm.name ? slugify(fm.name) : "";
    if (!slug || !fm.description) {
      skipped.push(f); // invalid memo: missing a name or description → never installed
      continue;
    }
    const skillDir = join(to, slug);
    ensureDir(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), raw); // the memo already IS valid SKILL.md
    promoted.push(slug);
    if (opts.removeAfter !== false) {
      try {
        rmSync(path);
      } catch {
        // a leftover memo is harmless; removal is best-effort
      }
    }
  }
  return { promoted, skipped };
}
