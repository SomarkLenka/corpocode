// CLI handlers for `corpocode install`, `corpocode provision`, and `corpocode uninstall`. Thin
// orchestration over the install/provision modules; all the real logic lives there.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { catalogFile, configFile, corpocodeHome, ensureDir, secretsFile, toolboxRestoreDir } from "../config/paths";
import { restoreToolbox } from "../toolbox/gate";
import { defaultConfig, loadConfig } from "../config/load";
import { saveSecrets } from "../config/secrets";
import { installClaudeCode } from "../install/claude-code";
import { claudeHome, claudeHooksDir, claudeSettingsFile } from "../install/claude-paths";
import { packageRoot } from "../install/locate";
import { provision, type ProvisionReport } from "../install/provision";
import { HOOK_SPECS, unregisterHooks, type Settings } from "../install/settings";
import { installPlatform, type InstallChange, type PlatformAdapter } from "../install/platform";
import { detectPlatforms, getPlatformAdapter, PLATFORM_ADAPTERS } from "../install/platform-registry";
import { join } from "node:path";

interface Flags {
  platform: string;
  all: boolean;
  dryRun: boolean;
  skipBackends: boolean;
  repair: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { platform: "claude-code", all: false, dryRun: false, skipBackends: false, repair: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--platform") flags.platform = argv[++i] ?? flags.platform;
    else if (a === "--all") flags.all = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--skip-backends") flags.skipBackends = true;
    else if (a === "--repair") flags.repair = true;
  }
  return flags;
}

function printInstall(label: string, changes: InstallChange[], dryRun: boolean): void {
  process.stdout.write(`${dryRun ? "[dry-run] would install" : "Installed"} CorpoCode into ${label}:\n`);
  for (const change of changes) process.stdout.write(`  - ${change.action}: ${change.path}\n`);
}

/** Write a default config + an empty 0600 secrets file if absent, so the system has a valid base. */
function ensureBaseState(dryRun: boolean): void {
  if (dryRun) return;
  ensureDir(corpocodeHome());
  if (!existsSync(configFile())) {
    writeFileSync(configFile(), `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  }
  if (!existsSync(secretsFile())) {
    saveSecrets({});
  }
}

function printProvision(report: ProvisionReport): void {
  if (!report.graphify && !report.openviking) {
    // Native backends selected (the default since Phase 5): nothing external to provision.
    process.stdout.write("\nNative backends selected — no external toolchain to provision.\n");
    return;
  }
  for (const result of [report.graphify, report.openviking]) {
    if (!result) continue;
    process.stdout.write(`\n${result.component}: ${result.ok ? "ok" : "incomplete"}\n`);
    for (const step of result.steps) {
      const mark = step.skipped ? "·" : step.ok ? "✓" : "✗";
      process.stdout.write(`  ${mark} ${step.name} — ${step.detail}\n`);
    }
  }
}

/** One platform's install, routing Claude Code through its canonical installer and the rest through
 *  the generic adapter-driven path. */
function installOne(adapter: PlatformAdapter, dryRun: boolean): void {
  if (adapter.id === "claude-code") {
    const result = installClaudeCode({ claudeHome: claudeHome(), assetsRoot: packageRoot(), dryRun });
    printInstall("Claude Code", result.changes, dryRun);
    return;
  }
  const result = installPlatform(adapter, { env: process.env, assetsRoot: packageRoot(), dryRun });
  printInstall(adapter.id, result.changes, dryRun);
  process.stdout.write(`  (hook events supported: ${result.events.join(", ")})\n`);
}

export async function runInstallCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  ensureBaseState(flags.dryRun);

  let adapters: PlatformAdapter[];
  if (flags.all) {
    adapters = detectPlatforms();
    if (adapters.length === 0) {
      adapters = [PLATFORM_ADAPTERS["claude-code"]];
      process.stdout.write("No coding-agent platforms detected; defaulting to Claude Code.\n");
    }
  } else {
    const adapter = getPlatformAdapter(flags.platform);
    if (!adapter) {
      process.stderr.write(
        `corpocode install: unknown platform "${flags.platform}". Known: ${Object.keys(PLATFORM_ADAPTERS).join(", ")}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    adapters = [adapter];
  }

  for (const adapter of adapters) installOne(adapter, flags.dryRun);

  if (flags.skipBackends) {
    process.stdout.write("\nSkipped backend provisioning (--skip-backends). Run `corpocode provision` later.\n");
    return;
  }

  const config = flags.dryRun ? defaultConfig() : loadConfig();
  const report = await provision(config, { repoRoot: process.cwd(), dryRun: flags.dryRun });
  printProvision(report);
}

export async function runProvisionCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  ensureBaseState(flags.dryRun);
  const config = flags.dryRun ? defaultConfig() : loadConfig();
  const report = await provision(config, { repoRoot: process.cwd(), dryRun: flags.dryRun });
  printProvision(report);
}

export async function runUninstallCommand(argv: string[]): Promise<void> {
  const purge = argv.includes("--purge");
  const home = claudeHome();

  // Remove shims.
  const hooksDir = claudeHooksDir(home);
  const ext = process.platform === "win32" ? "ps1" : "sh";
  for (const spec of HOOK_SPECS) {
    const shim = join(hooksDir, `corpocode-${spec.name}.${ext}`);
    if (existsSync(shim)) rmSync(shim, { force: true });
  }

  // Unregister hooks from settings.json.
  const settingsPath = claudeSettingsFile(home);
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^﻿/, "")) as Settings;
      writeFileSync(settingsPath, `${JSON.stringify(unregisterHooks(settings), null, 2)}\n`);
    } catch {
      // leave settings untouched if unparseable
    }
  }

  process.stdout.write("Removed CorpoCode shims and unregistered its hooks from Claude Code.\n");

  // Restore every skill/agent CorpoCode gated back to its original "when to use" (before any purge,
  // which deletes the backup).
  try {
    const { restored } = restoreToolbox({ restoreDir: toolboxRestoreDir(), catalogPath: catalogFile() });
    if (restored > 0) process.stdout.write(`Restored ${restored} skill/agent description(s) to their originals.\n`);
  } catch {
    // best-effort restore
  }

  if (purge) {
    rmSync(corpocodeHome(), { recursive: true, force: true });
    process.stdout.write(`Purged ${corpocodeHome()} (config, logs, memory).\n`);
  }
}
