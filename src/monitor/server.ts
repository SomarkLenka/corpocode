// The monitor's HTTP server: serves the single-page app on `/` and a live Server-Sent-Events feed
// on `/stream`. It is a read-only viewer of two files corpocode already writes — the flow log and the
// ndjson event log — so it adds no path knowledge and never writes into corpocode's own state.
//
// Transport is SSE because traffic is one-directional (server → browser); the browser's EventSource
// gives free auto-reconnect when this server restarts. Each connection backfills the last `lines`
// units of both files, then polls for appends. Per the In-flight tenet, a read error on one file
// degrades only that stream (logged, not thrown) and the server keeps serving the other.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createTailer, createLineBuffer } from "./tail";
import { createFlowParser, type FlowBlock } from "./flow-parse";
import { explain, type LogRecord } from "../log/explain";

export interface MonitorServerOptions {
  /** corpocode-flow.log for this project. */
  flowFile: string;
  /** corpocode.ndjson for this project. */
  ndjsonFile: string;
  /** Path to the page served on `/`. */
  htmlPath: string;
  /** Backfill depth: number of trailing blocks/lines shown on connect. */
  lines: number;
  /** Poll interval for new bytes, ms (default 500). */
  pollMs?: number;
  /** Sink for stream-degradation warnings (default process.stderr). */
  onWarn?: (message: string) => void;
}

interface NdjsonRow {
  [key: string]: unknown;
}

function parseRow(line: string): NdjsonRow {
  try {
    return JSON.parse(line) as NdjsonRow;
  } catch {
    return { raw: line }; // surface a malformed line rather than dropping it
  }
}

// Parse a raw ndjson line and attach its plain-language explanation (`_why`) when the event has one.
// This is `corpocode why`'s narration, computed per-record so the live Events feed reads as decisions,
// not raw JSON — the same describe() table both surfaces share (../log/explain). Untranslated or
// malformed rows carry no `_why` and the client falls back to showing their fields verbatim.
function eventRow(line: string): NdjsonRow {
  const row = parseRow(line);
  const why = explain(row as LogRecord);
  return why ? { ...row, _why: why } : row;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function servePage(res: ServerResponse, htmlPath: string, warn: (m: string) => void): void {
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    warn(`monitor: could not read page at ${htmlPath}`);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Monitor page not found at ${htmlPath}.\nRun \`corpocode monitor\` from a built repo checkout.`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MonitorServerOptions,
  pollMs: number,
  warn: (m: string) => void,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const flowTailer = createTailer(opts.flowFile);
  const ndjsonTailer = createTailer(opts.ndjsonFile);
  const flowParser = createFlowParser();
  const lineBuffer = createLineBuffer();

  const safeRead = (tailer: { read(): string }, label: string): string => {
    try {
      return tailer.read();
    } catch (err) {
      warn(`monitor: ${label} stream read failed: ${String(err)}`);
      return "";
    }
  };

  // Backfill: one read of each file gives the whole existing content and primes the tailer to EOF,
  // so the live poll that follows never resends it.
  const initialBlocks = flowParser.push(safeRead(flowTailer, "flow"));
  for (const b of initialBlocks.slice(-opts.lines)) sse(res, "flow", b);
  const initialLines = lineBuffer.push(safeRead(ndjsonTailer, "ndjson"));
  for (const l of initialLines.slice(-opts.lines)) sse(res, "event", eventRow(l));
  sse(res, "ready", { flow: Math.min(initialBlocks.length, opts.lines), events: Math.min(initialLines.length, opts.lines) });

  const timer = setInterval(() => {
    for (const b of flowParser.push(safeRead(flowTailer, "flow"))) sse(res, "flow", b);
    for (const l of lineBuffer.push(safeRead(ndjsonTailer, "ndjson"))) sse(res, "event", eventRow(l));
  }, pollMs);

  const stop = (): void => clearInterval(timer);
  req.on("close", stop);
  res.on("close", stop);
}

export function createMonitorServer(opts: MonitorServerOptions): Server {
  const pollMs = opts.pollMs ?? 500;
  const warn = opts.onWarn ?? ((m: string) => process.stderr.write(`${m}\n`));

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/") return servePage(res, opts.htmlPath, warn);
    if (path === "/stream") return serveStream(req, res, opts, pollMs, warn);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
}

export type { FlowBlock };
