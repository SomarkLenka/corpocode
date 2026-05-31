// The defensive fallback. If the ContextStore daemon is unavailable, the compactor writes the digest
// to a plain memory directory under the host's config dir, so the learning is never lost even when
// the daemon is down. `compaction.backend: "memdir"` makes this the primary path for users who
// prefer no daemon at all.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../config/paths";

/** ~/.claude/memdir/session-summaries (honoring CLAUDE_CONFIG_DIR), where digests land as files. */
export function memdirSessionSummariesDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "memdir", "session-summaries");
}

export function writeMemdir(sessionId: string, turn: string, digest: string, env?: NodeJS.ProcessEnv): string {
  const dir = memdirSessionSummariesDir(env ?? process.env);
  ensureDir(dir);
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "session";
  const path = join(dir, `${safe}-${turn}.md`);
  writeFileSync(path, digest);
  return path;
}
