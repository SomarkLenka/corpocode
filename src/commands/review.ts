// `corpocode review` — the weekly self-audit. It reads the NDJSON log and surfaces where the cheap
// caretakers are misfiring: tenet checks that fire often but with low confidence (noise the user pays
// for and learns to ignore), and active tenets that never fire at all (dead weight). It PROPOSES config
// tweaks — it never applies them and never edits config itself. The output is a plan a human can act on
// or open as a PR; keeping the audit advisory-only is the whole point (propose, don't dispose).
import { readFileSync } from "node:fs";
import { logFile } from "../config/paths";
import { loadConfig } from "../config/load";
import type { CorpoConfig } from "../config/schema";

const MIN_FIRES = 5; // below this, a tenet hasn't fired enough to judge its signal
const LOW_CONFIDENCE = 0.5; // mean confidence under this over many fires reads as noise

/** A concrete, machine-applicable config change — the body of the "PR" the review proposes. Always a
 * proposal: review never applies it, so the user (or a github agent) opens it as a reviewable diff. */
export interface ConfigPatch {
  path: string; // dotted config path, e.g. "molar_edit.strictness.A"
  op: "set" | "remove-from-array";
  value: string;
}

export interface ReviewProposal {
  kind: "tenet_noise" | "tenet_idle" | "router_pressure";
  detail: string;
  suggestion: string;
  evidence: Record<string, number | string>;
  patch?: ConfigPatch;
}

export interface ReviewReport {
  windowDays: number;
  turns: number;
  verifierChecks: number;
  proposals: ReviewProposal[];
}

interface TenetStat {
  fires: number;
  violations: number;
  confidenceSum: number;
}

interface LogRecord {
  ts?: string;
  event?: string;
  tenet?: string;
  verdict?: string;
  confidence?: number;
  stage2_invoked?: boolean;
}

export interface ReviewOptions {
  config?: CorpoConfig;
  days?: number;
  now?: number;
}

export function computeReview(lines: string[], opts: ReviewOptions = {}): ReviewReport {
  const now = opts.now ?? Date.now();
  const cutoff = opts.days ? now - opts.days * 86_400_000 : 0;

  const tenets = new Map<string, TenetStat>();
  let turns = 0;
  let stage2 = 0;
  let verifierChecks = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: LogRecord;
    try {
      rec = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (cutoff && rec.ts) {
      const ts = Date.parse(rec.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
    }

    if (rec.event === "router") {
      turns += 1;
      if (rec.stage2_invoked) stage2 += 1;
    } else if (rec.event === "verifier_check" && rec.tenet) {
      verifierChecks += 1;
      const stat = tenets.get(rec.tenet) ?? { fires: 0, violations: 0, confidenceSum: 0 };
      stat.fires += 1;
      if (rec.verdict === "violation") stat.violations += 1;
      stat.confidenceSum += typeof rec.confidence === "number" ? rec.confidence : 0;
      tenets.set(rec.tenet, stat);
    }
  }

  return {
    windowDays: opts.days ?? 0,
    turns,
    verifierChecks,
    proposals: buildProposals(tenets, verifierChecks, turns, stage2, opts.config),
  };
}

function buildProposals(
  tenets: Map<string, TenetStat>,
  verifierChecks: number,
  turns: number,
  stage2: number,
  config?: CorpoConfig,
): ReviewProposal[] {
  const proposals: ReviewProposal[] = [];

  // Noise: a tenet that fires a lot but with low mean confidence is costing more than it informs.
  for (const [tenet, stat] of tenets) {
    const mean = stat.fires ? stat.confidenceSum / stat.fires : 0;
    if (stat.fires >= MIN_FIRES && mean < LOW_CONFIDENCE) {
      proposals.push({
        kind: "tenet_noise",
        detail: `Tenet ${tenet} fired ${stat.fires}× with mean confidence ${mean.toFixed(2)}.`,
        suggestion: `Review the ${tenet} check prompt, or set molar_edit.strictness.${tenet} to "off" if it is not earning its noise.`,
        evidence: { tenet, fires: stat.fires, meanConfidence: Number(mean.toFixed(2)), violations: stat.violations },
        patch: { path: `molar_edit.strictness.${tenet}`, op: "set", value: "off" },
      });
    }
  }

  // Idle: an active tenet that never fired across a window with real verifier activity is dead weight.
  if (config && verifierChecks > 0) {
    for (const tenet of config.molar_edit.active_tenets) {
      if (!tenets.has(tenet)) {
        proposals.push({
          kind: "tenet_idle",
          detail: `Tenet ${tenet} is active but did not fire once in this window.`,
          suggestion: `Consider removing "${tenet}" from molar_edit.active_tenets, or confirm its appliesTo matches your files.`,
          evidence: { tenet, fires: 0 },
          patch: { path: "molar_edit.active_tenets", op: "remove-from-array", value: tenet },
        });
      }
    }
  }

  // Router pressure: if every turn escalates to stage 2, trivial early-exit may be mistuned.
  if (turns >= MIN_FIRES && stage2 === turns && config?.router.trivial_early_exit) {
    proposals.push({
      kind: "router_pressure",
      detail: `All ${turns} turns invoked the stage-2 ranker; none early-exited as trivial.`,
      suggestion: "Confirm the heuristic prefilter's trivial detection still matches your prompt mix.",
      evidence: { turns, stage2 },
    });
  }

  return proposals;
}

function readLogLines(env?: NodeJS.ProcessEnv): string[] {
  try {
    return readFileSync(logFile(env), "utf8").split("\n");
  } catch {
    return [];
  }
}

interface ReviewFlags {
  json: boolean;
  days: number;
}

function parseFlags(argv: string[]): ReviewFlags {
  const flags: ReviewFlags = { json: false, days: 7 }; // weekly by default
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") flags.json = true;
    else if (argv[i] === "--days") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) flags.days = n;
    }
  }
  return flags;
}

export function runReviewCommand(argv: string[], env?: NodeJS.ProcessEnv): void {
  const flags = parseFlags(argv);
  let config: CorpoConfig | undefined;
  try {
    config = loadConfig({ env });
  } catch {
    config = undefined; // review still works without config; it just can't flag idle tenets
  }

  const report = computeReview(readLogLines(env), { days: flags.days, ...(config ? { config } : {}) });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`CorpoCode review (last ${report.windowDays} day(s))\n`);
  process.stdout.write(`  turns: ${report.turns}, verifier checks: ${report.verifierChecks}\n`);
  if (report.proposals.length === 0) {
    process.stdout.write("  no tuning proposals — the caretakers look well-calibrated.\n");
    return;
  }
  process.stdout.write(`  ${report.proposals.length} proposal(s) — open as a PR; nothing is applied automatically:\n`);
  for (const p of report.proposals) {
    process.stdout.write(`\n  • [${p.kind}] ${p.detail}\n    → ${p.suggestion}\n`);
    if (p.patch) {
      const verb = p.patch.op === "set" ? "set" : "remove from";
      process.stdout.write(`    patch: ${verb} ${p.patch.path} = ${JSON.stringify(p.patch.value)}\n`);
    }
  }
}
