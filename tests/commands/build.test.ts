import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildFlags, runBuildCommand } from "../../src/commands/build";
import { createRun, saveRun } from "../../src/orchestrator/run";

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
