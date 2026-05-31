// Real transport to graphify's MCP server: spawn `python -m graphify.serve <graph.json>` and speak
// JSON-RPC 2.0 over stdio (newline-delimited, per the MCP stdio transport). The adapter depends
// only on the GraphifyTransport interface, so tests inject a fake and this process plumbing is
// exercised only in a provisioned environment.
//
// Resilience (the In-flight tenet): every request has a timeout; a server exit rejects all
// in-flight requests rather than hanging; the process is lazily (re)started.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

export interface GraphifyTransport {
  /** Invoke an MCP tool and return its unwrapped payload. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SpawnGraphifyTransportOptions {
  repoRoot: string;
  graphPath?: string;
  pythonCmd?: string;
  callTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function spawnGraphifyTransport(opts: SpawnGraphifyTransportOptions): GraphifyTransport {
  const pythonCmd = opts.pythonCmd ?? "python";
  const graphPath = opts.graphPath ?? join(opts.repoRoot, "graphify-out", "graph.json");
  const callTimeoutMs = opts.callTimeoutMs ?? 15_000;

  let child: ChildProcessWithoutNullStreams | null = null;
  let initialized = false;
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, Pending>();

  const rejectAll = (err: unknown): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const onData = (chunk: string): void => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON lines (e.g. server log noise on stdout)
      }
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "graphify error"));
        else p.resolve(msg.result);
      }
    }
  };

  const start = (): void => {
    if (child) return;
    child = spawn(pythonCmd, ["-m", "graphify.serve", graphPath], {
      cwd: opts.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.on("exit", () => {
      rejectAll(new Error("graphify server exited"));
      child = null;
      initialized = false;
    });
    child.on("error", (err) => {
      rejectAll(err);
      child = null;
      initialized = false;
    });
  };

  const request = (method: string, params: unknown): Promise<unknown> => {
    start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`graphify ${method} timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "corpocode", version: "0.1.0" },
    });
    start();
    child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    initialized = true;
  };

  // MCP tools/call returns { content: [{type:"text", text}], … }; unwrap and JSON-parse the text.
  const unwrap = (result: unknown): unknown => {
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (r && Array.isArray(r.content)) {
      const text = r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  };

  return {
    async callTool(name, args) {
      await ensureInitialized();
      return unwrap(await request("tools/call", { name, arguments: args }));
    },
    async ping() {
      try {
        await ensureInitialized();
        await request("tools/list", {});
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        child = null;
        initialized = false;
      }
    },
  };
}
