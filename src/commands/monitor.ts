// `corpocode monitor` — start the live monitor window. Thin command shell: parse flags, build the
// server (engine lives in src/monitor/), bind to loopback, open the browser, and stay foregrounded
// until Ctrl-C. Loopback-only by design — the log it streams must never be reachable off the machine.
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { flowLogFile, logFile } from "../config/paths";
import { createMonitorServer } from "../monitor/server";
import { monitorPagePath } from "../monitor/page";

const DEFAULT_PORT = 4319;
const HOST = "127.0.0.1";

interface MonitorFlags {
  port?: number; // undefined ⇒ default port with ephemeral fallback
  open: boolean;
  lines: number;
}

function parseFlags(argv: string[]): MonitorFlags {
  const flags: MonitorFlags = { open: true, lines: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") flags.open = false;
    else if (a === "--port") {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n > 0 && n < 65536) flags.port = n;
    } else if (a === "--lines") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) flags.lines = Math.floor(n);
    }
  }
  return flags;
}

/** Open `url` in the default browser, fail-open: a launch failure just leaves the user to click the
 *  printed URL (In-flight — the monitor must run regardless of whether a browser could be spawned). */
function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }).unref();
  } catch {
    // best-effort; the URL is already printed
  }
}

function ready(server: Server, flags: MonitorFlags): void {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : DEFAULT_PORT;
  const url = `http://${HOST}:${port}`;
  process.stdout.write(`corpocode monitor → ${url}  (Ctrl-C to stop)\n`);
  if (flags.open) openBrowser(url);
}

export function runMonitorCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): void {
  const flags = parseFlags(argv);
  const server = createMonitorServer({
    flowFile: flowLogFile(undefined, env),
    ndjsonFile: logFile(undefined, env),
    htmlPath: monitorPagePath(),
    lines: flags.lines,
  });

  const explicitPort = flags.port !== undefined;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !explicitPort) {
      // Default port taken → fall back to any free port rather than failing.
      server.listen(0, HOST, () => ready(server, flags));
      return;
    }
    const detail = err.code === "EADDRINUSE" ? `port ${flags.port} is already in use` : String(err);
    process.stderr.write(`corpocode monitor: ${detail}\n`);
    process.exitCode = 1;
  });

  server.listen(flags.port ?? DEFAULT_PORT, HOST, () => ready(server, flags));

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
