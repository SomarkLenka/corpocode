// Skill generator — the learning loop that turns lived experience into reusable skill candidates.
// It mines the experiential MemoryStore for `mistake` and `approach` memories (the recurring lessons),
// distills them through the cheap model into candidate skills, and writes each as a memo for review.
// It deliberately stops at "candidate": promoting a memo into an actual installed skill is a separate,
// explicit step (`corpocode skillify --promote`), because a durable change to the user's skill library
// is theirs to approve — propose, don't dispose.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir } from "../config/paths";
import type { Provider } from "../providers/types";
import type { MemoryStore, Scope } from "../backends/memory/types";
import { resolvePrompt } from "../prompts/resolve";

/** ~/.claude/memdir/corpocode-candidates (honoring CLAUDE_CONFIG_DIR), where memos await review. */
export function candidatesDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "memdir", "corpocode-candidates");
}

export interface SkillCandidate {
  name: string;
  description: string;
  body: string;
}

const zCandidates = z.object({
  candidates: z.array(z.object({ name: z.string(), description: z.string(), body: z.string() })),
});

/** Filesystem-safe kebab slug for a proposed skill name; "" if nothing usable remains. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Render a candidate as a skill memo: the same frontmatter+body shape an installed SKILL.md uses. */
export function renderMemo(c: SkillCandidate, slug: string): string {
  return `---\nname: ${slug}\ndescription: ${c.description.replace(/\n/g, " ").trim()}\n---\n\n${c.body.trim()}\n`;
}

export interface SkillgenDeps {
  memory: MemoryStore;
  provider: Provider;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  limit?: number; // memories to mine
  maxCandidates?: number; // cap on memos written
  dir?: string; // override candidates dir (tests)
  writeFileFn?: (path: string, content: string) => void;
}

export interface SkillgenResult {
  mined: number;
  written: number;
  names: string[];
}

export async function generateSkillCandidates(deps: SkillgenDeps): Promise<SkillgenResult> {
  const mems = await deps.memory.recall({
    kinds: ["mistake", "approach"],
    scope: deps.scope,
    limit: deps.limit ?? 50,
  });
  if (mems.length === 0) return { mined: 0, written: 0, names: [] };

  const corpus = mems.map((m) => `[${m.kind}] ${m.text}`).join("\n").slice(0, 8000);
  let candidates: SkillCandidate[];
  try {
    const out = await deps.provider.chat({
      system: resolvePrompt("skillgen", {}, { env: deps.env }),
      messages: [{ role: "user", content: corpus }],
      responseFormat: "json",
      maxTokens: 1200,
    });
    candidates = zCandidates.parse(JSON.parse(out.text)).candidates;
  } catch {
    return { mined: mems.length, written: 0, names: [] }; // distillation failed → no candidates, no throw
  }

  const dir = deps.dir ?? candidatesDir(deps.env);
  ensureDir(dir);
  const write = deps.writeFileFn ?? ((p: string, c: string) => writeFileSync(p, c));
  const names: string[] = [];
  for (const c of candidates.slice(0, deps.maxCandidates ?? 5)) {
    const slug = slugify(c.name);
    if (!slug) continue;
    write(join(dir, `${slug}.md`), renderMemo(c, slug));
    names.push(slug);
  }
  return { mined: mems.length, written: names.length, names };
}
