# Design — `corpocode why` decision inspector (B1)

**Date:** 2026-07-02
**Status:** Draft for review
**Scope:** A read-only CLI command that translates CorpoCode's NDJSON event log into a human-readable
account of the silent decisions each hook made — why a file was injected, why a tool was denied, what
the router picked, what `bug-hunt` did. It is the observability counterpart to A1: the moment the
IntelligentRouter starts injecting things, users need to see *why*. B1 **consumes** the `pattern`
decision-event schema pinned in the A1 spec (§5 there); it adds no new event and changes no hook.

---

## 1. Goal

Answer the question "what did CorpoCode just do to my turn, and why?" from the log CorpoCode already
writes. `corpocode why` reads the project-local NDJSON event log, picks a session (most recent by
default), and prints one plain-language line per decision, in time order:

```
Why — session a1b2c3d4 · 6 decisions · 2026-07-02 14:03–14:05

  14:03:11  router     Classified as code-edit / hard at high effort; dispatched retrieval, flagged a design breakpoint.
  14:03:12  retrieval  Gathered 7 refs from 3 of 4 sources.
  14:03:12  bug-hunt   Ran: fanned out 3 file-relevance agents, 2 files implicated, injected 412 tokens of cited lines.
  14:03:45  filter     Denied `rm -rf /` (matched deny-list: destructive-recursive-delete).
  14:03:58  injector   Sliced auth/session.ts to the relevant section before the read.
  14:04:30  verifier   auth/session.ts — 1 of 9 tenets flagged (In-flight); advisory, not blocked.

Full narrative: .corpocode/logs/corpocode-flow.log
```

It is a **POC-scoped** inspector: a straight translation of events to prose for one session. It is not a
live tail, not cross-session analytics (`corpocode stats` owns cost aggregation), and not a flow-log
parser (it reads the structured NDJSON and points users to the flow log for the full story).

---

## 2. Context: what already exists (compose, do not rebuild)

Grounded in the read-only survey of the codebase.

| Thing | Fact | File |
|---|---|---|
| Event log | `logFile(cwd?, env?)` → `<cwd>/.corpocode/logs/corpocode.ndjson`; one `{"ts":…, "event":…, …}` object per line | `src/config/paths.ts:50`, `src/log/ndjson.ts:47` |
| `LogFields` | `{ event, session_id?, component?, cost_usd?, latency_ms?, provider?, model?, [k]:unknown }` | `src/log/ndjson.ts:16` |
| Flow log | human-readable narrative companion at `flowLogFile()`; `why` points users to it but does NOT parse it | `src/config/paths.ts:58`, `src/log/flow.ts` |
| CLI dispatch | hand-written `switch (command)` in `runCli`; each command has a `run…Command(argv, env?)` handler | `src/cli.ts:32` |
| Command docs | `COMMANDS: CommandDoc[] = [{ name, usage, summary }]` — single source for `--help` | `src/cli-commands.ts:4` |
| Log-reader pattern | pure `compute…(lines, opts) → Report` + thin `run…Command(argv, env?)` wrapper; `readLogLines()` = `readFileSync(logFile()).split("\n")` in a try/catch → `[]` | `src/commands/stats.ts`, `src/commands/review.ts` |
| Test pattern | import the pure function only, feed canned NDJSON via a `line(o)=JSON.stringify(o)` helper, inject `now`/`days` | `tests/commands/stats.test.ts`, `review.test.ts` |

**The event vocabulary `why` translates** (session-scoped unless noted). Each maps to an injection source
tag in `src/hooks/response.ts:18` where relevant:

- `router` — the categorizer's decision (type, complexity, effort, breakpoint, dispatch_retrieval, candidates) — trivial early-exit variant too.
- `delegation` — auto-delegation suggestion (`delegate_to`, `mode`).
- `filter` — a tool `allow`/`deny`/`ask` with `reason`, `matched` pattern, `enforced`.
- `inject` — a file read sliced / read whole / warning injected.
- `verifier` (+ `verifier_check`) — post-edit MOLAR-EDIT tenet findings (summary + per-tenet violations).
- `review` (+ `review_check`) — design-review tenet concerns.
- `retrieval` (+ `retrieval_item`) — retrieval-team gather summary.
- `toolbox` — surfaced skills/agents (`trigger`: userpromptsubmit / pretooluse / sessionstart).
- `pattern` — **the A1 bug-hunt event** (`decision:"ran"|"skipped"`, `reason`, `files_fanned`, `survivors`, `injected_tokens`).
- `compaction`, `git`, `docs` — Stop-hook housekeeping.
- **Sessionless** (carry no `session_id`): `orchestrate`, `agent_item` (engine), `gather_source_degraded` (gather), `hook_error` (dispatch), `agent_session_put_failed`, `agent_sessions_evicted`. Handled specially (§4.3).

---

## 3. CLI surface

```
corpocode why [--session <id>] [--days N] [--json]
```

- **no args** → explain the **most recent session** (the `session_id` of the log line with the greatest `ts`).
- `--session <id>` → explain that session id (exact match; a short 8-char prefix also matches, mirroring the flow log's `session <first-8>` rendering).
- `--days N` → only consider log lines within the last N days (default: unbounded; a session is usually one sitting).
- `--json` → emit the structured `WhyReport` (`JSON.stringify(report, null, 2)`) instead of prose.

Flags are hand-parsed exactly as `stats`/`review` do (`--days N` via `Number(argv[++i])`, guarded). Output
via `process.stdout.write` with explicit `\n`, never `console.log`.

---

## 4. Design

### 4.1 Structure (mirror `stats`/`review` exactly)

- **Pure** `computeWhy(lines: string[], opts: WhyOptions): WhyReport` — all logic, no I/O; the test seam.
- **Thin** `runWhyCommand(argv: string[], env?: NodeJS.ProcessEnv): void` — parse flags, `readLogLines()`
  (non-exported, `readFileSync(logFile()).split("\n")` in try/catch → `[]`), call `computeWhy`, render.

```ts
export interface WhyOptions { session?: string; days?: number; now?: number; }
export interface WhyLine { ts: string; component: string; event: string; text: string; sessionless?: boolean; }
export interface WhyReport {
  sessionId: string | null;      // the session explained (null when the log has none)
  started?: string; ended?: string;
  lines: WhyLine[];              // one per translated decision, time-ordered
  otherEvents: number;           // in-session records with no translation (kept honest, see §4.4)
  sessionsSeen: number;          // total distinct sessions in the window (so the user knows there are more)
  note?: string;                 // e.g. the sessionless best-effort caveat
}
```

### 4.2 Selection pipeline (inside `computeWhy`)

1. Parse: skip blank lines; `JSON.parse` in try/catch, `continue` on malformed (per `stats.ts:47`).
2. Window: if `opts.days`, drop records whose `ts` is missing/older than `now - days*86_400_000`.
3. Target session: `opts.session` (exact or 8-char-prefix match) else the `session_id` of the max-`ts`
   record that has one. If no record has a `session_id` → `sessionId: null`, `lines: []`, a note.
4. Collect the target's records (matching `session_id`), compute `started`/`ended` from their `ts` range.
5. Translate each via `explain()` (§4.4); drop nulls (counted in `otherEvents`); sort by `ts`.
6. `sessionsSeen` = count of distinct `session_id`s in the window.

### 4.3 Sessionless events (explicit decision to verify)

Six event types carry no `session_id` (engine `orchestrate`/`agent_item`, `gather_source_degraded`,
`hook_error`, the two `agent_session_*`). **Approach (default):** attribute them to the target session
**best-effort by time** — include a sessionless record when its `ts` falls within
`[started, ended]` of the target session, mark it `sessionless: true`, and set `report.note` to state the
attribution is by timestamp, not identity. This keeps the bug-hunt story whole (`agent_item`/`orchestrate`
sit right beside the `pattern` line that *does* have the session id) without inventing a false linkage.
*Alternative if you prefer:* render them in a separate "engine internals (not session-scoped)" section.
**This is the main open decision in this spec — flagged for your review.**

### 4.4 The translation layer — `explain(record): WhyLine | null`

The heart of B1 and the piece future patterns extend. A `switch` over `record.event` producing one prose
line; an unrecognized event returns `null` (counted in `otherEvents`, never silently hidden — a `--json`
consumer still sees the raw count, and a `--verbose` later can dump them). Representative mappings:

| event | prose |
|---|---|
| `router` (trivial) | `Trivial prompt — skipped analysis (free).` |
| `router` (stage 2) | `Classified as {type} / {complexity} at {effort} effort` + `; dispatched retrieval` / `; flagged a design breakpoint` / `; N candidate files`. |
| `filter` | `{Denied\|Allowed\|Asked about} \`{tool}\`` + ` (matched {matched})` + ` — {reason}`; append ` [advisory]` when `enforced:false`. |
| `inject` | `Sliced {file} to the relevant section` / `Read {file} whole (purpose unknown)` / `Injected N warnings for {file}`. |
| `verifier` | `{file} — {violations} of {checks} tenets flagged` + ` (BLOCKED)` when `blocked` else ` (advisory)`. |
| `retrieval` | `Gathered {refs} refs from {items_succeeded} of {checklist_items} sources.` |
| `toolbox` | `Surfaced {skills} skills, {agents} agents ({trigger}).` |
| `pattern` (bug-hunt, ran) | `Ran: fanned out {files_fanned} file-relevance agents, {survivors} files implicated, injected {injected_tokens} tokens of cited lines.` (or `…; hit the {reason} path` when reason≠"ran"). |
| `pattern` (bug-hunt, skipped) | `Skipped ({reason}).` |
| `orchestrate` | `Agent fan-out: {succeeded}/{calls} agents ran, {surviving} survived.` |
| `agent_item` | `Opened {id} ({ok?"ok":"failed"}).` |
| `compaction` / `git` / `docs` | one line each (backend + counts; op + branch; files + symbols). |
| `gather_source_degraded` | `{source} unavailable ({reason}) — degraded to empty.` |
| `hook_error` | `{hook} hook failed open ({error}).` |

`component` on the `WhyLine` comes from `record.component` (or a derived label like `bug-hunt` for
`pattern`). The table lives as small per-event helpers in `why.ts`, so adding a future pattern's event is
one new case — the same extensibility the action-pattern contract has.

### 4.5 Rendering

- **Prose:** a header (`Why — session {id8} · {N} decisions · {startedTime}–{endedTime}`), the time-ordered
  lines (`  {HH:MM:SS}  {component,padded}  {text}`), a footer pointing to the flow log, and — when
  `sessionsSeen > 1` — a hint (`{sessionsSeen-1} older session(s) in the log; use --session <id>`). Empty
  log → `No CorpoCode decisions logged yet.` (and, if logging is disabled in config, say so).
- **JSON:** `process.stdout.write(JSON.stringify(report, null, 2) + "\n")`.

---

## 5. Testing — `tests/commands/why.test.ts`

Pure-function-over-canned-NDJSON, mirroring `tests/commands/stats.test.ts` (a `line(o)=JSON.stringify(o)`
helper; inject `now`/`session`/`days`; no filesystem — `readLogLines()` stays unexported and untested).

1. **Default = most recent session** — two sessions in the log; `computeWhy` picks the one with the latest `ts`.
2. **`--session` targets a specific session** (exact and 8-char-prefix match).
3. **Translates the A1 bug-hunt `pattern` event** to the ran/skipped prose (the explicit B1↔A1 link).
4. **Translates `router` and `filter`** (a stage-2 decision; a `deny` with `matched` + `enforced:false` → `[advisory]`).
5. **Malformed / blank lines tolerated** (`["not json", "", line({…})]`).
6. **`--days` window** filters out older lines (deterministic via injected `now`).
7. **Sessionless attribution** — an `orchestrate` line inside the session's `ts` range is included and marked `sessionless`, with the `note` set.
8. **`otherEvents` counts** untranslated in-session events rather than hiding them.
9. **Empty log** → `{ sessionId: null, lines: [], … }` clean report.

`npm run verify` (build + `tsc --noEmit` + vitest) must stay green; no existing test changes (B1 adds a
command and touches only `cli.ts`/`cli-commands.ts` glue).

---

## 6. Files touched

**New**
- `src/commands/why.ts` — `computeWhy` (pure) + `explain` translation + `runWhyCommand` wrapper + `WhyReport`/`WhyLine`/`WhyOptions`.
- `tests/commands/why.test.ts`.

**Modified**
- `src/cli.ts` — `import { runWhyCommand }` + `case "why": runWhyCommand(rest, ...); return;`.
- `src/cli-commands.ts` — a `COMMANDS` entry `{ name: "why", usage: "why [--session <id>] [--days N] [--json]", summary: "explain the decisions CorpoCode made in a session" }`.

**Unchanged (must not need edits)**
- `src/log/ndjson.ts`, `src/log/flow.ts`, every hook/handler — B1 is a pure read of what they already log.

---

## 7. Invariants

- **Read-only + fail-open:** a missing/unreadable/empty log → a clean empty report, never an error (the `readLogLines()` try/catch → `[]`, per `stats`).
- **No new events, no hook changes:** B1 only reads; the log vocabulary is A1's and the caretakers'.
- **Honest coverage:** untranslated events are *counted* (`otherEvents`), never silently dropped; sessionless attribution is *flagged* in `note`, never presented as certain (the "no silent caps" principle).
- **Convention parity:** pure/`compute` + thin `run` split, `logFile()` project-local read, `--json` via a typed report, `process.stdout.write` — identical to `stats`/`review`.

---

## 8. Out of scope (deferred)

- Live tail / `--watch`.
- Cross-session cost/latency analytics — that's `corpocode stats`.
- Parsing the human-readable flow log (B1 reads structured NDJSON; it *links* to the flow log).
- Perfect session attribution for the six sessionless events (best-effort by time-window here; a future
  change could thread `session_id` into the engine/gather/dispatch log lines, which would also benefit A1).
- A `--verbose` mode that dumps the `otherEvents` raw lines (easy follow-up once the translation table proves out).
```
