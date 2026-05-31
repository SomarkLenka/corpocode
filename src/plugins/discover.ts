// Convention-based plugin discovery (Phase 4 §3) — the same naming-discovery ESLint and Babel use.
// A package named `corpocode-template-*` or `corpocode-tenet-*` is found at startup, loaded, validated
// against the API generation, and registered. Two safety rules shape this: every load is fail-open (a
// plugin that throws or targets an incompatible apiVersion is SKIPPED, never fatal), and everything is
// injectable so discovery is testable offline without touching the real module resolver.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { CorpoPlugin, RetrievalTemplate } from "./types";

const PLUGIN_RE = /^corpocode-(?:template|tenet)-[a-z0-9._-]+$/i;

export interface DiscoveredPlugin {
  name: string;
  plugin: CorpoPlugin;
}

export interface DiscoverDeps {
  scanDirs?: string[]; // node_modules dirs to scan for plugin packages
  listPackages?: (dir: string) => string[]; // names in a node_modules dir matching the convention
  loader?: (name: string) => unknown; // import a package's default export
  log?: (msg: string) => void;
}

/** node_modules locations to scan: the project's, plus any on NODE_PATH. Global installs are
 * environment-dependent and resolved by the default loader's own require, not enumerated here. */
export function defaultScanDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [join(process.cwd(), "node_modules")];
  for (const p of (env.NODE_PATH ?? "").split(/[:;]/).filter(Boolean)) dirs.push(join(p));
  return dirs;
}

function defaultList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => PLUGIN_RE.test(n));
  } catch {
    return []; // a missing node_modules dir is normal, not an error
  }
}

function makeDefaultLoader(): (name: string) => unknown {
  const req = createRequire(join(process.cwd(), "index.js")); // resolve from the project's node_modules
  return (name: string) => {
    const mod = req(name) as { default?: unknown };
    return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
  };
}

/** Validate and normalize an exported value into a CorpoPlugin, or null if it is not a compatible one. */
export function validatePlugin(raw: unknown): CorpoPlugin | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<CorpoPlugin>;
  if (p.apiVersion !== 1) return null; // decline other API generations rather than load into incompatibility
  if (typeof p.name !== "string" || p.name.length === 0) return null;
  const out: CorpoPlugin = { apiVersion: 1, name: p.name };
  if (Array.isArray(p.templates)) out.templates = p.templates as RetrievalTemplate[];
  if (Array.isArray(p.tenets)) out.tenets = p.tenets;
  return out;
}

export function discoverPlugins(deps: DiscoverDeps = {}): DiscoveredPlugin[] {
  const dirs = deps.scanDirs ?? defaultScanDirs();
  const list = deps.listPackages ?? defaultList;
  const load = deps.loader ?? makeDefaultLoader();
  const log = deps.log ?? (() => {});

  const out: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of list(dir)) {
      if (seen.has(name)) continue; // a plugin found in two scan dirs loads once
      seen.add(name);
      try {
        const plugin = validatePlugin(load(name));
        if (!plugin) {
          log(`plugin ${name}: incompatible apiVersion or invalid shape; skipped`);
          continue;
        }
        out.push({ name, plugin });
      } catch {
        log(`plugin ${name} failed to load; skipped`); // fail-open: a broken plugin never crashes CorpoCode
      }
    }
  }
  return out;
}
