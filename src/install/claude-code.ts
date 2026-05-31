// The npm channel's Claude Code installer: write one shim per hook event, register them in
// settings.json (JSON-rewrite, never text-edit), and copy the haiku-helper agent and
// corpocode-router/setup skills from the package into Claude Code's directories. Idempotent and
// honors --dry-run.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../config/paths";
import {
  claudeAgentsDir,
  claudeHooksDir,
  claudeSettingsFile,
  claudeSkillsDir,
} from "./claude-paths";
import { HOOK_SPECS, registerHooks, type Settings } from "./settings";

export interface ClaudeInstallOptions {
  claudeHome: string;
  assetsRoot: string; // package root containing agents/ and skills/
  platform?: NodeJS.Platform;
  binCommand?: string; // command the shim runs; defaults to the global `corpocode`
  dryRun?: boolean;
}

export interface InstallChange {
  action: string;
  path: string;
}

export interface InstallResult {
  changes: InstallChange[];
  applied: boolean;
  settingsPath: string;
}

const SKILLS = ["corpocode-router", "corpocode-setup"];

function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return fallback;
  }
}

export function installClaudeCode(opts: ClaudeInstallOptions): InstallResult {
  const platform = opts.platform ?? process.platform;
  const binCommand = opts.binCommand ?? "corpocode";
  const dryRun = opts.dryRun ?? false;
  const changes: InstallChange[] = [];

  const hooksDir = claudeHooksDir(opts.claudeHome);
  const agentsDir = claudeAgentsDir(opts.claudeHome);
  const skillsDir = claudeSkillsDir(opts.claudeHome);
  const settingsPath = claudeSettingsFile(opts.claudeHome);

  const isWin = platform === "win32";
  const ext = isWin ? "ps1" : "sh";
  const shimPath = (name: string): string => join(hooksDir, `corpocode-${name}.${ext}`);
  const shimBody = (name: string): string =>
    isWin
      ? `# CorpoCode hook shim — pipes stdin to the dispatcher.\r\n${binCommand} hook ${name}\r\n`
      : `#!/usr/bin/env bash\n# CorpoCode hook shim — pipes stdin to the dispatcher.\nexec ${binCommand} hook ${name}\n`;
  const commandFor = (name: string): string =>
    isWin ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${shimPath(name)}"` : shimPath(name);

  // 1. Shims.
  for (const spec of HOOK_SPECS) {
    const path = shimPath(spec.name);
    changes.push({ action: "write hook shim", path });
    if (!dryRun) {
      ensureDir(hooksDir);
      writeFileSync(path, shimBody(spec.name));
      if (!isWin) {
        try {
          chmodSync(path, 0o755);
        } catch {
          // best effort; non-POSIX filesystems may not support the mode
        }
      }
    }
  }

  // 2. settings.json registration (parse → modify → rewrite).
  changes.push({ action: "register hooks in settings.json", path: settingsPath });
  if (!dryRun) {
    ensureDir(opts.claudeHome);
    const settings = readJsonOr<Settings>(settingsPath, {});
    writeFileSync(settingsPath, `${JSON.stringify(registerHooks(settings, commandFor), null, 2)}\n`);
  }

  // 3. Agent.
  const agentDst = join(agentsDir, "haiku-helper.md");
  changes.push({ action: "install agent", path: agentDst });
  if (!dryRun) {
    ensureDir(agentsDir);
    const src = join(opts.assetsRoot, "agents", "haiku-helper.md");
    if (existsSync(src)) copyFileSync(src, agentDst);
  }

  // 4. Skills.
  for (const skill of SKILLS) {
    const dstDir = join(skillsDir, skill);
    const dst = join(dstDir, "SKILL.md");
    changes.push({ action: "install skill", path: dst });
    if (!dryRun) {
      ensureDir(dstDir);
      const src = join(opts.assetsRoot, "skills", skill, "SKILL.md");
      if (existsSync(src)) copyFileSync(src, dst);
    }
  }

  return { changes, applied: !dryRun, settingsPath };
}
