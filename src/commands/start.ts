// `corpocode start "<task>"` — the orchestrator's front door (docs/narrative/08). Phase 1 runs the
// cockpit only: interrogation → spec.json (+ derived spec.md) + tasks.json, then the run parks at
// `specified` for the swarm phases to consume later. The command is the real gate on the primary
// mode: release builds refuse until `corpocode init` onboarding has run (CORPOCODE_DEV=1 or --dev
// bypasses for local testing), and Ctrl-C pauses-and-persists rather than losing pilot answers —
// closing the interactor resolves the pending poll to its default (journaled) or pauses the run.
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/load";
import { ensureDir, logFile, projectKey, runDir, runFile } from "../config/paths";
import { createLogger } from "../log/ndjson";
import { buildKnowledgeGraph } from "../backends/graph/registry";
import { buildMemoryStore } from "../backends/memory/registry";
import { gather } from "../intelligence/gather";
import { createPromptResolver } from "../prompts/resolve";
import { isPromptId } from "../prompts/registry";
import { buildOrchestratorAgents, resolveRoleModel } from "../orchestrator/context";
import { createBudgetGuard } from "../orchestrator/budget";
import { advance, createRun, listRuns, loadRun, newRunId, saveRun, type RunRecord } from "../orchestrator/run";
import { runCockpit, type CockpitPrompts } from "../um/loop";
import type { SpecState } from "../um/interrogator";
import { createMasteryModel } from "../um/mastery";
import { createTerminalInteractor } from "../interact/terminal";
import { createScriptedInteractor, loadAnswersFile } from "../interact/scripted";
import type { Interactor } from "../interact/types";
import { renderSpecMarkdown, specSchema, type Spec } from "../um/spec-schema";
import { emitTasksFile } from "../um/harvest/tasks-schema";
import type { CorpoConfig } from "../config/schema";

export interface StartFlags {
  task?: string;
  specOnly: boolean; // accepted from day one; Phase 1 behavior is spec-only regardless
  dev: boolean;
  yes: boolean;
  answers?: string;
  resume?: string;
  list: boolean;
  status?: string;
}

export function parseStartFlags(argv: string[]): StartFlags {
  const flags: StartFlags = { specOnly: false, dev: false, yes: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--spec-only") flags.specOnly = true;
    else if (a === "--dev") flags.dev = true;
    else if (a === "--yes") flags.yes = true;
    else if (a === "--list") flags.list = true;
    else if (a === "--answers") flags.answers = argv[++i];
    else if (a === "--resume") flags.resume = argv[++i];
    else if (a === "--status") flags.status = argv[++i];
    else if (!a.startsWith("--") && flags.task === undefined) flags.task = a;
  }
  return flags;
}

/** Bind the cockpit's prompt needs to the user-tunable resolver. A configured axis with its own
 *  `um-axis-<axis>` prompt uses it; anything else falls back to the generic `um-axis` rubric — so a
 *  user-invented axis works out of the box and can still be tuned later by adding the file. */
export function cockpitPrompts(opts: { cwd: string; env: NodeJS.ProcessEnv }): CockpitPrompts {
  const resolver = createPromptResolver(opts);
  return {
    interrogate: (vars) =>
      resolver.resolve("um-interrogate", {
        task: vars.task,
        remainingSections: vars.remainingSections.join(", "),
        grounding: vars.grounding || "(no grounding available)",
        lastAnswer: vars.lastAnswer ?? "(none yet)",
      }),
    axis: (axis, vars) => {
      const specific = `um-axis-${axis}`;
      const fill = {
        axis,
        concept: vars.concept,
        question: vars.question,
        optionLabel: vars.optionLabel,
        optionDescription: vars.optionDescription ?? "(no further description)",
      };
      return isPromptId(specific) ? resolver.resolve(specific, fill) : resolver.resolve("um-axis", fill);
    },
  };
}

/** Reload a paused run's spec checkpoint. polls resumes as the ledger length — close enough for the
 *  fatigue guard, and it means a resumed run can never dodge max_polls by pausing. */
function loadSpecState(runId: string, cwd: string, env: NodeJS.ProcessEnv): SpecState | null {
  try {
    const raw = JSON.parse(readFileSync(runFile(runId, "spec.json", cwd, env), "utf8")) as unknown;
    const spec = specSchema.parse(raw);
    return { spec, polls: spec.decisions.length };
  } catch {
    return null;
  }
}

function writeArtifacts(runId: string, spec: Spec, cwd: string, env: NodeJS.ProcessEnv): void {
  ensureDir(runDir(runId, cwd, env));
  writeFileSync(runFile(runId, "spec.json", cwd, env), `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(runFile(runId, "spec.md", cwd, env), renderSpecMarkdown(spec));
}

function decisionSummary(spec: Spec): string {
  const by = { pilot: 0, delegated: 0, default: 0 };
  for (const d of spec.decisions) by[d.answer.source]++;
  return `${spec.decisions.length} decision(s) — ${by.pilot} pilot, ${by.delegated} delegated, ${by.default} defaulted`;
}

export async function runStartCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const flags = parseStartFlags(argv);
  const out = (s: string): void => void process.stdout.write(`${s}\n`);
  const err = (s: string): void => void process.stderr.write(`${s}\n`);
  const cwd = process.cwd();

  if (flags.list) {
    const runs = listRuns(cwd, env);
    if (runs.length === 0) return out("no runs yet — `corpocode start \"<task>\"` begins one");
    for (const r of runs) out(`${r.id}  ${r.status.padEnd(13)} ${r.task.slice(0, 60)}`);
    return;
  }
  if (flags.status) {
    const run = loadRun(flags.status, cwd, env);
    if (!run) {
      err(`no run "${flags.status}" — see \`corpocode start --list\``);
      process.exitCode = 1;
      return;
    }
    out(`${run.id}: ${run.status}${run.pausedReason ? ` (${run.pausedReason})` : ""} — ${run.task}`);
    return;
  }

  let config: CorpoConfig;
  try {
    config = loadConfig({ env });
  } catch (e) {
    err(`config invalid: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (!config.orchestrator.enabled) {
    err("the orchestrator is disabled (config.orchestrator.enabled = false)");
    process.exitCode = 1;
    return;
  }
  const dev = flags.dev || env.CORPOCODE_DEV === "1";
  if (!config.orchestrator.initialized && !dev) {
    err("corpocode start is gated until onboarding: run `corpocode init` (or use --dev / CORPOCODE_DEV=1 for local testing)");
    process.exitCode = 1;
    return;
  }

  // Resolve the run: fresh, or resume a paused one from its artifacts (never re-ask a decided fork).
  let run: RunRecord;
  let resumeState: SpecState | undefined;
  if (flags.resume) {
    const existing = loadRun(flags.resume, cwd, env);
    if (!existing || existing.status !== "paused") {
      err(existing ? `run ${existing.id} is ${existing.status}, not paused` : `no run "${flags.resume}"`);
      process.exitCode = 1;
      return;
    }
    run = advance(existing, { type: "resume" }, Date.now());
    resumeState = loadSpecState(run.id, cwd, env) ?? undefined;
    if (!resumeState) out("no spec checkpoint found — the interrogation restarts (decided forks were not persisted)");
  } else {
    if (!flags.task || !flags.task.trim()) {
      err('usage: corpocode start "<task>" [--spec-only] [--answers <file>] [--yes] [--dev]');
      process.exitCode = 1;
      return;
    }
    run = createRun(newRunId(() => Date.now()), flags.task, Date.now());
  }
  if (!saveRun(run, cwd, env)) {
    err(`cannot persist run state under ${runDir(run.id, cwd, env)} — refusing to start an untrackable run`);
    process.exitCode = 1;
    return;
  }

  // The run journal rides the Logger seam's per-session tee, so `corpocode why`/`monitor` narrate
  // runs through the exact machinery they already narrate hooks with.
  const logger = createLogger({
    file: logFile(cwd, env),
    enabled: config.logging.enabled,
    sessionFile: runFile(run.id, "journal.ndjson", cwd, env),
  });

  // Grounding: free, deterministic, fail-open — a cockpit with no graph still interrogates.
  let files: string[] = [];
  try {
    const project = projectKey(cwd);
    const graph = buildKnowledgeGraph(config, { repoRoot: cwd });
    const memory = buildMemoryStore(config, { project, env, repoRoot: cwd });
    const candidates = await gather(
      { kind: "prompt", prompt: run.task, sessionId: run.id, transcriptPath: "" },
      { graph, memory, project, limit: 12, logger },
    );
    files = candidates.files.map((f) => f.path);
  } catch {
    files = [];
  }

  let interactor: Interactor;
  if (flags.answers) {
    const script = loadAnswersFile(flags.answers);
    if (!script) {
      err(`cannot read answers file: ${flags.answers}`);
      process.exitCode = 1;
      return;
    }
    interactor = createScriptedInteractor(script, { output: (block) => out(block) });
  } else {
    interactor = createTerminalInteractor();
  }

  // Ctrl-C = pause-and-persist: closing the interactor resolves the pending poll to its declared
  // default (journaled as answer_defaulted) or null, and the loop pauses — no pilot answer is lost.
  const onSignal = (): void => void interactor.close();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const budget = createBudgetGuard(config.orchestrator.budget);
  const agents = buildOrchestratorAgents(config, { repoRoot: cwd });
  out(`run ${run.id} — interrogating: ${run.task}`);
  try {
    const outcome = await runCockpit({
      forTask: (kind) => agents.forTask(kind),
      interactor,
      mastery: createMasteryModel({
        env,
        teach: config.orchestrator.interrogation.teach,
        enabled: config.orchestrator.interrogation.mastery.enabled,
      }),
      prompts: cockpitPrompts({ cwd, env }),
      orchestration: config.orchestrator,
      runId: run.id,
      task: run.task,
      files,
      roleModels: {
        interrogate: resolveRoleModel(config, "interrogate"),
        consequence: resolveRoleModel(config, "consequence"),
      },
      budget,
      autoApprove: flags.yes,
      resumeState,
      log: (line) => logger.log({ event: String(line.event ?? "cockpit"), ...line }),
    });

    writeArtifacts(run.id, outcome.state.spec, cwd, env);
    if (outcome.status === "approved") {
      run = advance(run, { type: "spec-approved" }, Date.now());
      const tasks = emitTasksFile(outcome.state.spec);
      if (tasks.ok) {
        writeFileSync(runFile(run.id, "tasks.json", cwd, env), `${JSON.stringify(tasks.file, null, 2)}\n`);
      } else {
        err(`spec approved, but the task graph did not validate: ${tasks.error}`);
        err("spec.json/spec.md are written; fix the seeds and re-run decompose in a later phase");
      }
      saveRun(run, cwd, env);
      out(`spec approved — ${decisionSummary(outcome.state.spec)}; spent $${budget.spent().toFixed(2)}`);
      out(`artifacts: ${runDir(run.id, cwd, env)} (spec.json, spec.md${tasks.ok ? ", tasks.json" : ""})`);
      out("run parked at `specified` — the implementation swarm lands in Phase 3");
    } else {
      run = advance(run, { type: "pause", reason: outcome.reason ?? "paused" }, Date.now());
      saveRun(run, cwd, env);
      out(`paused (${outcome.reason ?? "unknown"}) — ${decisionSummary(outcome.state.spec)}; spent $${budget.spent().toFixed(2)}`);
      out(`resume with: corpocode start --resume ${run.id}`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await interactor.close();
  }
}
