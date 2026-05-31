// A tiny injectable command runner used by the backend provisioners, so provisioning logic is
// unit-testable without spawning real external tools.
import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      // Merge over the inherited environment so callers can set e.g. GIT_INDEX_FILE without dropping PATH.
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts?.input) child.stdin.write(opts.input);
    child.stdin.end();
  });

export interface ProvisionStep {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface ProvisionResult {
  component: string;
  ok: boolean;
  steps: ProvisionStep[];
}
