// The web Interactor — the Phase 2 cockpit surface. Same hand-rolled node:http shape as the
// monitor (src/monitor/server.ts): bound to 127.0.0.1 ONLY, zero dependencies, browser opened
// best-effort. Loopback-only is a privacy invariant, not a convenience — polls carry the spec
// interrogation and the decision feed, and neither may ever be reachable off the machine.
//
// Transport is SSE for the server→browser direction (poll broadcasts, narration, the section
// ledger) because EventSource gives every tab free auto-reconnect; the one browser→server
// message — the pilot's answer — is a plain POST. Multiple tabs may watch; the pending poll and
// a bounded feed buffer are replayed on connect so a late-joining tab sees the same cockpit.
//
// Fail-open per the Interactor contract: ask() NEVER throws and never hangs forever. When the
// surface dies (close() with no answer, ask after close) the poll resolves its declared default
// (`source: "default"`) or null — the caller pauses the run — never a crash, never a guess.
// Only ONE poll is pending at a time by construction (the cockpit is sequential); a second ask
// arriving while one is open defensively defaults the first rather than losing either.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { Answer, CockpitNote, Interactor, Poll } from "./types";

const HOST = "127.0.0.1";
const FEED_LIMIT = 200; // replay depth for late tabs — enough scrollback, bounded memory

export interface WebInteractorOptions {
  /** 0 (the default) picks an ephemeral port — the URL is whatever the OS granted. */
  port?: number;
  /** Browser launcher, injectable so tests never spawn anything. Default: best-effort spawn. */
  openBrowser?: (url: string) => void;
  now?: () => number;
}

export interface WebInteractor extends Interactor {
  readonly url: string;
  readonly port: number;
}

/** One frame on the SSE stream. `say`/`note` carry a timestamp so replayed narration still
 *  reads in order of occurrence, not order of connection. */
type CockpitEvent =
  | { type: "poll"; poll: Poll }
  | { type: "say"; text: string; ts: number }
  | { type: "note"; note: CockpitNote; ts: number }
  | { type: "resolved"; pollId: string };

// ── shared answer rules (identical to terminal/scripted so every surface lands the same) ────────

/** Delegation resolves to the recommendation when one exists, else the default, else the first
 *  option — "you decide" must always land on a real option so the ledger stays well-formed. */
function delegatedOptionId(poll: Poll): string | undefined {
  return poll.options.find((o) => o.recommended)?.id ?? poll.defaultOptionId ?? poll.options[0]?.id;
}

/** The dead-channel resolution: the declared default, or null (the caller pauses the run). */
function resolveDefault(poll: Poll): Answer | null {
  return poll.defaultOptionId ? { pollId: poll.id, optionId: poll.defaultOptionId, source: "default" } : null;
}

/** Open `url` in the default browser, fail-open — same pattern as `corpocode monitor`: a launch
 *  failure just leaves the pilot to click the URL, it never takes the cockpit down. */
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
    // best-effort; the caller already knows the URL
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────────────────────────

function respond(res: ServerResponse, status: number, text?: string): void {
  try {
    if (text === undefined) {
      res.writeHead(status);
      res.end();
    } else {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    }
  } catch {
    // the tab left mid-response — nothing to salvage
  }
}

/** Read the whole request body, bounded — an answer is a few hundred bytes; anything huge is
 *  not an answer. Errors resolve with what arrived; the JSON parse downstream rejects garbage. */
function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        resolve("");
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(body));
  });
}

// ── the interactor ───────────────────────────────────────────────────────────────────────────────

export async function createWebInteractor(opts: WebInteractorOptions = {}): Promise<WebInteractor> {
  const now = opts.now ?? (() => Date.now());

  let closed = false;
  let pendingPoll: Poll | null = null;
  let pendingResolve: ((answer: Answer | null) => void) | null = null;

  const clients = new Set<ServerResponse>();
  // The replay state for late tabs: the newest sections note (only the latest matters — lamps
  // are state, not history) plus a bounded feed of say/decision/phase events.
  let latestSections: CockpitEvent | null = null;
  const feed: CockpitEvent[] = [];

  const sse = (res: ServerResponse, ev: CockpitEvent): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const broadcast = (ev: CockpitEvent): void => {
    for (const res of [...clients]) {
      try {
        sse(res, ev);
      } catch {
        clients.delete(res); // a dead tab is just a tab that left
      }
    }
  };

  const remember = (ev: CockpitEvent): void => {
    feed.push(ev);
    if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT);
  };

  /** Resolve (and clear) the pending poll with `answer`, telling every tab it is settled. */
  const settle = (answer: Answer | null): void => {
    const poll = pendingPoll;
    const resolve = pendingResolve;
    pendingPoll = null;
    pendingResolve = null;
    if (poll) broadcast({ type: "resolved", pollId: poll.id });
    resolve?.(answer);
  };

  const serveEvents = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Replay: ledger state first (the header renders before the feed), then narration in
      // arrival order, then the open poll — so a fresh tab is indistinguishable from an old one.
      if (latestSections) sse(res, latestSections);
      for (const ev of feed) sse(res, ev);
      if (pendingPoll) sse(res, { type: "poll", poll: pendingPoll });
    } catch {
      return; // the tab died during replay — never let a viewer error reach the run
    }
    clients.add(res);
    const drop = (): void => {
      clients.delete(res);
    };
    req.on("close", drop);
    res.on("close", drop);
  };

  const handleAnswer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return respond(res, 400, "body must be a JSON object");
      body = parsed as Record<string, unknown>;
    } catch {
      return respond(res, 400, "malformed JSON body");
    }
    // Re-check the pending poll AFTER the body arrives — it may have been settled or replaced
    // while the bytes were in flight; a stale answer must never resolve the wrong poll.
    const poll = pendingPoll;
    if (!poll || body.pollId !== poll.id) return respond(res, 409, "no pending poll with that id");
    if (body.delegate === true) {
      const optionId = delegatedOptionId(poll);
      settle(optionId ? { pollId: poll.id, optionId, source: "delegated" } : resolveDefault(poll));
      return respond(res, 204);
    }
    if (typeof body.optionId === "string") {
      if (!poll.options.some((o) => o.id === body.optionId)) return respond(res, 400, "unknown optionId");
      settle({ pollId: poll.id, optionId: body.optionId, source: "pilot" });
      return respond(res, 204);
    }
    if (typeof body.freeText === "string" && body.freeText.length > 0) {
      if (!poll.allowFreeText) return respond(res, 400, "this poll does not accept free text");
      settle({ pollId: poll.id, freeText: body.freeText, source: "pilot" });
      return respond(res, 204);
    }
    return respond(res, 400, "answer needs optionId, freeText, or delegate:true");
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && path === "/events") return serveEvents(req, res);
    if (req.method === "POST" && path === "/answer") {
      void handleAnswer(req, res);
      return;
    }
    respond(res, 404, "not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://${HOST}:${port}`;

  const open = opts.openBrowser ?? openBrowser;
  try {
    open(url);
  } catch {
    // launching a browser is a courtesy, never a requirement
  }

  return {
    url,
    port,

    async ask(poll: Poll): Promise<Answer | null> {
      try {
        if (closed) return resolveDefault(poll);
        // Defensive: the cockpit asks one poll at a time, but if a second arrives the first
        // resolves its default (or pauses) — dropping a promise on the floor would hang the run.
        if (pendingPoll) settle(resolveDefault(pendingPoll));
        const answered = new Promise<Answer | null>((resolve) => {
          pendingResolve = resolve;
        });
        pendingPoll = poll;
        broadcast({ type: "poll", poll });
        return await answered;
      } catch {
        // ask() never throws — an unexpected failure reads as a dead channel
        return resolveDefault(poll);
      }
    },

    say(block: string): void {
      try {
        const ev: CockpitEvent = { type: "say", text: block, ts: now() };
        remember(ev);
        broadcast(ev);
      } catch {
        // narration is best-effort
      }
    },

    note(note: CockpitNote): void {
      try {
        const ev: CockpitEvent = { type: "note", note, ts: now() };
        if (note.kind === "sections") latestSections = ev;
        else remember(ev);
        broadcast(ev);
      } catch {
        // structured narration is just as best-effort as the plain kind
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        if (pendingPoll) settle(resolveDefault(pendingPoll));
        for (const res of clients) {
          try {
            res.end();
          } catch {
            // already gone
          }
        }
        clients.clear();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Keep-alive sockets (fetch, EventSource reconnects) would hold close() open forever.
          server.closeAllConnections();
        });
      } catch {
        // close() never throws; a half-dead server is still a closed surface
      }
    },
  };
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────
// One self-contained document — inline CSS + JS, no CDN, no external requests — because the page
// itself must honor the loopback invariant: nothing the cockpit shows may leak through a request
// to someone else's host. All dynamic content is inserted via textContent, never innerHTML, so
// poll text can contain anything the interrogator produces.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CorpoCode cockpit</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#14161a;color:#d6d9de}
header{display:flex;align-items:baseline;gap:18px;padding:10px 16px;border-bottom:1px solid #2a2e35;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600}
#ledger{display:flex;gap:12px;flex-wrap:wrap}
.lamp{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#9aa0aa}
.lamp::before{content:"";width:9px;height:9px;border-radius:50%;background:#555;flex:none}
.lamp.amber::before{background:#d9a441}
.lamp.green::before{background:#3fa550}
main{display:grid;grid-template-columns:minmax(260px,2fr) minmax(360px,3fr);gap:16px;padding:16px;max-width:1200px;margin:0 auto}
@media(max-width:760px){main{grid-template-columns:1fr}}
#feed{border:1px solid #2a2e35;border-radius:6px;padding:10px;overflow-y:auto;max-height:82vh}
.feed-line{padding:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.feed-line.decision{color:#8ec6e6}
.feed-line.phase{color:#c7a5e8}
#poll-card{border:1px solid #2a2e35;border-radius:6px;padding:14px;align-self:start}
.teaching{background:#1d2330;border-left:3px solid #5b7fd4;border-radius:0 4px 4px 0;padding:8px 10px;margin-bottom:12px;white-space:pre-wrap}
.teaching b{display:block;margin-bottom:4px;color:#9db6ea}
.question{font-size:16px;font-weight:600;margin:4px 0 12px}
.option{border:1px solid #2a2e35;border-radius:6px;padding:10px;margin-bottom:10px;cursor:pointer}
.option.selected{border-color:#d9a441;background:#1b1e24}
.opt-label{font-weight:600}
.badge{color:#3fa550;font-size:12px;margin-left:6px;font-weight:400}
table.findings{border-collapse:collapse;margin-top:6px;width:100%}
table.findings td{padding:2px 10px 2px 0;font-size:12px;vertical-align:top}
.sev-info{color:#9aa0aa}.sev-warn{color:#d9a441}.sev-risk{color:#e06c60}
.sev-unanalyzed{color:#6b7078;font-style:italic}
.controls{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
button{background:#242a33;color:#d6d9de;border:1px solid #3a414c;border-radius:5px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:#d9a441}
input[type=text]{flex:1;background:#101216;color:#d6d9de;border:1px solid #3a414c;border-radius:5px;padding:6px 8px;min-width:160px;font:inherit}
.quiet{color:#6b7078}
</style>
</head>
<body>
<header>
  <h1>CorpoCode cockpit</h1>
  <div id="ledger"></div>
</header>
<main>
  <section id="feed"></section>
  <section id="poll-card"><div class="quiet">waiting for the first poll…</div></section>
</main>
<script>
(function () {
  "use strict";
  var current = null;
  var selected = null;
  var ledger = document.getElementById("ledger");
  var feed = document.getElementById("feed");
  var card = document.getElementById("poll-card");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function feedLine(cls, text) {
    feed.appendChild(el("div", cls ? "feed-line " + cls : "feed-line", text));
    feed.scrollTop = feed.scrollHeight;
  }
  function post(body) {
    fetch("/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).catch(function () {});
  }

  function renderLamps(statuses) {
    ledger.textContent = "";
    Object.keys(statuses).forEach(function (name) {
      var green = statuses[name] === "complete";
      ledger.appendChild(el("span", "lamp " + (green ? "green" : "amber"), name));
    });
  }

  function renderPoll(poll) {
    current = poll;
    selected = null;
    card.textContent = "";
    if (poll.teaching) {
      var t = el("div", "teaching");
      t.appendChild(el("b", null, "teaching: " + poll.teaching.concept));
      t.appendChild(el("span", null, poll.teaching.body));
      card.appendChild(t);
    }
    card.appendChild(el("div", "question", poll.question));
    poll.options.forEach(function (opt) {
      var box = el("div", "option");
      box.dataset.id = opt.id;
      var head = el("div", "opt-label", opt.label);
      if (opt.recommended) head.appendChild(el("span", "badge", "(recommended)"));
      box.appendChild(head);
      if (opt.description) box.appendChild(el("div", "quiet", opt.description));
      if (opt.findings.length) {
        var tbl = el("table", "findings");
        opt.findings.forEach(function (f) {
          var tr = el("tr");
          tr.appendChild(el("td", null, f.axis));
          tr.appendChild(el("td", f.ok ? "sev-" + f.severity : "sev-unanalyzed", f.ok ? f.severity : "?"));
          tr.appendChild(el("td", f.ok ? null : "sev-unanalyzed", f.ok ? f.summary : "unanalyzed"));
          tbl.appendChild(tr);
        });
        box.appendChild(tbl);
      }
      box.onclick = function () {
        selected = opt.id;
        Array.prototype.forEach.call(card.querySelectorAll(".option"), function (n) {
          n.classList.toggle("selected", n.dataset.id === opt.id);
        });
      };
      card.appendChild(box);
    });
    var controls = el("div", "controls");
    var submit = el("button", null, "answer");
    submit.onclick = function () {
      if (current && selected) post({ pollId: current.id, optionId: selected });
    };
    controls.appendChild(submit);
    if (poll.allowDelegate) {
      var d = el("button", null, "you decide");
      d.onclick = function () {
        if (current) post({ pollId: current.id, delegate: true });
      };
      controls.appendChild(d);
    }
    card.appendChild(controls);
    if (poll.allowFreeText) {
      var row = el("div", "controls");
      var input = el("input");
      input.type = "text";
      input.placeholder = "answer in your own words";
      var send = el("button", null, "send");
      send.onclick = function () {
        if (current && input.value.trim()) post({ pollId: current.id, freeText: input.value.trim() });
      };
      input.onkeydown = function (e) {
        if (e.key === "Enter") send.onclick();
      };
      row.appendChild(input);
      row.appendChild(send);
      card.appendChild(row);
    }
  }

  function handle(ev) {
    if (ev.type === "poll") renderPoll(ev.poll);
    else if (ev.type === "say") feedLine(null, ev.text);
    else if (ev.type === "resolved") {
      if (current && current.id === ev.pollId) {
        current = null;
        card.textContent = "";
        card.appendChild(el("div", "quiet", "decision recorded — waiting for the next poll…"));
      }
    } else if (ev.type === "note") {
      var n = ev.note;
      if (n.kind === "sections") renderLamps(n.statuses);
      else if (n.kind === "decision") feedLine("decision", "decision " + n.concept + ": " + (n.chosen || "(free text)") + " [" + n.source + "]");
      else if (n.kind === "phase") feedLine("phase", "phase: " + n.phase + (n.detail ? " — " + n.detail : ""));
    }
  }

  var es = new EventSource("/events");
  es.onmessage = function (m) {
    try {
      handle(JSON.parse(m.data));
    } catch (e) {
      /* a malformed frame is skipped, never fatal */
    }
  };
})();
</script>
</body>
</html>
`;
