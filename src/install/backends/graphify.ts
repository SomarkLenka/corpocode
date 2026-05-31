// Provision graphify: confirm a Python toolchain, install graphify if absent, register its git
// hook so the graph stays fresh on every commit at no cost, and build the initial graph if none
// exists. Each external call goes through the injectable runner so this is unit-testable.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner, ProvisionResult, ProvisionStep } from "../run";
import { spawnRunner } from "../run";

export interface GraphifyProvisionOptions {
  repoRoot: string;
  run?: CommandRunner;
  exists?: (path: string) => boolean;
  pythonCmd?: string;
  dryRun?: boolean;
}

export async function provisionGraphify(opts: GraphifyProvisionOptions): Promise<ProvisionResult> {
  const run = opts.run ?? spawnRunner;
  const exists = opts.exists ?? existsSync;
  const python = opts.pythonCmd ?? "python";
  const graphPath = join(opts.repoRoot, "graphify-out", "graph.json");
  const steps: ProvisionStep[] = [];

  if (opts.dryRun) {
    return {
      component: "graphify",
      ok: true,
      steps: [
        { name: "check python", ok: true, detail: `${python} --version`, skipped: true },
        { name: "install graphify", ok: true, detail: "pip install graphify (if missing)", skipped: true },
        { name: "register git hook", ok: true, detail: "graphify hook install", skipped: true },
        { name: "build graph", ok: true, detail: exists(graphPath) ? "present" : "graphify .", skipped: true },
      ],
    };
  }

  const python_ = await run(python, ["--version"]);
  steps.push({ name: "check python", ok: python_.code === 0, detail: python_.stdout.trim() || python_.stderr.trim() });

  const ver = await run("graphify", ["--version"]);
  if (ver.code === 0) {
    steps.push({ name: "graphify present", ok: true, detail: ver.stdout.trim() });
  } else {
    const install = await run(python, ["-m", "pip", "install", "--quiet", "graphify"]);
    steps.push({ name: "install graphify", ok: install.code === 0, detail: install.code === 0 ? "installed" : install.stderr.trim() });
  }

  const hook = await run("graphify", ["hook", "install"], { cwd: opts.repoRoot });
  steps.push({ name: "register git hook", ok: hook.code === 0, detail: hook.code === 0 ? "installed" : hook.stderr.trim() });

  if (exists(graphPath)) {
    steps.push({ name: "build graph", ok: true, detail: "graph already present", skipped: true });
  } else {
    const build = await run("graphify", ["."], { cwd: opts.repoRoot });
    steps.push({ name: "build graph", ok: build.code === 0, detail: build.code === 0 ? "built" : build.stderr.trim() });
  }

  return { component: "graphify", ok: steps.every((s) => s.ok), steps };
}
