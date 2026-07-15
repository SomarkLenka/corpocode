import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildFlags, runBuildCommand } from "../../src/commands/build";
import { advance, createRun, loadRun, saveRun } from "../../src/orchestrator/run";
import { ensureDir, runDir, runFile } from "../../src/config/paths";

describe("parseBuildFlags", () => {
  it("parses runId and switches", () => {
    expect(parseBuildFlags(["run-1", "--dry-run", "--allow-incomplete", "--dev"])).toEqual({
      runId: "run-1",
      dryRun: true,
      allowIncomplete: true,
      dev: true,
    });
  });
  it("defaults switches off", () => {
    expect(parseBuildFlags(["run-1"])).toEqual({ runId: "run-1", dryRun: false, allowIncomplete: false, dev: false });
  });
});

describe("runBuildCommand gates", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cc-build-"));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("refuses a run that is not in a buildable state", async () => {
    const run = createRun("run-20260711000000-0001", "task", 1);
    saveRun(run, cwd, { CORPOCODE_DEV: "1" }); // status: interrogating
    await runBuildCommand(["run-20260711000000-0001", "--dev"], { CORPOCODE_DEV: "1" }, cwd);
    expect(process.exitCode).toBe(1);
  });

  it("refuses an unknown runId", async () => {
    await runBuildCommand(["run-nope", "--dev"], { CORPOCODE_DEV: "1" }, cwd);
    expect(process.exitCode).toBe(1);
  });
});

describe("runBuildCommand robustness (host-boundary guards)", () => {
  const env = { CORPOCODE_DEV: "1" } as NodeJS.ProcessEnv;
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cc-build-"));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("fails cleanly (no unhandled throw) when a buildable run is missing tasks.json", async () => {
    let run = createRun("run-20260711000000-0002", "task", 1);
    run = advance(run, { type: "phase", to: "specified" }, 2);
    saveRun(run, cwd, env);
    ensureDir(runDir(run.id, cwd, env));
    writeFileSync(runFile(run.id, "spec.json", cwd, env), "{}"); // spec present, tasks.json absent
    await runBuildCommand([run.id, "--dev"], env, cwd);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a run paused from a non-buildable phase WITHOUT consuming the pause", async () => {
    let run = createRun("run-20260711000000-0003", "task", 1);
    for (const to of ["specified", "planned", "building", "verifying"] as const) {
      run = advance(run, { type: "phase", to }, 2);
    }
    run = advance(run, { type: "pause", reason: "phase-4 stub" }, 3); // resumeStatus: verifying
    saveRun(run, cwd, env);
    await runBuildCommand([run.id, "--dev"], env, cwd);
    expect(process.exitCode).toBe(1);
    expect(loadRun(run.id, cwd, env)!.status).toBe("paused"); // still resumable — pause not consumed
  });

  it("exits cleanly on an invalid config file", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-home-"));
    writeFileSync(join(home, "config.json"), "{ not valid json");
    await runBuildCommand(["run-x", "--dev"], { CORPOCODE_DEV: "1", CORPOCODE_HOME: home }, cwd);
    expect(process.exitCode).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });
});
