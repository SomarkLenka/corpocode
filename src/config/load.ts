// Read + validate + env-override the config into a typed object. Components never call this
// themselves — the dispatcher loads once per process and hands each component its slice, which
// keeps components pure (behavior is a function of the passed config, not hidden global state).
import { readFileSync } from "node:fs";
import { configFile } from "./paths";
import { configSchema, type CorpoConfig } from "./schema";
import { applyEnvOverrides, type AppliedOverride } from "./env-overrides";
import { z } from "zod";

/** Thrown when a config file is present but unreadable or fails schema validation. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadResult {
  config: CorpoConfig;
  source: "file" | "defaults";
  appliedOverrides: AppliedOverride[];
  path: string;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Load the config with full provenance. Order of operations:
 *  1. Read the file (missing → defaults; present-but-broken → ConfigError).
 *  2. Validate the file object, filling defaults — this establishes the full leaf set.
 *  3. Apply CORPOCODE_* overrides onto the defaults-filled object.
 *  4. Re-validate, so a bad override is caught with the same clear error as a bad file value.
 */
export function loadConfigDetailed(
  opts: { env?: NodeJS.ProcessEnv; path?: string } = {},
): LoadResult {
  const env = opts.env ?? process.env;
  const path = opts.path ?? configFile(env);

  let raw: unknown = {};
  let source: "file" | "defaults" = "defaults";
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
    source = "file";
  } catch (err) {
    if (!isNotFound(err)) {
      throw new ConfigError(`failed to read or parse config at ${path}`, err);
    }
    raw = {}; // missing file → defaults (graceful start)
  }

  const fileParsed = configSchema.safeParse(raw);
  if (!fileParsed.success) {
    throw new ConfigError(`invalid config at ${path}: ${formatZodError(fileParsed.error)}`, fileParsed.error);
  }

  const { config: overridden, applied } = applyEnvOverrides(fileParsed.data, env);

  const finalParsed = configSchema.safeParse(overridden);
  if (!finalParsed.success) {
    throw new ConfigError(
      `invalid config after env overrides: ${formatZodError(finalParsed.error)}`,
      finalParsed.error,
    );
  }

  return { config: finalParsed.data, source, appliedOverrides: applied, path };
}

/** Convenience wrapper returning just the validated config. */
export function loadConfig(opts: { env?: NodeJS.ProcessEnv; path?: string } = {}): CorpoConfig {
  return loadConfigDetailed(opts).config;
}

/** The complete default config a fresh install writes. */
export function defaultConfig(): CorpoConfig {
  return configSchema.parse({});
}
