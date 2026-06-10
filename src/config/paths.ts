// Single source of truth for every on-disk location CorpoCode uses. No other module
// hard-codes a path — they all ask here, so platform differences live in exactly one place.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Root directory for GLOBAL CorpoCode state (config + secrets). One predictable location on every OS:
 * a `.corpocode` dotfolder in the user's home directory — e.g. `C:\Users\you\.corpocode` on Windows,
 * `~/.corpocode` on Linux/macOS — rather than the platform-specific APPDATA / Application Support / XDG
 * dirs. Overridable as a whole via CORPOCODE_HOME, which tests rely on to redirect state into a temp
 * dir. Project-local state (logs, memory, sessions) lives in `./.corpocode` instead — see projectStateDir.
 */
export function corpocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CORPOCODE_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), ".corpocode");
}

export function configFile(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "config.json");
}

export function secretsFile(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "secrets");
}

/**
 * Base directory for PROJECT-LOCAL state — logs, memory, and the session cache. It lives in a
 * `.corpocode/` folder in the host's working directory (the project root), so this state is easy to
 * find per-project and doesn't depend on a home-dir path that varies by OS (notably Windows). Config
 * and secrets still live under `corpocodeHome` — secrets must never land in a repo.
 *
 * `CORPOCODE_HOME` overrides the base entirely, pinning ALL state to one directory: tests rely on this
 * for isolation, and a user can set it to keep the old global behavior. `cwd` defaults to
 * `process.cwd()`; the hook dispatcher passes the envelope's cwd so a hook reads/writes the repo it is
 * running against even if its process cwd differs.
 */
export function projectStateDir(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CORPOCODE_HOME;
  if (override && override.trim()) return override;
  return join(cwd, ".corpocode");
}

export function logsDir(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(projectStateDir(cwd, env), "logs");
}

export function logFile(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(logsDir(cwd, env), "corpocode.ndjson");
}

/**
 * Human-readable companion to the NDJSON log: each hook appends a block interleaving the new
 * transcript slice with the hook's output, so the flow reads top-to-bottom. Append-only plain text.
 */
export function flowLogFile(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(logsDir(cwd, env), "corpocode-flow.log");
}

/**
 * Per-session byte offset for the flow log, kept SEPARATE from the SessionReader's offset
 * (sessionStateFile) so the two consumers advance the transcript independently and never starve
 * each other of the slice they each need to read. Lives inside the session's own folder
 * (`sessions/<session>/flow.offset`) so all of a session's ephemeral state is GC'd as one unit
 * by `pruneOldSessions`, instead of accumulating as loose dotfiles in the logs dir.
 */
export function flowCursorFile(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionDir(sessionId, cwd, env), "flow.offset");
}

/**
 * This session's own slice of the NDJSON event log. Every line emitted while handling a hook for this
 * session is teed here as well as to the global `logs/corpocode.ndjson`, so one session's activity can be
 * read in isolation (atomic oversight) without grepping the global log. Lives in the session's folder.
 */
export function sessionLogFile(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionDir(sessionId, cwd, env), "corpocode.ndjson");
}

/** This session's own slice of the human-readable flow log (companion to the global corpocode-flow.log). */
export function sessionFlowLogFile(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionDir(sessionId, cwd, env), "corpocode-flow.log");
}

export function memoryDir(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(projectStateDir(cwd, env), "memory");
}

/**
 * Editable per-component system prompts. Resolution is local-over-global: a `prompts/<id>.md` in the
 * project's `./.corpocode` (here) wins over the same file under the global `~/.corpocode` (globalPromptsDir),
 * which in turn wins over the built-in default compiled into the binary. Lets a user tune any prompt
 * per-project or globally without touching code.
 */
export function promptsDir(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(projectStateDir(cwd, env), "prompts");
}

/** Global (home-dir) prompt overrides — `~/.corpocode/prompts`. Superseded by the project-local dir. */
export function globalPromptsDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "prompts");
}

export function memoryFile(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(memoryDir(cwd, env), "memory.json");
}

export function memoryEmbeddingsFile(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(memoryDir(cwd, env), "memory.embeddings.json");
}

export function sessionsDir(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(projectStateDir(cwd, env), "sessions");
}

/**
 * One session's own folder under `sessions/`, holding ALL of that session's ephemeral state — the
 * SessionReader cache, the decision cache, and the flow-log cursor. Grouping per session (rather than
 * scattering loose `<session>.json` / `.flow-<session>.offset` files across two dirs) means a dead
 * session is GC'd by deleting one folder — see `pruneOldSessions`.
 */
export function sessionDir(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(cwd, env), safeSessionId(sessionId));
}

export function cacheDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "cache");
}

/** A namespaced cache file (e.g. "scorefiles"), so each cached computation lives in its own version
 * envelope and a stale one can be dropped wholesale by bumping its version. */
export function cacheFile(namespace: string, env?: NodeJS.ProcessEnv): string {
  return join(cacheDir(env), `${namespace}.json`);
}

/** Backup of every skill/agent CorpoCode gated (originals), so uninstall can restore them. Global,
 * because it mirrors the global ~/.claude tree; entries are keyed by scope+relpath inside. */
export function toolboxRestoreDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "corpocode-restore");
}

/** The toolbox catalog: each gated skill/agent's original "when to use", for the classifier. */
export function catalogFile(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "toolbox-catalog.json");
}

/**
 * Per-session cache for the SessionReader (distilled state + transcript byte offset). Persisted
 * to disk so each separate `corpocode hook` process reads only the new transcript slice — keeping
 * per-hook cost flat as the transcript grows.
 */
export function sessionStateFile(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionDir(sessionId, cwd, env), "reader.json");
}

/**
 * Per-session cache of the categorizer's last decision (moment type, effort, and the ids it
 * recalled). The context injector reads the moment type to decide whether to slice; the compactor
 * reads the recalled ids to close the outcome loop. Written by the router each turn.
 */
export function sessionDecisionFile(sessionId: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionDir(sessionId, cwd, env), "decision.json");
}

/**
 * Directory holding the IntelligentRouter's persisted agent-session records. Project-local (beside the
 * SessionReader's `sessions/`), so a fresh hook process can `--resume` an agent thread it opened earlier.
 */
export function agentSessionsDir(cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(projectStateDir(cwd, env), "agent-sessions");
}

/**
 * One agent-session record file, keyed by a purpose-scoped key (per-file or per-topic — already hashed
 * by the caller). The key is sanitized again here so an unhashed key can never escape the directory.
 */
export function agentSessionFile(key: string, cwd?: string, env?: NodeJS.ProcessEnv): string {
  return join(agentSessionsDir(cwd, env), `${safeSessionId(key)}.json`);
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "session";
}

/** Create a directory (and parents) if absent. No-op when it already exists. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Stable, filesystem-safe key for a project, derived from its absolute repo root. The short
 * hash disambiguates two same-named directories in different locations.
 */
export function projectKey(repoRoot: string): string {
  const base = repoRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "project";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "project";
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}
