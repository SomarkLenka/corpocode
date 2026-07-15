// Slopsquatting defense: deterministic manifest-diff scan, no model call. Policy is strict —
// a new dependency is a durable consequence, so any non-allowlisted addition blocks the
// candidate; the optional registry check only sharpens the reason (missing vs merely new).
export interface NewDep {
  file: string;
  name: string;
  version?: string;
}

export type DepVerdict = "allowlisted" | "not-allowlisted" | "not-in-registry";

export interface DepFinding extends NewDep {
  verdict: DepVerdict;
}

const MANIFEST = /(^|\/)package\.json$/;
// An added `"name": "version-ish"` line — version starts with a digit, ^, ~, *, or "latest".
const DEP_LINE = /^\+\s*"(@?[a-z0-9][\w./-]*)"\s*:\s*"([~^]?\d[^"]*|\*|latest)"/i;

export function extractNewDeps(diff: string): NewDep[] {
  const deps: NewDep[] = [];
  let file = "";
  let inManifest = false;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1]!;
      inManifest = MANIFEST.test(file);
      continue;
    }
    if (!inManifest) continue;
    const m = DEP_LINE.exec(line);
    if (m) deps.push({ file, name: m[1]!, version: m[2]! });
  }
  return deps;
}

export interface CheckDepsOptions {
  allowlist: Set<string>;
  registryCheck?: boolean;
  fetchFn?: typeof fetch;
  registryBase?: string; // default npm
}

export async function checkDeps(deps: NewDep[], opts: CheckDepsOptions): Promise<DepFinding[]> {
  const base = opts.registryBase ?? "https://registry.npmjs.org";
  const out: DepFinding[] = [];
  for (const dep of deps) {
    if (opts.allowlist.has(dep.name)) {
      out.push({ ...dep, verdict: "allowlisted" });
      continue;
    }
    let verdict: DepVerdict = "not-allowlisted";
    if (opts.registryCheck && opts.fetchFn) {
      try {
        const res = await opts.fetchFn(`${base}/${encodeURIComponent(dep.name)}`, { method: "GET" });
        if (res.status === 404) verdict = "not-in-registry";
      } catch {
        // registry unreachable: stay at not-allowlisted — an error must never approve
      }
    }
    out.push({ ...dep, verdict });
  }
  return out;
}

/** The default allowlist: everything the repo already depends on. */
export function allowlistFromPackageJson(packageJsonText: string): Set<string> {
  try {
    const pkg = JSON.parse(packageJsonText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}
