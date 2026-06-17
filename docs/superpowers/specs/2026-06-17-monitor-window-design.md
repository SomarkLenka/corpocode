# CorpoCode Monitor Window — Design

Date: 2026-06-17
Status: Approved (pending spec review)
Branch: `feat/monitor-window`

## Purpose

Give a CorpoCode user a live "application window" that shows what the caretakers are doing
**right now**, as it happens. The headline view is the **flow narrative** (the human-readable
account of each hook firing); a secondary **event feed** exposes the raw structured events for
debugging. Today the only way to watch CorpoCode work is to `tail -f` two log files and read
them by eye — this turns that into a real, filterable window.

Out of scope (YAGNI for this build): cost/latency dashboards, per-component health tiles,
cross-project aggregation, historical analytics, writing to or controlling CorpoCode.
This is a **read-only viewer** of logs that already exist.

## What we monitor

CorpoCode already emits everything we need, append-only, in the project-local state dir
(`<cwd>/.corpocode/logs/`):

- **`corpocode-flow.log`** — human-readable narrative. Each hook appends one *block*,
  separated by a `═`×76 rule line. A block header reads:
  `▶ <HookName>  ·  <detail>  ·  <ISO ts>  ·  session <short id>`
  followed by a transcript-delta section and a hook-output section. The global flow log
  **already interleaves every session** for the project (each block is session-labeled), so
  monitoring "all sessions in this project" = tailing this one file.
- **`corpocode.ndjson`** — one structured JSON event per line: `ts`, `event`, `session_id`,
  `component`, `cost_usd`, `latency_ms`, `provider`, `model`, plus arbitrary fields. Also
  already global-per-project.

Paths come from `config/paths.ts` (`flowLogFile(cwd)`, `logFile(cwd)`); the monitor adds no
new path knowledge.

## Why this approach

The flow narrative's value is the transcript-slice ↔ hook-decision interleaving produced by
`src/log/flow.ts`. That is not cheaply reconstructable from the ndjson, so we **read the flow
log directly** rather than re-deriving it (which would duplicate `flow.ts` logic — an
Atomicity/Maintainability smell). The ndjson is already structured, so the event feed is a
trivial `JSON.parse` per line.

Transport is **SSE** (server→browser only, one-directional) rather than WebSocket: simpler,
and the browser's `EventSource` gives free auto-reconnect when the server restarts.

No new runtime dependencies: Node's built-in `http` + `fs` on the server, vanilla HTML/CSS/JS
in the page. This keeps the "single esbuild bundle, no `node_modules` at runtime" property.

## Command

```
corpocode monitor [--port <n>] [--no-open] [--lines <n>]
```

- Starts a local HTTP server bound to `127.0.0.1` (loopback only — never exposes logs to the
  network), prints the URL, and **opens the default browser to it by default**.
- `--no-open` suppresses the auto-open.
- `--port <n>` pins the port. Default behavior: try a fixed default port (`4319`); if it is
  busy and no explicit `--port` was given, fall back to a free ephemeral port. If an explicit
  `--port` is busy, error and exit non-zero (don't silently pick another).
- `--lines <n>` sets the backfill depth (**default 200**): on window load, show the last N
  lines/blocks of existing log, then go live.
- Foreground process; Ctrl-C (SIGINT) shuts the server down cleanly.

## Module layout — `src/monitor/`

Each unit does one thing, names itself for it, and is testable in isolation.

- **`tail.ts`** — follow one append-only file from a byte offset. On change, read the new
  slice, yield complete units (lines for ndjson; raw text for flow), and **buffer an
  incomplete trailing fragment** until the rest arrives (writes can be observed mid-line).
  Handles: file not yet created (corpocode hasn't run), truncation/rotation (offset > size ⇒
  reset to 0), and read errors (degrade this stream, don't throw). Uses `fs.watch` with a
  polling fallback (`fs.watch` is unreliable on some platforms/filesystems).
- **`flow-parse.ts`** — split flow text into blocks on the `═` rule and parse each block's
  header into `{ hookName, detail, ts, sessionId }` so the client can filter by session and
  hook. Buffers an incomplete trailing block (no closing boundary yet). The rule string is
  shared with `src/log/flow.ts` via a small exported constant so the two never drift.
- **`server.ts`** — Node `http` server:
  - `GET /` → reads and serves `app.html` from disk (resolved relative to the project's
    `src/monitor/` during dev; the path is computed in one place so the later inline swap is a
    single-file change). Missing file ⇒ clear 500 with a "run from the repo / not yet built"
    hint rather than a blank window.
  - `GET /stream` → SSE. On connect: backfill the last `--lines` from both files (parsed),
    then stream live appends. Distinct SSE event types: `flow` (a parsed flow block) and
    `event` (a parsed ndjson row), plus a `meta`/`ready` frame for initial state.
  - Binds loopback only.
- **`app.html`** — the page content (HTML + CSS + JS) as a **separate static file** that
  `server.ts` reads from disk at runtime and serves on `GET /`. Kept out of the esbuild bundle
  **for now** so the page can be edited and reloaded without rebuilding `bin/corpocode.js` while
  we verify functionality. (Once verified, a follow-up will inline it into the bundle so the
  "single self-contained bundle, no `node_modules` at runtime" property holds for releases — see
  Deferred below.) Two views:
  - **Flow** (primary): rendered blocks, color-coded per hook name, **session filter**,
    auto-scroll that **pauses when the user scrolls up** and resumes at the bottom.
  - **Events** (secondary): raw ndjson rows in a compact table for debugging.
  - **"waiting for activity…"** empty state when the logs don't exist or are empty yet.

Wiring: register the command in `src/cli.ts` and add it to `src/cli-commands.ts` (`COMMANDS`)
so it appears in `corpocode --help`.

## Data flow

```
fs.watch / poll  →  tail (new bytes, buffered)  →  flow-parse | JSON.parse
                 →  SSE frame (flow | event)     →  browser appends to live view
```

## Failure handling (In-flight tenet)

- Server **starts even if the log files don't exist yet** — the page shows the waiting state
  and begins streaming the moment the first block/line is written.
- A tailer error on one file degrades **only that stream**; the other stream and the server
  keep running. Errors are logged to the server's stdout (it's a foreground CLI), never
  swallowed silently.
- `EventSource` reconnects automatically if the server is restarted; on reconnect the client
  resumes from where it left off (server tracks per-connection offset; no duplicate backfill).
- Port handling per the command section: explicit `--port` busy ⇒ clear error + non-zero exit;
  default port busy ⇒ fall back to a free ephemeral port.

## Logging / Observability

The monitor is a foreground developer tool: it prints its bound URL and any stream-degradation
warnings to stdout/stderr with actionable context (what failed, which file, what to check). It
does **not** write into CorpoCode's own ndjson/flow logs (it is a reader, not a caretaker).

## Testing (vitest)

- **`tail`**: offset advances past read bytes; partial-line fragment is buffered then completed;
  truncation (offset > current size) resets to 0; missing file yields nothing and does not throw;
  multiple appends are read in order.
- **`flow-parse`**: splits on the rule into blocks; parses header fields (hookName, detail, ts,
  session); buffers an incomplete trailing block until its boundary arrives; ignores malformed
  headers gracefully.
- **`server`** (smoke): boots on an ephemeral port; `GET /` returns the SPA HTML; a line written
  to a watched temp file is delivered as an SSE frame on `/stream`; backfill returns the last N.

Failure paths are tested as deliberately as the happy path (missing file, truncation, partial
writes, malformed lines).

## Deferred (after functionality is verified)

- **Inline `app.html` into the bundle.** Replace the disk read in `server.ts` with the page
  content compiled into `bin/corpocode.js` (e.g. an esbuild text/loader import or a generated
  constant), restoring the self-contained-bundle property for published releases. Because the
  path is resolved in one place, this is a localized swap. Until then, `corpocode monitor` is
  intended to be run from a built checkout of the repo, not a published npm install.

## Open defaults (decided)

- Auto-open browser: **yes** by default (`--no-open` to suppress).
- Backfill on load: **yes**, `--lines 200` default.
- Bind address: loopback (`127.0.0.1`) only.
