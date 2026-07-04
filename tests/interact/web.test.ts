// The web Interactor, driven over real loopback HTTP — no browser, no spawned process (the
// browser launcher is always injected as a spy). The load-bearing guarantees under test mirror
// the terminal suite plus the HTTP surface: a POSTed answer resolves ask(), bad answers are
// rejected without disturbing the pending poll, SSE replays cockpit state to late-joining tabs,
// and a dying surface resolves the declared default (or null ⇒ pause).
import { describe, it, expect, afterEach } from "vitest";
import { get } from "node:http";
import { createWebInteractor, type WebInteractor } from "../../src/interact/web";
import type { AxisFinding, Poll } from "../../src/interact/types";

function finding(axis: string, optionId: string, over: Partial<AxisFinding> = {}): AxisFinding {
  return { axis, optionId, summary: `${axis} impact`, severity: "info", ok: true, ...over };
}

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: "p1",
    concept: "storage",
    question: "Where does state live?",
    options: [
      { id: "a", label: "SQLite", description: "One file on disk.", findings: [finding("performance", "a")] },
      { id: "b", label: "Postgres", findings: [finding("performance", "b")], recommended: true },
    ],
    allowFreeText: true,
    allowDelegate: true,
    ...over,
  };
}

const live: WebInteractor[] = [];

async function make(opts: { port?: number } = {}): Promise<{ ix: WebInteractor; opened: string[] }> {
  const opened: string[] = [];
  const ix = await createWebInteractor({ ...opts, openBrowser: (u) => opened.push(u) });
  live.push(ix);
  return { ix, opened };
}

afterEach(async () => {
  for (const ix of live.splice(0)) await ix.close();
});

function postAnswer(ix: WebInteractor, body: unknown): Promise<number> {
  return fetch(`${ix.url}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.status);
}

/** Open the SSE stream raw and collect frames until `predicate` is satisfied or it times out.
 *  The predicate runs on every chunk, so it can also trigger mid-stream actions (post an answer
 *  once the replayed poll has arrived) without racing the connection setup. */
function collectEvents(ix: WebInteractor, predicate: (acc: string) => boolean, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(`${ix.url}/events`, (res) => {
      let acc = "";
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`events timeout; got:\n${acc}`));
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

describe("createWebInteractor — creation and the page", () => {
  it("resolves with a live loopback url and opens the browser exactly once", async () => {
    const { ix, opened } = await make();
    expect(ix.port).toBeGreaterThan(0);
    expect(ix.url).toBe(`http://127.0.0.1:${ix.port}`);
    expect(opened).toEqual([ix.url]);
  });

  it("GET / serves the self-contained cockpit page with the poll scaffolding", async () => {
    const { ix } = await make();
    const res = await fetch(`${ix.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="ledger"');
    expect(html).toContain('id="feed"');
    expect(html).toContain('id="poll-card"');
    expect(html).toContain("EventSource"); // the page wires itself to /events
    // The loopback invariant extends to the page itself: no external fetches, no CDN scripts.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("unknown paths 404", async () => {
    const { ix } = await make();
    const res = await fetch(`${ix.url}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("POST /answer — resolving the pending ask()", () => {
  it("a valid optionId resolves ask() as the pilot's answer and returns 204", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    expect(await postAnswer(ix, { pollId: "p1", optionId: "b" })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "b", source: "pilot" });
  });

  it("free text resolves freeText when the poll allows it", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    expect(await postAnswer(ix, { pollId: "p1", freeText: "keep it in memory, honestly" })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", freeText: "keep it in memory, honestly", source: "pilot" });
  });

  it("a wrong pollId is 409 and leaves the pending poll answerable", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    expect(await postAnswer(ix, { pollId: "someone-else", optionId: "a" })).toBe(409);
    expect(await postAnswer(ix, { pollId: "p1", optionId: "a" })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "a", source: "pilot" });
  });

  it("answering when nothing is pending is 409", async () => {
    const { ix } = await make();
    expect(await postAnswer(ix, { pollId: "p1", optionId: "a" })).toBe(409);
  });

  it("an unknown optionId is 400", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    expect(await postAnswer(ix, { pollId: "p1", optionId: "zz" })).toBe(400);
    expect(await postAnswer(ix, { pollId: "p1", optionId: "a" })).toBe(204);
    await answered;
  });

  it("free text is 400 when the poll forbids it", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll({ allowFreeText: false }));
    expect(await postAnswer(ix, { pollId: "p1", freeText: "rambling" })).toBe(400);
    expect(await postAnswer(ix, { pollId: "p1", optionId: "a" })).toBe(204);
    await answered;
  });

  it("a malformed body is 400, not a crash", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    const res = await fetch(`${ix.url}/answer`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
    expect(await postAnswer(ix, { pollId: "p1", optionId: "a" })).toBe(204);
    await answered;
  });
});

describe("POST /answer — delegation resolution order", () => {
  it("delegates to the recommended option when one exists", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll({ defaultOptionId: "a" })); // recommendation must outrank the default
    expect(await postAnswer(ix, { pollId: "p1", delegate: true })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "b", source: "delegated" });
  });

  it("falls back to defaultOptionId when nothing is recommended", async () => {
    const { ix } = await make();
    const p = poll({ defaultOptionId: "a" });
    p.options = p.options.map((o) => ({ ...o, recommended: undefined }));
    const answered = ix.ask(p);
    expect(await postAnswer(ix, { pollId: "p1", delegate: true })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "a", source: "delegated" });
  });

  it("falls back to the first option when there is no recommendation and no default", async () => {
    const { ix } = await make();
    const p = poll();
    p.options = p.options.map((o) => ({ ...o, recommended: undefined }));
    const answered = ix.ask(p);
    expect(await postAnswer(ix, { pollId: "p1", delegate: true })).toBe(204);
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "a", source: "delegated" });
  });
});

describe("GET /events — the SSE stream", () => {
  it("replays the pending poll on connect, then pushes resolved after an answer", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    let posted = false;
    const acc = await collectEvents(ix, (s) => {
      // Answer only after the replayed poll proves the stream is attached — otherwise the
      // resolved broadcast could fire before this tab exists and never arrive.
      if (!posted && s.includes('"type":"poll"')) {
        posted = true;
        void postAnswer(ix, { pollId: "p1", optionId: "a" });
      }
      return s.includes('"type":"resolved"');
    });
    expect(acc).toContain('"Where does state live?"');
    expect(acc).toContain('"type":"resolved"');
    expect(acc).toContain('"pollId":"p1"');
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "a", source: "pilot" });
  });

  it("replays say() blocks and notes sent before any tab connected", async () => {
    const { ix } = await make();
    ix.say("hello from the swarm");
    ix.note?.({ kind: "sections", statuses: { "api-spec": "in-progress", parallelization: "complete" } });
    ix.note?.({ kind: "decision", pollId: "p0", concept: "storage", source: "pilot", chosen: "SQLite" });
    ix.note?.({ kind: "phase", phase: "interrogation" });

    const acc = await collectEvents(ix, (s) => s.includes('"phase":"interrogation"'));
    expect(acc).toContain("hello from the swarm");
    expect(acc).toContain('"api-spec":"in-progress"'); // the latest ledger state rides along
    expect(acc).toContain('"chosen":"SQLite"');
    // Ledger state replays before the feed so the lamps render before the narration.
    expect(acc.indexOf('"kind":"sections"')).toBeLessThan(acc.indexOf("hello from the swarm"));
  });

  it("broadcasts live events to an already-connected tab", async () => {
    const { ix } = await make();
    const stream = collectEvents(ix, (s) => s.includes("live narration"));
    await new Promise((r) => setTimeout(r, 60)); // let the tab attach before narrating
    ix.say("live narration");
    expect(await stream).toContain('"type":"say"');
  });
});

describe("close() and the dead-surface edge", () => {
  it("close() mid-ask resolves the declared default with source 'default'", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll({ defaultOptionId: "a" }));
    await ix.close();
    await expect(answered).resolves.toEqual({ pollId: "p1", optionId: "a", source: "default" });
  });

  it("close() mid-ask with no default resolves null — the caller pauses the run", async () => {
    const { ix } = await make();
    const answered = ix.ask(poll());
    await ix.close();
    await expect(answered).resolves.toBeNull();
  });

  it("close() is idempotent and asks after close resolve the default without touching HTTP", async () => {
    const { ix } = await make();
    await ix.close();
    await ix.close();
    await expect(ix.ask(poll({ defaultOptionId: "b" }))).resolves.toEqual({ pollId: "p1", optionId: "b", source: "default" });
    await expect(ix.ask(poll())).resolves.toBeNull();
  });

  it("a second ask while one is pending defensively defaults the first", async () => {
    const { ix } = await make();
    const first = ix.ask(poll({ id: "p1", defaultOptionId: "a" }));
    const second = ix.ask(poll({ id: "p2" }));
    await expect(first).resolves.toEqual({ pollId: "p1", optionId: "a", source: "default" });
    expect(await postAnswer(ix, { pollId: "p2", optionId: "b" })).toBe(204);
    await expect(second).resolves.toEqual({ pollId: "p2", optionId: "b", source: "pilot" });
  });

  it("say()/note() after close never throw", async () => {
    const { ix } = await make();
    await ix.close();
    expect(() => ix.say("after death")).not.toThrow();
    expect(() => ix.note?.({ kind: "phase", phase: "landing" })).not.toThrow();
  });
});
