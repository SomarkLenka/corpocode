// API keys live in ~/.corpocode/secrets (chmod 600), separate from config.json, so a user can
// commit a sanitized config to dotfiles without leaking credentials. Format is dotenv-style
// `KEY=value` lines. A missing/unreadable file degrades to an empty map (no throw); `doctor`
// checks readability explicitly.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { corpocodeHome, ensureDir, secretsFile } from "./paths";
import type { ProviderKind } from "./schema";

/** Conventional environment variable per provider kind, used when no apiKeyRef is configured. */
const ENV_KEY_BY_KIND: Record<ProviderKind, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  "anthropic-cli": null, // uses the user's `claude` CLI session, not a key
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  ollama: null, // local loopback, no auth
};

function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadSecrets(env?: NodeJS.ProcessEnv): Record<string, string> {
  try {
    return parseSecrets(readFileSync(secretsFile(env), "utf8"));
  } catch {
    return {};
  }
}

/** Write the secrets file with owner-only permissions (best-effort on Windows, where ACLs govern). */
export function saveSecrets(secrets: Record<string, string>, env?: NodeJS.ProcessEnv): void {
  ensureDir(corpocodeHome(env));
  const file = secretsFile(env);
  const body = `${Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  writeFileSync(file, body, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: POSIX modes don't apply; file access is governed by NTFS ACLs.
  }
}

/**
 * Resolve the API key for a provider: an explicit apiKeyRef wins (looked up in the secrets file,
 * then env), otherwise fall back to the conventional env var for that provider kind. Returns
 * undefined for keyless providers (ollama, anthropic-cli) or when nothing is configured.
 */
export function resolveApiKey(
  opts: { kind: ProviderKind; apiKeyRef?: string },
  secrets: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (opts.apiKeyRef) {
    return secrets[opts.apiKeyRef] ?? env[opts.apiKeyRef];
  }
  const envKey = ENV_KEY_BY_KIND[opts.kind];
  if (!envKey) return undefined;
  return env[envKey] ?? secrets[envKey];
}

export function conventionalEnvKey(kind: ProviderKind): string | null {
  return ENV_KEY_BY_KIND[kind];
}
