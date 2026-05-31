// CORPOCODE_* environment overrides for config values — the mechanism CI uses to swap a model
// or key without writing a file.
//
// We cannot split an env name on "_" because config keys themselves contain underscores
// (trivial_early_exit, cheap_local, heuristic_candidate_limit_files). Splitting
// CORPOCODE_ROUTER_TRIVIAL_EARLY_EXIT on "_" would never reconstruct router.trivial_early_exit.
// Instead we enumerate the *known* leaf paths already present in the (defaults-filled) config,
// generate each leaf's canonical env name, and match env vars against that exact set. The
// mapping is therefore unambiguous and underscore-safe; only existing leaves can be overridden.

export interface AppliedOverride {
  envVar: string;
  path: string[];
  value: unknown;
}

export interface OverrideResult<T> {
  config: T;
  applied: AppliedOverride[];
}

const PREFIX = "CORPOCODE_";

/** The canonical env var name for a config leaf path, e.g. ["providers","cheap_local","model"] → CORPOCODE_PROVIDERS_CHEAP_LOCAL_MODEL. */
function envNameForPath(path: string[]): string {
  return PREFIX + path.map((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, "_")).join("_");
}

function isLeaf(value: unknown): boolean {
  return value === null || typeof value !== "object"; // arrays count as leaves (set wholesale)
}

/** Walk the object, recording env-name → path for every leaf. First writer wins on collision. */
function collectLeafPaths(node: unknown, path: string[], out: Map<string, string[]>): void {
  if (Array.isArray(node) || isLeaf(node)) {
    const name = envNameForPath(path);
    if (!out.has(name)) out.set(name, path);
    return;
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    collectLeafPaths(child, [...path, key], out);
  }
}

function getAt(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setAt(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

/**
 * Coerce a raw string env value to the JS type of the leaf it overrides. A value that cannot
 * be coerced is left as the raw string, which then fails Zod validation with a clear error —
 * preferable to silently accepting a malformed override.
 */
function coerce(current: unknown, raw: string): unknown {
  if (typeof current === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    return raw;
  }
  if (typeof current === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (Array.isArray(current)) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON — fall through to comma split
    }
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return raw; // string / null / undefined leaf
}

/**
 * Apply CORPOCODE_* overrides onto a defaults-filled config object. Returns a new object
 * (the input is not mutated) plus the list of overrides applied, for observability and tests.
 */
export function applyEnvOverrides<T extends Record<string, unknown>>(
  base: T,
  env: NodeJS.ProcessEnv = process.env,
): OverrideResult<T> {
  const out = structuredClone(base);
  const leafByEnv = new Map<string, string[]>();
  collectLeafPaths(out, [], leafByEnv);

  const applied: AppliedOverride[] = [];
  for (const [envVar, raw] of Object.entries(env)) {
    if (!envVar.startsWith(PREFIX) || raw === undefined) continue;
    if (envVar === "CORPOCODE_HOME") continue; // resolved in paths.ts; not a config leaf
    const path = leafByEnv.get(envVar);
    if (!path) continue;
    const value = coerce(getAt(out, path), raw);
    setAt(out, path, value);
    applied.push({ envVar, path, value });
  }
  return { config: out, applied };
}
