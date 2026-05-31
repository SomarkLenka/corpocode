// Single source of truth for every on-disk location CorpoCode uses. No other module
// hard-codes a path — they all ask here, so platform differences live in exactly one place.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Root directory for all CorpoCode state. Resolved per-platform (XDG on Linux,
 * Application Support on macOS, %APPDATA% on Windows) but overridable as a whole via
 * CORPOCODE_HOME — which tests rely on to redirect state into a temp dir.
 */
export function corpocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CORPOCODE_HOME;
  if (override && override.trim()) return override;

  if (process.platform === "win32") {
    const base = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "corpocode");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "corpocode");
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "corpocode");
}

export function configFile(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "config.json");
}

export function secretsFile(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "secrets");
}

export function logsDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "logs");
}

export function logFile(env?: NodeJS.ProcessEnv): string {
  return join(logsDir(env), "corpocode.ndjson");
}

export function memoryDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "memory");
}

export function memoryFile(project: string, env?: NodeJS.ProcessEnv): string {
  return join(memoryDir(env), `${project}.json`);
}

export function memoryEmbeddingsFile(project: string, env?: NodeJS.ProcessEnv): string {
  return join(memoryDir(env), `${project}.embeddings.json`);
}

export function sessionsDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "sessions");
}

export function cacheDir(env?: NodeJS.ProcessEnv): string {
  return join(corpocodeHome(env), "cache");
}

/** A namespaced cache file (e.g. "scorefiles"), so each cached computation lives in its own version
 * envelope and a stale one can be dropped wholesale by bumping its version. */
export function cacheFile(namespace: string, env?: NodeJS.ProcessEnv): string {
  return join(cacheDir(env), `${namespace}.json`);
}

/**
 * Per-session cache for the SessionReader (distilled state + transcript byte offset). Persisted
 * to disk so each separate `corpocode hook` process reads only the new transcript slice — keeping
 * per-hook cost flat as the transcript grows.
 */
export function sessionStateFile(sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), `${safeSessionId(sessionId)}.json`);
}

/**
 * Per-session cache of the categorizer's last decision (moment type, effort, and the ids it
 * recalled). The context injector reads the moment type to decide whether to slice; the compactor
 * reads the recalled ids to close the outcome loop. Written by the router each turn.
 */
export function sessionDecisionFile(sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), `${safeSessionId(sessionId)}.decision.json`);
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
