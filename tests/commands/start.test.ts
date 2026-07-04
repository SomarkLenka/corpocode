// `corpocode start` — the pure pieces and the paths that never reach a model: flag parsing, the
// prompts adapter's axis fallback, the init/dev gate, and run listing/status against a temp home.
// The cockpit itself is covered in tests/um/loop.test.ts with fake backends; per the house rule,
// no test here (or anywhere) spawns a real `claude`.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cockpitPrompts, parseStartFlags, runStartCommand } from "../../src/commands/start";
import { createRun, saveRun } from "../../src/orchestrator/run";
import { configFile, ensureDir } from "../../src/config/paths";
import { defaultConfig } from "../../src/config/load";

const dirs: string[] = [];
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "cc-start-"));
  dirs.push(dir);
  return { CORPOCODE_HOME: dir };
}

let out: string[] = [];
let errs: string[] = [];
beforeEach(() => {
  out = [];
  errs = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (errs.push(String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseStartFlags", () => {
  it("parses the task positional plus every flag", () => {
    const f = parseStartFlags(["add dark mode", "--yes", "--dev", "--answers", "a.json", "--resume", "run-1", "--spec-only"]);
    expect(f).toMatchObject({ task: "add dark mode", yes: true, dev: true, answers: "a.json", resume: "run-1", specOnly: true });
  });

  it("takes only the first positional as the task", () => {
    expect(parseStartFlags(["one", "two"]).task).toBe("one");
  });
});

describe("cockpitPrompts", () => {
  const prompts = cockpitPrompts({ cwd: process.cwd(), env: {} });

  it("renders the interrogate prompt with all vars filled", () => {
    const p = prompts.interrogate({ task: "T", remainingSections: ["api-spec", "scale-path"], grounding: "src/a.ts" });
    expect(p).toContain("T");
    expect(p).toContain("api-spec, scale-path");
    expect(p).toContain("src/a.ts");
    expect(p).not.toContain("{{"); // every placeholder must be consumed
  });

  it("uses the tuned per-axis prompt when one exists and the generic fallback otherwise", () => {
    const vars = { question: "Q?", optionLabel: "opt A", concept: "caching" };
    expect(prompts.axis("performance", vars)).toContain("PERFORMANCE lens");
    const custom = prompts.axis("compliance", vars);
    expect(custom).toContain("compliance lens");
    expect(custom).toContain("opt A");
    expect(custom).not.toContain("{{");
  });
});

describe("runStartCommand gates (no model is ever reached)", () => {
  it("refuses without a task", async () => {
    await runStartCommand(["--dev"], home());
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("usage:");
  });

  it("is gated until onboarding, and --dev bypasses the gate", async () => {
    const env = home();
    await runStartCommand(["do a thing"], env);
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("corpocode init");
  });

  it("CORPOCODE_DEV=1 also bypasses (proven by failing PAST the gate at the missing-task check)", async () => {
    const env = { ...home(), CORPOCODE_DEV: "1" };
    await runStartCommand([], env);
    expect(errs.join("")).toContain("usage:"); // reached the task check, not the gate message
  });

  it("refuses when the orchestrator is disabled in config", async () => {
    const env = home();
    ensureDir(env.CORPOCODE_HOME!);
    const cfg = defaultConfig();
    cfg.orchestrator.enabled = false;
    writeFileSync(configFile(env), JSON.stringify(cfg));
    await runStartCommand(["task", "--dev"], env);
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("disabled");
  });

  it("errors on an unreadable answers file before any work happens", async () => {
    await runStartCommand(["task", "--dev", "--answers", "/nope/none.json"], home());
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("answers file");
  });
});

describe("run listing and status", () => {
  it("--list shows persisted runs newest-first and --status reads one", async () => {
    const env = home();
    saveRun(createRun("run-20260101000000-aaaa", "older task", 1_000), undefined, env);
    saveRun(createRun("run-20260102000000-bbbb", "newer task", 2_000), undefined, env);
    await runStartCommand(["--list"], env);
    const listed = out.join("");
    expect(listed.indexOf("newer task")).toBeLessThan(listed.indexOf("older task"));

    await runStartCommand(["--status", "run-20260101000000-aaaa"], env);
    expect(out.join("")).toContain("interrogating");
  });

  it("--status on an unknown run fails with a hint", async () => {
    await runStartCommand(["--status", "run-nope"], home());
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("--list");
  });

  it("--resume refuses a run that is not paused", async () => {
    const env = home();
    saveRun(createRun("run-20260101000000-cccc", "t", 1_000), undefined, env);
    await runStartCommand(["--resume", "run-20260101000000-cccc", "--dev"], env);
    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("not paused");
  });
});
