// Shared child-process spawn for CLI-backed agents (lifted from providers/anthropic-cli.ts so the
// SIGTERM-on-abort and ENOENT semantics stay identical). Feeds stdin, collects stdout, and rejects on
// a non-zero exit or spawn failure. The backend injects a fake of this in tests, so no real `claude`
// process is ever spawned in the suite.
import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
}

/** The injectable spawn seam: run a command with stdin, resolve its stdout, abortable via the signal. */
export type SpawnText = (cmd: string, args: string[], stdin: string, signal: AbortSignal) => Promise<SpawnResult>;

export const spawnText: SpawnText = (cmd, args, stdin, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err); // e.g. ENOENT when the claude binary is absent
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) resolve({ stdout });
      else reject(Object.assign(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`), { code }));
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
