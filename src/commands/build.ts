// corpocode build <runId>: the Phase 2 pipeline. Thin IO — every decision lives in the pure
// modules; this file only sequences them and persists state transitions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { runDir, runFile, ensureDir } from "../config/paths";
import { loadRun, saveRun, advance } from "../orchestrator/run";
import { createBudgetGuard } from "../orchestrator/budget";
import { buildOrchestratorAgents, resolveRoleModel } from "../orchestrator/context";
import { checkSpecCompleteness } from "../um/completeness";
import { compileTasks } from "../orchestrator/decompose";
import { sanitizeIngress } from "../orchestrator/sanitize";
import { computeWaves } from "../orchestrator/waves";
import { critiquePlan } from "../orchestrator/critic";
import { createWorkspace } from "../orchestrator/workspace";
import { verifyCandidate } from "../orchestrator/verify-mechanical";
import { allowlistFromPackageJson } from "../orchestrator/depgate";
import { runSwarm } from "../orchestrator/swarm";
import { integrate, conflictTasks } from "../orchestrator/land";
import { buildRunReport } from "../orchestrator/report";
import { createCostTracker, type CostEvent } from "../cost/tracker";
import { spawnRunner } from "../install/run";

export interface BuildFlags {
  runId?: string;
  dryRun: boolean;
  allowIncomplete: boolean;
  dev: boolean;
}

export function parseBuildFlags(argv: string[]): BuildFlags {
  const flags: BuildFlags = { dryRun: false, allowIncomplete: false, dev: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--allow-incomplete") flags.allowIncomplete = true;
    else if (arg === "--dev") flags.dev = true;
    else if (!arg.startsWith("--") && !flags.runId) flags.runId = arg;
  }
  return flags;
}

export async function runBuildCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<void> {
  const flags = parseBuildFlags(argv);
  const config = loadConfig({ env });
  const dev = flags.dev || env.CORPOCODE_DEV === "1";

  if (!config.orchestrator.initialized && !dev) {
    console.error("corpocode build is gated until onboarding: run `corpocode init` (or use --dev).");
    process.exitCode = 1;
    return;
  }
  if (!flags.runId) {
    console.error("usage: corpocode build <runId> [--dry-run] [--allow-incomplete] [--dev]");
    process.exitCode = 1;
    return;
  }

  let run = loadRun(flags.runId, cwd, env);
  if (!run) {
    console.error(`unknown run: ${flags.runId}`);
    process.exitCode = 1;
    return;
  }
  if (run.status === "paused") {
    run = advance(run, { type: "resume" }, Date.now());
    saveRun(run, cwd, env);
  }
  const BUILDABLE = ["specified", "planned", "building"] as const;
  if (!BUILDABLE.includes(run.status as (typeof BUILDABLE)[number])) {
    console.error(`run ${run.id} is "${run.status}" — build needs an approved spec (specified/planned) or a resumable build.`);
    process.exitCode = 1;
    return;
  }

  // ---- load artifacts ----
  const spec = JSON.parse(readFileSync(runFile(run.id, "spec.json", cwd, env), "utf8"));
  const tasksFile = JSON.parse(readFileSync(runFile(run.id, "tasks.json", cwd, env), "utf8"));

  // ---- completeness gate (Task 2) ----
  const completeness = checkSpecCompleteness(spec);
  if (!completeness.ok) {
    for (const f of completeness.failures) console.error(`spec incomplete: ${f}`);
    if (!flags.allowIncomplete) {
      console.error("refusing to build an incomplete spec (--allow-incomplete to override).");
      process.exitCode = 1;
      return;
    }
  }

  // ---- decompose (Tasks 5+7) + waves (Task 6) ----
  const sanitize = config.orchestrator.sanitize.enabled ? (t: string) => sanitizeIngress(t).text : undefined;
  const compiled = compileTasks(spec, tasksFile, sanitize ? { sanitize } : {});
  const pending = compiled.filter((t) => t.status === "pending");
  const waved = computeWaves(pending.map((t) => ({ id: t.id, dependsOn: t.dependsOn, files: t.files })));
  if (!waved.ok) {
    console.error(`cannot schedule: ${waved.error}`);
    process.exitCode = 1;
    return;
  }

  if (flags.dryRun) {
    console.log(`run ${run.id}: ${pending.length} pending task(s) in ${waved.waves.length} wave(s)`);
    waved.waves.forEach((wave, i) => console.log(`  wave ${i + 1}: ${wave.join(", ")}`));
    return;
  }

  // ---- planning critic (Task 8) ----
  const repoRoot = cwd;
  const agents = buildOrchestratorAgents(config, { repoRoot });
  const critic = await critiquePlan({ backend: agents.forTask("review"), tasks: compiled, model: resolveRoleModel(config, "review") });
  for (const f of critic.findings) console.error(`critic [${f.severity}] ${f.taskId}: ${f.note}`);
  if (critic.skipped) console.error(`critic skipped: ${critic.skipped}`);
  if (!critic.ok && !flags.allowIncomplete) {
    console.error("critic found blocking issues (--allow-incomplete to override).");
    process.exitCode = 1;
    return;
  }

  // persist compiled briefs; advance to planned
  writeFileSync(runFile(run.id, "tasks.json", cwd, env), JSON.stringify({ ...tasksFile, tasks: compiled }, null, 2) + "\n");
  if (run.status === "specified") {
    run = advance(run, { type: "phase", to: "planned" }, Date.now());
    saveRun(run, cwd, env);
  }

  // ---- workspace + swarm (Tasks 9-12) ----
  const workspace = createWorkspace({ runId: run.id, repoRoot, run: spawnRunner, cwd, env });
  const integrationBranch = await workspace.ensureIntegration();
  const integrationWorktree = join(runDir(run.id, cwd, env), "worktrees", "_integration");
  const budget = createBudgetGuard(config.orchestrator.budget);
  const costTracker = createCostTracker();
  const costEvents: CostEvent[] = [];
  const recordCost = (e: CostEvent) => {
    costEvents.push(e);
    costTracker.record(e);
  };
  const allowlist = allowlistFromPackageJson(safeRead(join(repoRoot, "package.json")));
  const journal = (fields: Record<string, unknown>) => appendJournal(run!.id, fields, cwd, env);
  let conflictCount = 0;

  run = advance(run, { type: "phase", to: "building" }, Date.now());
  saveRun(run, cwd, env);
  const started = Date.now();

  const result = await runSwarm({
    runId: run.id,
    tasks: compiled,
    waves: waved.waves,
    swarmConfig: config.orchestrator.swarm,
    workspace,
    implementFor: (worktree) => buildOrchestratorAgents(config, { repoRoot: worktree }).forTask("implement"),
    implementModel: resolveRoleModel(config, "implement"),
    verify: (worktree, task) =>
      verifyCandidate({
        worktree,
        baseBranch: integrationBranch,
        task: { id: task.id, ...(task.verifyCommand ? { verifyCommand: task.verifyCommand } : {}) },
        run: spawnRunner,
        depgate: { enabled: config.orchestrator.depgate.enabled, allowlist, registryCheck: config.orchestrator.depgate.registry_check, fetchFn: fetch },
        log: journal,
      }),
    onWaveComplete: async (winners) => {
      const out = await integrate({ repoRoot, integrationBranch, integrationWorktree, winners, run: spawnRunner, log: journal });
      conflictCount += out.conflicts.length;
      if (out.conflicts.length > 0) {
        const extra = conflictTasks(out.conflicts, compiled);
        const current = JSON.parse(readFileSync(runFile(run!.id, "tasks.json", cwd, env), "utf8"));
        current.tasks.push(...extra);
        writeFileSync(runFile(run!.id, "tasks.json", cwd, env), JSON.stringify(current, null, 2) + "\n");
      }
    },
    budget,
    leaseDir: join(runDir(run.id, cwd, env), "leases"),
    log: journal,
    recordCost,
  });

  // ---- statuses, report, run-state epilogue (Task 14) ----
  const current = JSON.parse(readFileSync(runFile(run.id, "tasks.json", cwd, env), "utf8"));
  for (const outcome of result.outcomes) {
    const t = current.tasks.find((x: { id: string }) => x.id === outcome.taskId);
    if (t) t.status = outcome.status === "completed" ? "completed" : t.status;
  }
  writeFileSync(runFile(run.id, "tasks.json", cwd, env), JSON.stringify(current, null, 2) + "\n");

  const report = buildRunReport({
    runId: run.id,
    outcomes: result.outcomes,
    conflicts: conflictCount,
    costEvents,
    wallClockMs: Date.now() - started,
    ...(result.halted ? { halted: result.halted } : {}),
  });
  writeFileSync(runFile(run.id, "report.json", cwd, env), JSON.stringify(report, null, 2) + "\n");
  journal({ event: "run_summary", ...report });

  const allDone = report.failed === 0 && report.skipped === 0 && report.conflicts === 0 && !result.halted;
  if (allDone) {
    run = advance(run, { type: "phase", to: "verifying" }, Date.now());
    run = advance(run, { type: "phase", to: "promoting" }, Date.now());
    run = advance(run, { type: "phase", to: "done" }, Date.now());
  } else {
    run = advance(run, { type: "pause", reason: result.halted ?? `open work: ${report.failed} failed, ${report.conflicts} conflict(s) — re-run corpocode build` }, Date.now());
  }
  saveRun(run, cwd, env);

  console.log(`build ${allDone ? "complete" : "paused"}: ${report.completed}/${report.tasksTotal} tasks, $${report.totalCostUsd.toFixed(4)} total` + (report.costPerCompletedTaskUsd !== null ? ` ($${report.costPerCompletedTaskUsd.toFixed(4)}/task)` : ""));
  console.log(`integration branch: ${integrationBranch} — landing on your branch stays a human decision (Phase 4).`);
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "{}";
  }
}

function appendJournal(runId: string, fields: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): void {
  try {
    const dir = runDir(runId, cwd, env);
    ensureDir(dir);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n";
    writeFileSync(join(dir, "journal.ndjson"), line, { flag: "a" });
  } catch {
    // journaling is best-effort
  }
}
