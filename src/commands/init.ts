// `corpocode init` — scaffold a default config and a secrets file with key PLACEHOLDERS, so a
// plugin-only user (no global npm CLI) can self-provision from within Claude Code via the bundled
// binary. It NEVER overwrites an existing config or secrets without --force, so real keys are safe.
// The user edits the placeholder to their real key — or sets the matching env var, which wins over the
// file. CorpoCode can scaffold everything around the key; it cannot invent the credential itself.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { cwd } from "node:process";
import { catalogFile, configFile, corpocodeHome, ensureDir, secretsFile, toolboxRestoreDir } from "../config/paths";
import { defaultConfig, loadConfig } from "../config/load";
import { conventionalEnvKey } from "../config/secrets";
import { claudeHome } from "../install/claude-paths";
import { defaultRoots, gateToolbox } from "../toolbox/gate";

function placeholderFor(key: string): string {
  return `REPLACE_WITH_YOUR_${key}`;
}

/** The conventional env-key names for every keyed provider the default config references. */
export function defaultKeyNames(): string[] {
  const names = new Set<string>();
  for (const p of Object.values(defaultConfig().providers)) {
    const k = conventionalEnvKey(p.kind);
    if (k) names.add(k);
  }
  return [...names];
}

/** Render the secrets file body (comments are ignored by the secrets parser). With no keyed providers
 *  — the default `anthropic-cli` needs none — it writes guidance instead of a placeholder. */
export function renderSecretsTemplate(keys: string[]): string {
  const header = [
    "# CorpoCode secrets. Replace each placeholder with your real key — or set the matching",
    "# environment variable instead (an env var takes precedence over this file).",
  ];
  if (keys.length === 0) {
    return [
      ...header,
      "#",
      "# The default provider (anthropic-cli) needs NO key — it uses your installed `claude` CLI login.",
      "# Add a key here only if you point a component at a keyed provider, e.g.:",
      "#   ANTHROPIC_API_KEY=...   OPENAI_API_KEY=...   GEMINI_API_KEY=...   OPENROUTER_API_KEY=...",
      "",
    ].join("\n");
  }
  return [...header, ...keys.map((k) => `${k}=${placeholderFor(k)}`), ""].join("\n");
}

export function runInitCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const force = argv.includes("--force");
  ensureDir(corpocodeHome(env));

  // config.json — defaults; never clobber an existing one unless --force.
  const cfgPath = configFile(env);
  if (existsSync(cfgPath) && !force) {
    process.stdout.write(`· config already exists, leaving it: ${cfgPath}\n`);
  } else {
    writeFileSync(cfgPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
    process.stdout.write(`wrote default config: ${cfgPath}\n`);
  }

  // secrets — placeholders; NEVER overwrite an existing secrets file unless --force (it may hold real keys).
  const keys = defaultKeyNames();
  const secPath = secretsFile(env);
  if (existsSync(secPath) && !force) {
    process.stdout.write(`· secrets already exists, not touching it: ${secPath}\n`);
  } else {
    writeFileSync(secPath, renderSecretsTemplate(keys), { mode: 0o600 });
    try {
      chmodSync(secPath, 0o600); // owner-only; best-effort on Windows where NTFS ACLs govern instead
    } catch {
      // POSIX modes don't apply on Windows
    }
    process.stdout.write(
      keys.length === 0
        ? `wrote secrets template (no key needed for the default anthropic-cli provider): ${secPath}\n`
        : `wrote secrets with placeholder(s): ${secPath}\n`,
    );
  }

  // Gate the user's/plugins' skills & agents (strip "when to use" from the main model's context, keep
  // them invocable, back up originals). Idempotent; --no-gate skips. Best-effort.
  if (!argv.includes("--no-gate")) {
    try {
      const tb = loadConfig({ env }).toolbox;
      if (tb.enabled) {
        const summary = gateToolbox({
          roots: defaultRoots({ claudeHome: claudeHome(env), repoRoot: cwd(), includePlugins: tb.gate_plugins }),
          restoreDir: toolboxRestoreDir(env),
          catalogPath: catalogFile(env),
        });
        process.stdout.write(
          `gated ${summary.gated} skill/agent description(s) (${summary.skipped} already gated). ` +
            `Originals backed up to ${toolboxRestoreDir(env)} (restored on uninstall).\n`,
        );
      }
    } catch {
      // gating is best-effort — never fail init over it
    }
  }

  if (keys.length === 0) {
    process.stdout.write(
      "\nThe default provider (anthropic-cli) uses your installed `claude` CLI login — no API key needed. " +
        "Then run `corpocode doctor` to verify.\n",
    );
    return;
  }
  const plural = keys.length === 1 ? "" : "s";
  process.stdout.write(
    `\nNext: open ${secPath} and replace the placeholder${plural} with your real key${plural}:\n` +
      keys.map((k) => `  ${k}=<your real key>`).join("\n") +
      `\n(or set ${keys.length === 1 ? "it" : "them"} as environment variable${plural} instead). ` +
      "Then run `corpocode doctor` to verify.\n",
  );
}
