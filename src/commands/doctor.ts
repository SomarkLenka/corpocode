// `corpocode doctor` — ordered health checks, each with a concrete repair hint when red. Every
// check is injectable so the logic is testable without real network/process calls; the defaults
// implement the real probes. Because graphify and OpenViking are required (not optional), their
// absence is a red check, not a warning.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CorpoConfig } from "../config/schema";
import { loadConfig } from "../config/load";
import { ensureDir, memoryDir, secretsFile, corpocodeHome, projectKey } from "../config/paths";
import { buildRegistry } from "../providers/registry";
import { createOpenVikingAdapter } from "../backends/context/openviking-adapter";
import { claudeHome, claudePluginsDir, claudeSettingsFile } from "../install/claude-paths";
import { hasCorpocodeHooks, type Settings } from "../install/settings";
import { spawnRunner } from "../install/run";
import { discoverPlugins, type DiscoveredPlugin } from "../plugins/discover";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  repair?: string;
}

export interface ChannelState {
  npm: boolean;
  plugin: boolean;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  loadConfig?: () => CorpoConfig;
  secretsState?: () => "ok" | "absent" | "unreadable";
  pingProvider?: (config: CorpoConfig) => Promise<boolean>;
  channels?: () => ChannelState;
  graphifyVersion?: () => Promise<boolean>;
  graphPresent?: () => boolean;
  openvikingUp?: () => Promise<boolean>;
  pythonVersion?: () => Promise<string | null>;
  memoryWritable?: () => boolean;
  plugins?: () => DiscoveredPlugin[];
  nativeGraphBuilt?: () => boolean;
}

const REPAIR_INSTALL = "corpocode install --repair";
const REPAIR_PROVISION = "corpocode provision";

function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return fallback;
  }
}

function defaultSecretsState(env?: NodeJS.ProcessEnv): "ok" | "absent" | "unreadable" {
  const path = secretsFile(env);
  if (!existsSync(path)) return "absent";
  try {
    readFileSync(path, "utf8");
    return "ok";
  } catch {
    return "unreadable";
  }
}

function pluginInstalled(home: string): boolean {
  const root = claudePluginsDir(home);
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 3) return false;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.toLowerCase().includes("corpocode")) return true;
      if (e.isDirectory() && walk(join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(root, 0);
}

function defaultChannels(env?: NodeJS.ProcessEnv): ChannelState {
  const home = claudeHome(env);
  const settings = readJsonOr<Settings>(claudeSettingsFile(home), {});
  return { npm: hasCorpocodeHooks(settings), plugin: pluginInstalled(home) };
}

function defaultMemoryWritable(cwd?: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    const dir = memoryDir(cwd, env);
    ensureDir(dir);
    const probe = join(dir, ".doctor-probe");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function defaultPythonVersion(): Promise<string | null> {
  const res = await spawnRunner("python", ["--version"]);
  if (res.code !== 0) return null;
  return (res.stdout || res.stderr).trim() || "python";
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const env = deps.env;
  const checks: DoctorCheck[] = [];

  // 1. Config validates.
  let config: CorpoConfig | null = null;
  try {
    config = (deps.loadConfig ?? (() => loadConfig({ env })))();
    checks.push({ name: "config schema", status: "ok", detail: "valid" });
  } catch (err) {
    checks.push({
      name: "config schema",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      repair: REPAIR_INSTALL,
    });
  }

  // Telemetry banner — surfaced prominently whenever telemetry is enabled, so it is never silently on
  // (Phase 4 §2). Off is the default and stated plainly so a user can confirm no data leaves the machine.
  if (config) {
    checks.push(
      config.telemetry.enabled
        ? {
            name: "telemetry",
            status: "warn",
            detail: "ON — only whitelisted aggregate fields are sent; inspect with `corpocode telemetry preview`",
          }
        : { name: "telemetry", status: "ok", detail: "off — no data leaves this machine" },
    );
  }

  // 2. Secrets readable.
  const sec = (deps.secretsState ?? (() => defaultSecretsState(env)))();
  checks.push(
    sec === "ok"
      ? { name: "secrets", status: "ok", detail: "readable" }
      : sec === "absent"
        ? { name: "secrets", status: "warn", detail: "no secrets file — using environment variables" }
        : { name: "secrets", status: "fail", detail: "present but unreadable", repair: REPAIR_INSTALL },
  );

  // 3. Default provider reachable (genuine 1-token call).
  if (config) {
    const ping = deps.pingProvider ?? ((c: CorpoConfig) => buildRegistry(c, { env }).forComponent("router").ping());
    const up = await ping(config);
    checks.push(
      up
        ? { name: "provider reachable", status: "ok", detail: "1-token probe succeeded" }
        : {
            name: "provider reachable",
            status: "fail",
            detail: "default provider did not respond — check the API key / provider config",
            repair: REPAIR_INSTALL,
          },
    );
  } else {
    checks.push({ name: "provider reachable", status: "warn", detail: "skipped (config invalid)" });
  }

  // 4. Hook wiring + channel detection.
  const channels = (deps.channels ?? (() => defaultChannels(env)))();
  if (channels.npm && channels.plugin) {
    checks.push({
      name: "hook wiring",
      status: "warn",
      detail: "BOTH npm and plugin channels are active — every hook fires twice; remove one",
      repair: "corpocode uninstall (npm) or /plugin uninstall corpocode",
    });
  } else if (channels.npm) {
    checks.push({ name: "hook wiring", status: "ok", detail: "npm channel active" });
  } else if (channels.plugin) {
    checks.push({ name: "hook wiring", status: "ok", detail: "plugin channel active" });
  } else {
    checks.push({ name: "hook wiring", status: "fail", detail: "not installed in Claude Code", repair: "corpocode install" });
  }

  // 5–7. Backend health — conditional on which backends the config selects (Phase 5). The native
  // backends are in-process (no daemon, no Python); the Python-backed adapters and the Python toolchain
  // check run ONLY when explicitly selected, so a default native install shows no Python/daemon checks.
  const kg = config?.backends.knowledgeGraph ?? "native";
  const cs = config?.backends.contextStore ?? "native";

  if (kg === "graphify") {
    const graphifyOk = await (deps.graphifyVersion ?? (async () => (await spawnRunner("graphify", ["--version"])).code === 0))();
    const graphPresent = (deps.graphPresent ?? (() => existsSync(join(deps.repoRoot ?? process.cwd(), "graphify-out", "graph.json"))))();
    if (!graphifyOk) {
      checks.push({ name: "graphify", status: "fail", detail: "graphify CLI not found on PATH", repair: REPAIR_PROVISION });
    } else if (!graphPresent) {
      checks.push({ name: "graphify", status: "warn", detail: "installed, but no graph built yet", repair: REPAIR_PROVISION });
    } else {
      checks.push({ name: "graphify", status: "ok", detail: "CLI present and graph built" });
    }
  } else {
    const built = (deps.nativeGraphBuilt ??
      (() => existsSync(join(corpocodeHome(env), "graphs", `${projectKey(deps.repoRoot ?? process.cwd())}.json`))))();
    checks.push({
      name: "knowledge graph",
      status: "ok",
      detail: built ? "native (built)" : "native (in-process; builds on first use)",
    });
  }

  if (cs === "openviking") {
    const ovUp = await (deps.openvikingUp ?? (async () => (await createOpenVikingAdapter().health()).up))();
    checks.push(
      ovUp
        ? { name: "openviking", status: "ok", detail: "daemon healthy on :1933" }
        : { name: "openviking", status: "fail", detail: "daemon unreachable on :1933", repair: REPAIR_PROVISION },
    );
  } else {
    checks.push({ name: "context store", status: "ok", detail: "native (in-process database)" });
  }

  if (kg === "graphify" || cs === "openviking") {
    const py = await (deps.pythonVersion ?? defaultPythonVersion)();
    checks.push(
      py
        ? { name: "python toolchain", status: "ok", detail: py }
        : { name: "python toolchain", status: "fail", detail: "python not found", repair: "install Python 3.10+" },
    );
  }

  // 8. Memory dir writable (project-local under the repo's .corpocode).
  const repoRoot = deps.repoRoot ?? process.cwd();
  const memOk = (deps.memoryWritable ?? (() => defaultMemoryWritable(repoRoot, env)))();
  checks.push(
    memOk
      ? { name: "memory dir", status: "ok", detail: "writable" }
      : { name: "memory dir", status: "fail", detail: `not writable: ${memoryDir(repoRoot, env)}`, repair: REPAIR_INSTALL },
  );

  // 9. Plugins — transparency: list every discovered plugin and what it contributes, so the user can
  // always see exactly what is extending their CorpoCode (Phase 4 §3).
  const plugins = (deps.plugins ?? (() => discoverPlugins()))();
  if (plugins.length === 0) {
    checks.push({ name: "plugins", status: "ok", detail: "none discovered" });
  } else {
    const summary = plugins
      .map((p) => `${p.name} (${(p.plugin.templates?.length ?? 0)} template(s), ${(p.plugin.tenets?.length ?? 0)} tenet(s))`)
      .join("; ");
    checks.push({ name: "plugins", status: "ok", detail: `${plugins.length} discovered — ${summary}` });
  }

  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

export async function runDoctorCommand(_argv: string[]): Promise<void> {
  const checks = await runDoctor();
  for (const c of checks) {
    process.stdout.write(`${MARK[c.status]} ${c.name}: ${c.detail}\n`);
    if (c.status === "fail" && c.repair) process.stdout.write(`    ↳ repair: ${c.repair}\n`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  process.stdout.write(`\n${failed === 0 ? "All required checks passed." : `${failed} check(s) failed.`}\n`);
  if (failed > 0) process.exitCode = 1;
}
