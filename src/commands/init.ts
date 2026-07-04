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
import { createTerminalInteractor } from "../interact/terminal";
import type { Interactor, Poll } from "../interact/types";

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

// ---------------------------------------------------------------------------------------------
// Orchestrator onboarding — the release gate on `corpocode start`. Three decisions belong to the
// user before the orchestrator may spend on their behalf: which strong model arbitrates, how
// granular the cockpit's polling is, and what a run may cost. Asked through the Interactor seam
// (its first consumer outside the cockpit); a dead/aborted interactor changes nothing.

const ARBITER_POLL: Poll = {
  id: "onboard-arbiter",
  concept: "arbiter-model",
  question: "Which strong model should verify the swarm's work (the arbiter — the only expensive role)?",
  options: [
    { id: "fable", label: "claude-fable-5 (recommended)", description: "The most capable judge; verdicts are output-capped so cost stays bounded.", findings: [], recommended: true },
    { id: "opus", label: "claude-opus-4", description: "Strong and cheaper per token.", findings: [] },
  ],
  allowFreeText: true, // any exact model id
  allowDelegate: false,
  defaultOptionId: "fable",
};

const GRANULARITY_POLL: Poll = {
  id: "onboard-granularity",
  concept: "poll-granularity",
  question: "How granular should the cockpit's interrogation be?",
  options: [
    { id: "every-fork", label: "every-fork", description: "Poll every decision fork — nothing left to interpretation (the correctness mechanism).", findings: [] },
    { id: "major-forks", label: "major-forks", description: "Poll architecture-shaping forks; minor ones auto-resolve to the interrogator's suggestion (recorded as delegated).", findings: [] },
    { id: "minimal", label: "minimal", description: "Only the final spec approval is asked; every fork auto-resolves (recorded).", findings: [] },
  ],
  allowFreeText: false,
  allowDelegate: false,
  defaultOptionId: "every-fork",
};

const BUDGET_POLL: Poll = {
  id: "onboard-budget",
  concept: "run-budget",
  question: "Cap each run's total model spend? (Breach pauses the run and asks — never silent.)",
  options: [
    { id: "cap10", label: "$10 per run", description: "Conservative; good first default.", findings: [] },
    { id: "cap25", label: "$25 per run", description: "Roomier for real features.", findings: [] },
    { id: "uncapped", label: "uncapped", description: "No ceiling — watchdog and turn limits still bound runaways.", findings: [] },
  ],
  allowFreeText: true, // a custom dollar amount
  allowDelegate: false,
  defaultOptionId: "cap10",
};

const MODEL_BY_OPTION: Record<string, string> = { fable: "claude-fable-5", opus: "claude-opus-4" };
const BUDGET_BY_OPTION: Record<string, number | null> = { cap10: 10, cap25: 25, uncapped: null };

export interface OnboardingDeps {
  interactor?: Interactor;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Run (or skip) the orchestrator onboarding after `corpocode init`'s scaffolding. Skips quietly
 *  when already onboarded (unless --force), when --no-orchestrator is passed, or when there is no
 *  TTY to ask through (CI scaffolds config non-interactively; `start --dev` remains the bypass). */
export async function runOrchestratorOnboarding(argv: string[], deps: OnboardingDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (argv.includes("--no-orchestrator")) return;

  let config;
  try {
    config = loadConfig({ env });
  } catch {
    return; // init already reported the config problem; onboarding cannot help
  }
  if (config.orchestrator.initialized && !argv.includes("--force")) {
    process.stdout.write("· orchestrator already onboarded (`corpocode start` is unlocked)\n");
    return;
  }
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  if (!deps.interactor && !isTTY) {
    process.stdout.write(
      "· skipped orchestrator onboarding (no terminal) — run `corpocode init` interactively to unlock `corpocode start`, or use `corpocode start --dev` for local testing\n",
    );
    return;
  }

  const interactor = deps.interactor ?? createTerminalInteractor();
  try {
    const arbiter = await interactor.ask(ARBITER_POLL);
    if (!arbiter) return abandoned();
    const granularity = await interactor.ask(GRANULARITY_POLL);
    if (!granularity) return abandoned();
    const budget = await interactor.ask(BUDGET_POLL);
    if (!budget) return abandoned();

    const arbiterModel = arbiter.freeText?.trim() || MODEL_BY_OPTION[arbiter.optionId ?? ""] || "claude-fable-5";
    const gran = (granularity.optionId ?? "every-fork") as "every-fork" | "major-forks" | "minimal";
    const customCap = budget.freeText ? Number.parseFloat(budget.freeText.replace(/[^0-9.]/g, "")) : NaN;
    const maxRunUsd = Number.isFinite(customCap) && customCap > 0 ? customCap : BUDGET_BY_OPTION[budget.optionId ?? ""] ?? 10;

    config.orchestrator.initialized = true;
    config.orchestrator.interrogation.granularity = gran;
    config.orchestrator.budget.max_run_usd = maxRunUsd;
    config.orchestrator.roles.arbiter = { ...(config.orchestrator.roles.arbiter ?? { effort: "high" }), model: arbiterModel };
    writeFileSync(configFile(env), `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(
      `orchestrator onboarded: arbiter=${arbiterModel}, granularity=${gran}, budget=${maxRunUsd === null ? "uncapped" : `$${maxRunUsd}/run`}. \`corpocode start\` is unlocked.\n`,
    );
  } finally {
    if (!deps.interactor) await interactor.close();
  }

  function abandoned(): void {
    process.stdout.write("· orchestrator onboarding abandoned — nothing changed (re-run `corpocode init` any time)\n");
  }
}
