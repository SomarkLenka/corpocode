#!/usr/bin/env node
// Standalone escape hatch: un-gate the skills/agents CorpoCode gated, WITHOUT needing the corpocode
// binary, its hooks, or a working install. CorpoCode's session-start gate rewrites every skill/agent
// `description:` to a boilerplate gating line and stamps `corpocode_gated: true`, backing the original
// up under ~/.corpocode/corpocode-restore and recording its original "when to use" in the toolbox
// catalog. This script reverses that: it restores each gated file to its pristine original (from the
// backup, or — if the backup is gone — by reconstructing from the catalog's recorded description),
// then SCANS the live ~/.claude tree, the project's .claude tree, and the plugin cache for any gated
// file it could not recover and REPORTS it for manual fixing rather than guessing.
//
// Dependency-free (Node ≥ 20 builtins only) and idempotent: a file that is already un-gated is left
// untouched. Honors the same env overrides as corpocode (CORPOCODE_HOME, CLAUDE_CONFIG_DIR) so it
// targets exactly the directories the gate wrote to.
//
//   node scripts/degate.mjs [--project <dir>] [--no-plugins] [--dry-run] [--json] [--help]
//
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

// ── paths (mirrors src/config/paths.ts + src/install/claude-paths.ts) ──────────────────────────────
const env = process.env;
const corpocodeHome = () => (env.CORPOCODE_HOME?.trim() ? env.CORPOCODE_HOME : join(homedir(), ".corpocode"));
const claudeHome = () => env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const restoreDir = () => join(corpocodeHome(), "corpocode-restore");
const catalogPath = () => join(corpocodeHome(), "toolbox-catalog.json");

// ── frontmatter (mirrors src/toolbox/frontmatter.ts; line-based, not a full YAML parse) ────────────
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY = /^([A-Za-z0-9_-]+):(.*)$/;

function splitEntries(block) {
  const entries = [];
  for (const line of block.split(/\r?\n/)) {
    const m = KEY.exec(line);
    if (m && !/^\s/.test(line)) entries.push({ key: m[1], lines: [line] });
    else if (entries.length) entries[entries.length - 1].lines.push(line);
    else entries.push({ key: "", lines: [line] });
  }
  return entries;
}

function isGated(text) {
  const m = FENCE.exec(text);
  if (!m) return false;
  return splitEntries(m[1]).some((e) => e.key === "corpocode_gated" && /:\s*true\s*$/.test(e.lines[0]));
}

/** Rebuild a gated file's frontmatter: drop the `corpocode_gated` marker and set the original
 *  description. Used only when the backup is gone but the catalog recorded the original. */
function reconstruct(text, originalDescription) {
  const m = FENCE.exec(text);
  if (!m) return null;
  const entries = splitEntries(m[1]).filter((e) => e.key !== "corpocode_gated");
  const desc = entries.find((e) => e.key === "description");
  if (desc) desc.lines = [`description: ${originalDescription}`];
  else entries.push({ key: "description", lines: [`description: ${originalDescription}`] });
  return `---\n${entries.flatMap((e) => e.lines).join("\n")}\n---\n${m[2] ?? ""}`;
}

// ── catalog ────────────────────────────────────────────────────────────────────────────────────────
function loadCatalog() {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath(), "utf8"));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

// ── live-tree discovery (mirrors gate.ts roots: user, project, plugin) ──────────────────────────────
function gatedFilesIn(dir, kind) {
  try {
    if (kind === "agent") {
      return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
    }
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name, "SKILL.md"))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

function findPluginFiles(pluginsDir) {
  const cache = join(pluginsDir, "cache");
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || /corpocode/i.test(e.name)) continue;
      const full = join(dir, e.name);
      if (e.name === "agents") files.push(...gatedFilesIn(full, "agent"));
      else if (e.name === "skills") files.push(...gatedFilesIn(full, "skill"));
      else walk(full, depth + 1);
    }
  };
  walk(cache, 0);
  return files;
}

function liveGatedFiles(project, includePlugins) {
  const home = claudeHome();
  const files = [
    ...gatedFilesIn(join(home, "agents"), "agent"),
    ...gatedFilesIn(join(home, "skills"), "skill"),
    ...gatedFilesIn(join(project, ".claude", "agents"), "agent"),
    ...gatedFilesIn(join(project, ".claude", "skills"), "skill"),
  ];
  if (includePlugins) files.push(...findPluginFiles(join(home, "plugins")));
  return files.filter((f) => {
    try {
      return isGated(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { project: process.cwd(), includePlugins: true, dryRun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") opts.project = argv[++i] ?? opts.project;
    else if (a === "--no-plugins") opts.includePlugins = false;
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

const HELP = `corpocode degate — restore CorpoCode-gated skills & agents back to their originals

Usage: node scripts/degate.mjs [options]

Options:
  --project <dir>   Project root whose .claude/ tree to include (default: cwd)
  --no-plugins      Skip the ~/.claude/plugins cache
  --dry-run, -n     Report what would change; write nothing
  --json            Emit the summary as JSON
  --help, -h        Show this help

Recovers each gated file from its backup (~/.corpocode/corpocode-restore), or from the
toolbox catalog's recorded original description if the backup is gone. Any gated file with
no recoverable original is left untouched and reported.

Env: CORPOCODE_HOME, CLAUDE_CONFIG_DIR (same overrides corpocode itself honors).`;

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const restored = []; // { path, via: 'backup' | 'catalog' }
  const alreadyClean = []; // gated never, or already un-gated
  const unrecoverable = []; // gated, no backup AND no catalog original
  const handled = new Set();

  // 1) Catalog-driven restore — authoritative: each entry knows its in-place path, its backup, and the
  //    original description. Prefer the backup (byte-faithful); fall back to reconstructing from the
  //    recorded description so a deleted backup doesn't cost us a recoverable file.
  for (const e of loadCatalog()) {
    const target = e.absPath;
    if (!target || handled.has(target)) continue;
    handled.add(target);
    let live;
    try {
      live = readFileSync(target, "utf8");
    } catch {
      continue; // file gone — nothing to restore
    }
    if (!isGated(live)) {
      alreadyClean.push(target);
      continue;
    }
    const backup = e.backupRel ? join(restoreDir(), e.backupRel) : "";
    if (backup && existsSync(backup)) {
      if (!opts.dryRun) copyFileSync(backup, target);
      restored.push({ path: target, via: "backup" });
    } else if (typeof e.description === "string" && e.description.length > 0) {
      const text = reconstruct(live, e.description);
      if (text) {
        if (!opts.dryRun) writeFile(target, text);
        restored.push({ path: target, via: "catalog" });
      } else {
        unrecoverable.push(target);
      }
    } else {
      unrecoverable.push(target);
    }
  }

  // 2) Scan the live trees for gated files the catalog never recorded (lost/corrupt catalog, or gated on
  //    another machine). These have no recoverable original — skip and report, per design.
  for (const f of liveGatedFiles(opts.project, opts.includePlugins)) {
    if (handled.has(f)) continue;
    handled.add(f);
    unrecoverable.push(f);
  }

  const summary = {
    dryRun: opts.dryRun,
    restored: restored.length,
    restoredFromBackup: restored.filter((r) => r.via === "backup").length,
    restoredFromCatalog: restored.filter((r) => r.via === "catalog").length,
    alreadyClean: alreadyClean.length,
    unrecoverable: unrecoverable.map((p) => {
      const rel = relative(opts.project, p);
      return rel && !rel.startsWith("..") ? rel : p; // absolute when the file is outside the project
    }),
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const verb = opts.dryRun ? "Would restore" : "Restored";
  console.log(
    `${verb} ${summary.restored} skill/agent file(s)` +
      ` (${summary.restoredFromBackup} from backup, ${summary.restoredFromCatalog} from catalog).`,
  );
  if (summary.alreadyClean) console.log(`${summary.alreadyClean} already un-gated; left untouched.`);
  if (summary.unrecoverable.length) {
    console.log(`\n${summary.unrecoverable.length} gated file(s) with no recoverable original — fix manually:`);
    for (const p of summary.unrecoverable) console.log(`  - ${p}`);
  }
  if (!summary.restored && !summary.unrecoverable.length && !summary.alreadyClean) {
    console.log("No gated skills or agents found. Nothing to do.");
  }
}

main();
