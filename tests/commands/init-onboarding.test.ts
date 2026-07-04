// The orchestrator onboarding — the release gate on `corpocode start`. Driven through a scripted
// Interactor so no terminal (and no model) is involved; config lands under a CORPOCODE_HOME temp dir.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInitCommand, runOrchestratorOnboarding } from "../../src/commands/init";
import { createScriptedInteractor } from "../../src/interact/scripted";
import type { Interactor } from "../../src/interact/types";
import { configFile } from "../../src/config/paths";
import { loadConfig } from "../../src/config/load";

const dirs: string[] = [];
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "cc-onboard-"));
  dirs.push(dir);
  // CLAUDE_CONFIG_DIR keeps init's toolbox gating away from the real ~/.claude.
  return { CORPOCODE_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "claude") };
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function answers(rules: Parameters<typeof createScriptedInteractor>[0]["answers"]): Interactor {
  return createScriptedInteractor({ answers: rules });
}

describe("runOrchestratorOnboarding", () => {
  it("writes arbiter model, granularity, and budget, and flips initialized", async () => {
    const env = home();
    runInitCommand(["--no-gate"], env);
    await runOrchestratorOnboarding([], {
      env,
      interactor: answers([
        { poll: "onboard-arbiter", option: "fable" },
        { poll: "onboard-granularity", option: "major-forks" },
        { poll: "onboard-budget", option: "cap25" },
      ]),
    });
    const cfg = loadConfig({ env });
    expect(cfg.orchestrator.initialized).toBe(true);
    expect(cfg.orchestrator.interrogation.granularity).toBe("major-forks");
    expect(cfg.orchestrator.budget.max_run_usd).toBe(25);
    expect(cfg.orchestrator.roles.arbiter?.model).toBe("claude-fable-5");
  });

  it("accepts a custom arbiter model and a custom dollar cap via free text", async () => {
    const env = home();
    runInitCommand(["--no-gate"], env);
    await runOrchestratorOnboarding([], {
      env,
      interactor: answers([
        { poll: "onboard-arbiter", freeText: "claude-sonnet-5" },
        { poll: "onboard-granularity", option: "every-fork" },
        { poll: "onboard-budget", freeText: "$42.50" },
      ]),
    });
    const cfg = loadConfig({ env });
    expect(cfg.orchestrator.roles.arbiter?.model).toBe("claude-sonnet-5");
    expect(cfg.orchestrator.budget.max_run_usd).toBe(42.5);
  });

  it("an abandoned interrogation changes nothing", async () => {
    const env = home();
    runInitCommand(["--no-gate"], env);
    const before = readFileSync(configFile(env), "utf8");
    // No rules and no defaults consumed: the arbiter poll HAS a default, so exhaust rules resolve it;
    // abandonment is proven with an interactor whose ask always yields null.
    const dead: Interactor = { ask: async () => null, say: () => {}, close: async () => {} };
    await runOrchestratorOnboarding([], { env, interactor: dead });
    expect(readFileSync(configFile(env), "utf8")).toBe(before);
    expect(loadConfig({ env }).orchestrator.initialized).toBe(false);
  });

  it("skips with --no-orchestrator, without a TTY, and when already onboarded", async () => {
    const env = home();
    runInitCommand(["--no-gate"], env);
    await runOrchestratorOnboarding(["--no-orchestrator"], { env, isTTY: true });
    expect(loadConfig({ env }).orchestrator.initialized).toBe(false);

    await runOrchestratorOnboarding([], { env, isTTY: false });
    expect(loadConfig({ env }).orchestrator.initialized).toBe(false);

    // Onboard once, then verify a second pass without --force is a no-op that never asks.
    await runOrchestratorOnboarding([], {
      env,
      interactor: answers([{ option: "fable" }, { option: "every-fork" }, { option: "cap10" }]),
    });
    expect(loadConfig({ env }).orchestrator.initialized).toBe(true);
    const throwing: Interactor = {
      ask: async () => {
        throw new Error("must not be asked");
      },
      say: () => {},
      close: async () => {},
    };
    await runOrchestratorOnboarding([], { env, interactor: throwing });
  });
});
