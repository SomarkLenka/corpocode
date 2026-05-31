// The deterministic heart of the toolbox: enumerate the user's/project's/plugins' skills & agents,
// back up each original, rewrite its description in place to a gating line, and record the original in
// the catalog. No LLM — pure file work — so it's cheap enough to re-run every session start, which is
// what makes the plugin-cache case self-healing (a `/plugin update` re-installs un-gated originals; the
// next run re-gates them). Idempotent (the `corpocode_gated` marker), reversible (the backup), and
// best-effort per file (one bad file never aborts the rest).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  claudeAgentsDir,
  claudePluginsDir,
  claudeSkillsDir,
  projectClaudeAgentsDir,
  projectClaudeSkillsDir,
} from "../install/claude-paths";
import { applyGate, parseToolboxFrontmatter } from "./frontmatter";
import { loadCatalog, writeCatalog } from "./catalog";
import type { ToolboxCatalog, ToolboxEntry, ToolboxKind, ToolboxScope } from "./types";

function gatingText(kind: ToolboxKind): string {
  return (
    `Use ONLY when CorpoCode (middle-management) names this ${kind} by name, or when the user explicitly ` +
    `asks for it by name. Do not self-select based on the task — CorpoCode decides relevance and injects ` +
    `the request with context.`
  );
}

export interface RootSpec {
  dir: string;
  scope: ToolboxScope;
  kind: ToolboxKind;
  id: string; // disambiguates backups across scopes/plugins (e.g. "user", "project", "<mkt>__<plugin>")
}

/** The files under a root: agents are flat .md files, skills are subdir/SKILL.md. */
function entryFiles(root: RootSpec): string[] {
  try {
    if (root.kind === "agent") {
      return readdirSync(root.dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(root.dir, f));
    }
    return readdirSync(root.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root.dir, d.name, "SKILL.md"))
      .filter((p) => existsSync(p));
  } catch {
    return []; // a missing dir is normal
  }
}

/** Every plugin's agents/skills dirs under the plugin cache, skipping CorpoCode's own plugin. */
export function findPluginRoots(pluginsDir: string): RootSpec[] {
  const cache = join(pluginsDir, "cache");
  const roots: RootSpec[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (/corpocode/i.test(e.name)) continue; // never gate our own plugin
      const full = join(dir, e.name);
      if (e.name === "agents" || e.name === "skills") {
        const id = (relative(cache, dir).replace(/[\\/]+/g, "__") || "plugin").toLowerCase();
        roots.push({ dir: full, scope: "plugin", kind: e.name === "agents" ? "agent" : "skill", id });
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(cache, 0);
  return roots;
}

export function defaultRoots(opts: { claudeHome: string; repoRoot?: string; includePlugins: boolean }): RootSpec[] {
  const roots: RootSpec[] = [
    { dir: claudeAgentsDir(opts.claudeHome), scope: "user", kind: "agent", id: "user" },
    { dir: claudeSkillsDir(opts.claudeHome), scope: "user", kind: "skill", id: "user" },
  ];
  if (opts.repoRoot) {
    roots.push({ dir: projectClaudeAgentsDir(opts.repoRoot), scope: "project", kind: "agent", id: "project" });
    roots.push({ dir: projectClaudeSkillsDir(opts.repoRoot), scope: "project", kind: "skill", id: "project" });
  }
  if (opts.includePlugins) roots.push(...findPluginRoots(claudePluginsDir(opts.claudeHome)));
  return roots;
}

function deriveName(file: string, kind: ToolboxKind): string {
  const parts = file.split(/[\\/]/);
  return kind === "agent" ? (parts.at(-1) ?? "agent").replace(/\.md$/i, "") : parts.at(-2) ?? "skill";
}

/** Where a root's file is backed up: `<id>/<agents|skills>/<path-within-root>`. */
function backupRelOf(root: RootSpec, file: string): string {
  return join(root.id, root.kind === "agent" ? "agents" : "skills", relative(root.dir, file)).replace(/\\/g, "/");
}

export interface GateDeps {
  roots: RootSpec[];
  restoreDir: string;
  catalogPath: string;
  readFile?: (p: string) => string;
  writeFile?: (p: string, c: string) => void;
  copyFile?: (src: string, dst: string) => void;
}

export interface GateSummary {
  gated: number;
  skipped: number;
  catalog: ToolboxCatalog;
}

export function gateToolbox(deps: GateDeps): GateSummary {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const write = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const copy =
    deps.copyFile ??
    ((s: string, d: string) => {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    });

  const byPath = new Map<string, ToolboxEntry>(loadCatalog(deps.catalogPath).entries.map((e) => [e.absPath, e]));
  let gated = 0;
  let skipped = 0;

  for (const root of deps.roots) {
    for (const file of entryFiles(root)) {
      try {
        const text = read(file);
        const fm = parseToolboxFrontmatter(text);
        if (!fm.hasFrontmatter || fm.gated) {
          skipped++;
          continue;
        }
        const result = applyGate(text, gatingText(root.kind));
        if (!result) {
          skipped++;
          continue;
        }
        const backupRel = backupRelOf(root, file);
        copy(file, join(deps.restoreDir, backupRel)); // back up the original BEFORE rewriting
        write(file, result.text);
        byPath.set(file, {
          kind: root.kind,
          name: fm.name ?? deriveName(file, root.kind),
          scope: root.scope,
          absPath: file,
          description: result.originalDescription,
          backupRel,
          ...(fm.model ? { model: fm.model } : {}),
        });
        gated++;
      } catch {
        skipped++; // a bad file never aborts the rest
      }
    }
  }

  const catalog: ToolboxCatalog = { entries: [...byPath.values()] };
  writeCatalog(deps.catalogPath, catalog);
  return { gated, skipped, catalog };
}

export interface RestoreDeps {
  restoreDir: string;
  catalogPath: string;
  copyFile?: (src: string, dst: string) => void;
}

/** Copy every backed-up original back over its gated file (uninstall). Returns how many were restored. */
export function restoreToolbox(deps: RestoreDeps): { restored: number } {
  const copy =
    deps.copyFile ??
    ((s: string, d: string) => {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    });
  let restored = 0;
  for (const e of loadCatalog(deps.catalogPath).entries) {
    if (!e.backupRel) continue;
    const backup = join(deps.restoreDir, e.backupRel);
    try {
      if (existsSync(backup)) {
        copy(backup, e.absPath);
        restored++;
      }
    } catch {
      // best-effort restore
    }
  }
  return { restored };
}
