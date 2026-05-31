// The platform-adapter seam. Almost everything CorpoCode does is platform-agnostic and lives behind
// `corpocode hook <name>`; the only genuinely platform-specific work is installation and
// registration. This module defines the one small abstraction that absorbs the differences — which
// hook events a platform can fire, where its shims live, how its settings are registered, and how
// its response envelope is shaped — and a generic installer that drives any adapter.
//
// Graceful degradation is built in: an adapter declares only the events its platform can fire, and
// the installer wires exactly that subset. A platform without a PreToolUse equivalent simply doesn't
// get the injector or the filter's teeth — a coherent, useful install, never a failure.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../config/paths";
import type { HookResponse } from "../hooks/response";
import { serializeForPlatform, type PlatformId } from "../hooks/platform-output";

export type { PlatformId };
export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SubagentStart" | "SessionStart";

export interface PlatformPaths {
  home: string;
  settingsFile: string;
  shimDir: string;
}

export interface RegisterContext {
  events: HookEvent[];
  commandFor: (event: HookEvent) => string;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  detect(env: NodeJS.ProcessEnv): boolean; // is this platform installed on the machine?
  hookEvents(): HookEvent[]; // the subset of our events this platform can fire
  paths(env: NodeJS.ProcessEnv): PlatformPaths;
  register(settings: Record<string, unknown>, ctx: RegisterContext): Record<string, unknown>;
  unregister(settings: Record<string, unknown>): Record<string, unknown>;
  responseEnvelope(out: HookResponse): string;
  assets(): { agents: string[]; skills: string[] };
}

// --- JSON-hooks settings registration (parse → modify → write; never text-edit) ---

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

/** A hook group is ours if any of its commands references the corpocode binary/shim. */
function isCorpocodeGroup(group: HookGroup): boolean {
  return (
    !!group &&
    Array.isArray(group.hooks) &&
    group.hooks.some((h) => typeof h?.command === "string" && h.command.includes("corpocode"))
  );
}

export interface HookSpec {
  event: HookEvent;
  matcher?: string;
}

/** Register our hooks into a JSON `hooks` map, replacing (not duplicating) any prior corpocode group. */
export function registerJsonHooks(
  settings: Record<string, unknown>,
  specs: HookSpec[],
  commandFor: (event: HookEvent) => string,
): Record<string, unknown> {
  const existing = (settings.hooks as Record<string, HookGroup[]> | undefined) ?? {};
  const hooks: Record<string, HookGroup[]> = { ...existing };
  for (const spec of specs) {
    const preserved = (hooks[spec.event] ?? []).filter((g) => !isCorpocodeGroup(g));
    const group: HookGroup = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: commandFor(spec.event) }],
    };
    hooks[spec.event] = [...preserved, group];
  }
  return { ...settings, hooks };
}

export function unregisterJsonHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const existing = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (!existing) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(existing)) {
    const preserved = groups.filter((g) => !isCorpocodeGroup(g));
    if (preserved.length) hooks[event] = preserved;
  }
  return { ...settings, hooks };
}

// --- Adapter factory (data-driven; the five adapters differ only in their config) ---

export interface AdapterConfig {
  id: PlatformId;
  homeEnvVar?: string; // env var that overrides the platform's home dir
  homeSubdir: string; // e.g. ".codex"
  settingsRel: string; // settings file relative to home, e.g. "hooks.json"
  shimSubdir: string; // shim dir relative to home, e.g. "hooks"
  specs: HookSpec[]; // the events (and matchers) this platform supports
  agents: string[];
  skills: string[];
}

export function makeAdapter(cfg: AdapterConfig): PlatformAdapter {
  const home = (env: NodeJS.ProcessEnv): string => {
    const override = cfg.homeEnvVar ? env[cfg.homeEnvVar] : undefined;
    return override && override.trim() ? override : join(homedir(), cfg.homeSubdir);
  };
  return {
    id: cfg.id,
    detect: (env) => existsSync(home(env)),
    hookEvents: () => cfg.specs.map((s) => s.event),
    paths: (env) => ({ home: home(env), settingsFile: join(home(env), cfg.settingsRel), shimDir: join(home(env), cfg.shimSubdir) }),
    register: (settings, ctx) =>
      registerJsonHooks(settings, cfg.specs.filter((s) => ctx.events.includes(s.event)), ctx.commandFor),
    unregister: (settings) => unregisterJsonHooks(settings),
    responseEnvelope: (out) => serializeForPlatform(out, cfg.id),
    assets: () => ({ agents: cfg.agents, skills: cfg.skills }),
  };
}

// --- Generic installer (drives any adapter) ---

export interface InstallChange {
  action: string;
  path: string;
}
export interface PlatformInstallResult {
  platform: PlatformId;
  changes: InstallChange[];
  applied: boolean;
  settingsFile: string;
  events: HookEvent[];
}
export interface PlatformInstallOptions {
  env: NodeJS.ProcessEnv;
  assetsRoot: string;
  binCommand?: string;
  dryRun?: boolean;
  os?: NodeJS.Platform;
}

function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return fallback;
  }
}

export function installPlatform(adapter: PlatformAdapter, opts: PlatformInstallOptions): PlatformInstallResult {
  const os = opts.os ?? process.platform;
  const binCommand = opts.binCommand ?? "corpocode";
  const dryRun = opts.dryRun ?? false;
  const events = adapter.hookEvents();
  const { home, settingsFile, shimDir } = adapter.paths(opts.env);
  const changes: InstallChange[] = [];

  const isWin = os === "win32";
  const ext = isWin ? "ps1" : "sh";
  const shimPath = (e: HookEvent): string => join(shimDir, `corpocode-${e}.${ext}`);
  const shimBody = (e: HookEvent): string =>
    isWin
      ? `# CorpoCode hook shim — pipes stdin to the dispatcher.\r\n${binCommand} hook ${e} --platform ${adapter.id}\r\n`
      : `#!/usr/bin/env bash\n# CorpoCode hook shim — pipes stdin to the dispatcher.\nexec ${binCommand} hook ${e} --platform ${adapter.id}\n`;
  const commandFor = (e: HookEvent): string =>
    isWin ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${shimPath(e)}"` : shimPath(e);

  // 1. Shims — only for the events this platform can fire (graceful degradation).
  for (const e of events) {
    const p = shimPath(e);
    changes.push({ action: "write hook shim", path: p });
    if (!dryRun) {
      ensureDir(shimDir);
      writeFileSync(p, shimBody(e));
      if (!isWin) {
        try {
          chmodSync(p, 0o755);
        } catch {
          // best effort; non-POSIX filesystems may not support the mode
        }
      }
    }
  }

  // 2. Settings registration (parse → modify → write).
  changes.push({ action: "register hooks", path: settingsFile });
  if (!dryRun) {
    ensureDir(home);
    const updated = adapter.register(readJsonOr<Record<string, unknown>>(settingsFile, {}), { events, commandFor });
    writeFileSync(settingsFile, `${JSON.stringify(updated, null, 2)}\n`);
  }

  // 3. Assets the platform supports.
  const { agents, skills } = adapter.assets();
  for (const agent of agents) {
    const dst = join(home, "agents", `${agent}.md`);
    changes.push({ action: "install agent", path: dst });
    if (!dryRun) {
      ensureDir(join(home, "agents"));
      const src = join(opts.assetsRoot, "agents", `${agent}.md`);
      if (existsSync(src)) copyFileSync(src, dst);
    }
  }
  for (const skill of skills) {
    const dst = join(home, "skills", skill, "SKILL.md");
    changes.push({ action: "install skill", path: dst });
    if (!dryRun) {
      ensureDir(join(home, "skills", skill));
      const src = join(opts.assetsRoot, "skills", skill, "SKILL.md");
      if (existsSync(src)) copyFileSync(src, dst);
    }
  }

  return { platform: adapter.id, changes, applied: !dryRun, settingsFile, events };
}
