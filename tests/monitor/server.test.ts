import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type Server } from "node:http";
import { createMonitorServer } from "../../src/monitor/server";

const dirs: string[] = [];
const servers: Server[] = [];

function tmp(): { dir: string; flow: string; ndjson: string; html: string } {
  const dir = mkdtempSync(join(tmpdir(), "cc-monitor-"));
  dirs.push(dir);
  const html = join(dir, "app.html");
  writeFileSync(html, "<!doctype html><title>monitor</title>");
  return { dir, flow: join(dir, "flow.log"), ndjson: join(dir, "events.ndjson"), html };
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function getText(port: number, path: string): Promise<{ status: number; body: string; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
  });
}

/** Open the SSE stream, collect frames until `predicate` is satisfied or it times out. */
function collectStream(port: number, predicate: (acc: string) => boolean, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
      let acc = "";
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`stream timeout; got:\n${acc}`));
      }, timeoutMs);
      res.on("data", (c) => {
        acc += c;
        if (predicate(acc)) {
          clearTimeout(timer);
          req.destroy();
          resolve(acc);
        }
      });
    });
    req.on("error", (e) => {
      // destroy() after resolve triggers ECONNRESET; ignore once we already have what we need.
      if (!String(e).includes("ECONNRESET")) reject(e);
    });
  });
}

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("monitor server", () => {
  it("serves the page on GET /", async () => {
    const { flow, ndjson, html } = tmp();
    const port = await listen(createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: html, lines: 200 }));
    const res = await getText(port, "/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("monitor");
  });

  it("returns a helpful 500 when the page is missing", async () => {
    const { flow, ndjson, dir } = tmp();
    const port = await listen(
      createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: join(dir, "nope.html"), lines: 200, onWarn: () => {} }),
    );
    const res = await getText(port, "/");
    expect(res.status).toBe(500);
    expect(res.body).toContain("not found");
  });

  it("backfills existing ndjson events then streams new ones", async () => {
    const { flow, ndjson, html } = tmp();
    writeFileSync(ndjson, `${JSON.stringify({ event: "old", component: "router" })}\n`);
    const port = await listen(
      createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: html, lines: 200, pollMs: 20 }),
    );

    // Once the backfill + ready frame is received, append a new line and expect it to stream through.
    const streamed = collectStream(port, (acc) => acc.includes('"event":"live"'));
    // Give the connection a tick to send backfill, then append.
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(ndjson, `${JSON.stringify({ event: "live", component: "verifier" })}\n`);

    const acc = await streamed;
    expect(acc).toContain('"event":"old"'); // backfill
    expect(acc).toContain("event: ready"); // ready frame
    expect(acc).toContain('"event":"live"'); // live append
  });

  it("attaches the `corpocode why` narration (`_why`) to translatable events", async () => {
    const { flow, ndjson, html } = tmp();
    const port = await listen(
      createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: html, lines: 200, pollMs: 20 }),
    );
    const streamed = collectStream(port, (acc) => acc.includes('"event":"filter"'));
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(ndjson, `${JSON.stringify({ event: "filter", component: "filter", decision: "deny", tool: "Bash", reason: "rm -rf" })}\n`);

    const acc = await streamed;
    expect(acc).toContain('"_why"'); // narration attached
    expect(acc).toContain("Denied"); // the plain-language decision rode along
  });

  it("leaves untranslatable events without a `_why` field", async () => {
    const { flow, ndjson, html } = tmp();
    writeFileSync(ndjson, `${JSON.stringify({ event: "heartbeat", component: "misc" })}\n`);
    const port = await listen(
      createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: html, lines: 200, pollMs: 20 }),
    );
    const acc = await collectStream(port, (acc) => acc.includes("event: ready"));
    expect(acc).toContain('"event":"heartbeat"');
    expect(acc).not.toContain("_why");
  });

  it("streams flow blocks as they are appended", async () => {
    const { flow, ndjson, html } = tmp();
    const port = await listen(
      createMonitorServer({ flowFile: flow, ndjsonFile: ndjson, htmlPath: html, lines: 200, pollMs: 20 }),
    );
    const RULE = "═".repeat(76);
    const block = `\n${RULE}\n▶ PreToolUse  ·  Edit  ·  2026-06-17T10:00:00.000Z  ·  session abcd1234\n${RULE}\n\n╶ transcript (1 entry) ╴\n\n  hi\n\n╶ hook output ╴\n\n  (no output)\n`;

    const streamed = collectStream(port, (acc) => acc.includes('"hookName":"PreToolUse"'));
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(flow, block);

    const acc = await streamed;
    expect(acc).toContain("event: flow");
    expect(acc).toContain('"sessionId":"abcd1234"');
  });
});
