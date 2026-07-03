# Design — `corpocode why` decision inspector (B1)

**Date:** 2026-07-02
**Status:** Draft for review — all codebase claims re-verified against HEAD (A1 `pattern` events are now
live in `src/intelligence/patterns/bug-hunt.ts` and match the pinned schema)
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
  14:03:45  filter     Denied `Bash` (matched destructive-recursive-delete) — recursive delete at root.
  14:03:58  injector   Sliced auth/session.ts to the relevant section.
  14:04:30  verifier   auth/session.ts — 1 of 9 tenets flagged (advisory).

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
| Event log | `logFile(cwd?, env?)` → `<cwd>/.corpocode/logs/corpocode.ndjson`; one `{"ts":…, "event":…, …}` object per line. **`ts` is an ISO-8601 string** (stamped by the writer via `now().toISOString()`) — parse with `Date.parse(rec.ts)`, exactly as `stats.ts:56`/`review.ts:76` do | `src/config/paths.ts:50`, `src/log/ndjson.ts:47` |
| `LogFields` | `{ event, session_id?, component?, cost_usd?, latency_ms?, provider?, model?, [k]:unknown }` | `src/log/ndjson.ts:16` |
| Flow log | human-readable narrative companion at `flowLogFile()`; `why` points users to it but does NOT parse it | `src/config/paths.ts:58`, `src/log/flow.ts` |
| CLI dispatch | hand-written `switch (command)` in `runCli`; each command has a `run…Command(argv, env?)` handler | `src/cli.ts:32` |
| Command docs | `COMMANDS: CommandDoc[] = [{ name, usage, summary }]` — single source for `--help` | `src/cli-commands.ts:10` (interface at `:4`) |
| Log-reader pattern | pure `compute…(lines, opts) → Report` + thin `run…Command(argv, env?)` wrapper; `readLogLines()` = `readFileSync(logFile()).split("\n")` in a try/catch → `[]` | `src/commands/stats.ts`, `src/commands/review.ts` |
| Test pattern | import the pure function only, feed canned NDJSON via a `line(o)=JSON.stringify(o)` helper, inject `now`/`days` | `tests/commands/stats.test.ts`, `review.test.ts` |

**The event vocabulary `why` translates** (session-scoped unless noted). Each maps to an injection source
tag in `src/hooks/response.ts:18` where relevant:

- `router` — the categorizer's decision. **Fields are nested**: `rec.decision.{type, complexity, effort,
  breakpoint, dispatch_retrieval}`, candidates at `rec.stage1_candidates.files`; the trivial early-exit
  variant is signaled by `stage2_invoked: false` (with `decision: {type:"other", complexity:"trivial"}`).
  `src/router/handler.ts:77-157`.
- `delegation` — auto-delegation suggestion (`delegate_to`, `mode`, `platform`).
- `filter` — a tool `decision` of `allow`/`deny`/`ask` with `tool`, `reason`, `matched` pattern,
  `enforced` (`false` on the degraded no-LLM path).
- `inject` — a file read: `{file, purpose_known, sliced, warnings}` (+ `exploration: true` variant).
  **There is no `whole` field** — whole-file is `sliced: false`; `warnings` is a count, not content.
  `src/filter/inject.ts:103-138`.
- `verifier` (`{file, checks, violations, blocked, repeats, enforced}`, counts) + `verifier_check`
  (per-tenet: `tenet`, `verdict`, `severity`, `confidence`, `message`, `file`).
- `review` (`{tenets, concerns}` counts) + `review_check` (per-tenet).
- `retrieval` (`{checklist_items, items_succeeded, refs, tokens, latency_ms}`) + `retrieval_item`.
- `toolbox` — **fields vary by `trigger`**: `userpromptsubmit`/`pretooluse` carry `{skills, agents}`
  counts; `sessionstart` carries `{gated, skipped}` instead. The renderer must branch on `trigger`.
- `pattern` — **the A1 bug-hunt event, now live** (`src/intelligence/patterns/bug-hunt.ts`,
  `src/hooks/handlers.ts:91-98`): `decision:"ran"|"skipped"`, `reason`, `files_considered`,
  `files_fanned`, `survivors`, `injected_tokens`, `cost_usd`, `latency_ms`; the error variant adds
  `message`; the skipped variant carries only `reason`.
- `compaction` (success fields `{backend, preserved, compacted, captured, superseded}` **or** an error
  variant `{error}`), `git`, `docs` (`{files, symbols}`) — housekeeping. **`git` is not Stop-only**: the
  verifier emits `op:"commit", branch:"trace", files` on PostToolUse (`src/verifier/handler.ts:99`);
  the compactor emits `op:"promote", branch:"clean", planned, applied, mode` at Stop.
- **Sessionless** (carry no `session_id`): `orchestrate`, `agent_item` (engine), `gather_source_degraded`
  (gather), `hook_error` (dispatch), `agent_session_put_failed` (`{key, reason}`),
  `agent_sessions_evicted` (`{removed, remaining}`). Handled specially (§4.3). All other events carry
  `session_id` explicitly (each handler passes `envelope.session_id` by hand — nothing injects it
  centrally, which is why the engine-level events lack it).

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
2. Window: if `opts.days`, drop records whose `ts` is missing, unparseable, or older than
   `now - days*86_400_000`. **`ts` is an ISO string — compare via `Date.parse(rec.ts)`** (per
   `stats.ts:56`); `opts.now` is epoch ms, matching `stats`/`review`.
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

Two edges pinned down:
- **Concurrent sessions can mis-attribute** — two interleaved sessions on the same repo share the
  window; the `sessionless` flag + `note` exist precisely so the reader never mistakes best-effort for
  identity. The real fix (thread `session_id` into the engine/gather/dispatch log calls) is deferred (§8).
- **Untranslated sessionless records are ignored entirely** — `otherEvents` counts *in-session* records
  only. Counting time-window strays as "this session's other events" would overstate what we know.

*Alternative if you prefer:* render them in a separate "engine internals (not session-scoped)" section.
**This is the main open decision in this spec — flagged for your review.**

### 4.4 The translation layer — `explain(record): WhyLine | null`

The heart of B1 and the piece future patterns extend. A `switch` over `record.event` producing one prose
line; an unrecognized event returns `null` (counted in `otherEvents`, never silently hidden — a `--json`
consumer still sees the raw count, and a `--verbose` later can dump them). Representative mappings:

| event | detect / fields | prose |
|---|---|---|
| `router` (trivial) | `stage2_invoked === false` | `Trivial prompt — skipped analysis (free).` |
| `router` (stage 2) | nested `decision.*`; candidates at `stage1_candidates.files` | `Classified as {decision.type} / {decision.complexity} at {decision.effort} effort` + `; dispatched retrieval` (when `decision.dispatch_retrieval`) / `; flagged a design breakpoint` (when `decision.breakpoint`) / `; {stage1_candidates.files.length} candidate files`. |
| `delegation` | `delegate_to`, `mode` | `Suggested delegating to {delegate_to} ({mode}).` |
| `filter` | `decision`, `tool`, `matched`, `reason`, `enforced` | `{Denied\|Allowed\|Asked about} \`{tool}\`` + ` (matched {matched})` + ` — {reason}`; append ` [advisory]` when `enforced:false`. |
| `inject` | `sliced` boolean, `purpose_known`, `warnings` count, `exploration?` | `sliced:true` → `Sliced {file} to the relevant section`; `sliced:false` → `Read {file} whole` + ` (purpose unknown)` when `!purpose_known`; append `; injected {warnings} warning(s)` when `warnings > 0`. |
| `verifier` | counts | `{file} — {violations} of {checks} tenets flagged` + ` (BLOCKED)` when `blocked` else ` (advisory)`. |
| `retrieval` | counts | `Gathered {refs} refs from {items_succeeded} of {checklist_items} sources.` |
| `toolbox` | **branch on `trigger`** | `userpromptsubmit`/`pretooluse` → `Surfaced {skills} skills, {agents} agents ({trigger}).`; `sessionstart` → `Session-start toolbox: {gated} gated, {skipped} skipped.` |
| `pattern` (bug-hunt, ran) | | `Ran: fanned out {files_fanned} file-relevance agents, {survivors} files implicated, injected {injected_tokens} tokens of cited lines.` (or `…; hit the {reason} path` when reason≠"ran"). |
| `pattern` (bug-hunt, skipped) | | `Skipped ({reason}).` |
| `orchestrate` | | `Agent fan-out: {succeeded}/{calls} agents ran, {surviving} survived.` |
| `agent_item` | `id` is the task id (a file path for bug-hunt) | `{task_kind} agent on {id} — {ok?"ok":"failed"}.` |
| `compaction` | success or `{error}` variant | success → one line (backend + counts); error variant → `Compaction failed open ({error}).` |
| `git` | **branch on `op`** | `op:"commit"` → `Trace-committed {files}.`; `op:"promote"` → `Promoted {applied} of {planned} commits to the clean branch ({mode}).` |
| `docs` | | `Regenerated docs: {files} files, {symbols} symbols.` |
| `gather_source_degraded` | | `{source} unavailable ({reason}) — degraded to empty.` |
| `hook_error` | | `{hook} hook failed open ({error}).` |
| `agent_session_put_failed` | `{key, reason}` | `Failed to persist an agent session ({reason}).` |
| `agent_sessions_evicted` | `{removed, remaining}` | `Evicted {removed} cached agent session(s); {remaining} remain.` |

`component` on the `WhyLine` comes from `record.component`, with two derived overrides so the column
reads naturally: `pattern` → its `pattern` field value (`bug-hunt`), and `inject` → `injector` (its
`record.component` is `filter`, which would blur tool-denies and read-slices — two different stories, as
the §1 example shows — under one label). The table lives as small per-event helpers in `why.ts`, so
adding a future pattern's event is one new case — the same extensibility the action-pattern contract has.

### 4.5 Rendering

- **Prose:** a header (`Why — session {id8} · {N} decisions · {startedTime}–{endedTime}`; `{id8}` is the
  8-char prefix, matching the flow log's `shortSession` rendering), the time-ordered lines
  (`  {HH:MM:SS}  {component,padded}  {text}`), a footer pointing to the flow log **only when
  `flowLogFile()` exists** (it's gated by `logging.transcript_flow` and may never have been written), and
  — when `sessionsSeen > 1` — a hint (`{sessionsSeen-1} older session(s) in the log; use --session <id>`).
  Empty log → `No CorpoCode decisions logged yet.`; additionally, `loadConfig({ env })` in try/catch (the
  exact `review.ts:181` pattern) to check `logging.enabled` — when `false`, say
  `Logging is disabled (logging.enabled: false).` instead of implying there was nothing to log.
- **JSON:** `process.stdout.write(JSON.stringify(report, null, 2) + "\n")`.

---

## 5. Testing — `tests/commands/why.test.ts`

Pure-function-over-canned-NDJSON, mirroring `tests/commands/stats.test.ts` (a `line(o)=JSON.stringify(o)`
helper; inject `now`/`session`/`days`; no filesystem — `readLogLines()` stays unexported and untested).

1. **Default = most recent session** — two sessions in the log; `computeWhy` picks the one with the latest `ts`.
2. **`--session` targets a specific session** (exact and 8-char-prefix match).
3. **Translates the A1 bug-hunt `pattern` event** to the ran/skipped prose (the explicit B1↔A1 link).
4. **Translates `router` and `filter`** — a stage-2 record with the real **nested** shape
   (`decision.{type,complexity,effort,breakpoint,dispatch_retrieval}`, `stage1_candidates.files`) and the
   trivial variant (`stage2_invoked:false`); a `deny` with `matched` + `enforced:false` → `[advisory]`.
5. **Malformed / blank lines tolerated** (`["not json", "", line({…})]`).
6. **`--days` window** filters out older lines — ISO `ts` strings against an injected epoch-ms `now`.
7. **Sessionless attribution** — an `orchestrate` line inside the session's `ts` range is included and marked `sessionless`, with the `note` set; an untranslated sessionless record is ignored (not in `otherEvents`).
8. **`otherEvents` counts** untranslated in-session events rather than hiding them.
9. **Variant coverage** — `inject` whole-file (`sliced:false, purpose_known:false`), `toolbox`
   `sessionstart` (`gated`/`skipped` fields), and `git` `op:"commit"` vs `op:"promote"` each render their
   own prose.
10. **Empty log** → `{ sessionId: null, lines: [], … }` clean report.

`npm run verify` (build + `tsc --noEmit` + vitest) must stay green; no existing test changes (B1 adds a
command and touches only `cli.ts`/`cli-commands.ts` glue).

---

## 6. Files touched

**New**
- `src/commands/why.ts` — `computeWhy` (pure) + `explain` translation + `runWhyCommand` wrapper + `WhyReport`/`WhyLine`/`WhyOptions`.
- `tests/commands/why.test.ts`.

**Modified**
- `src/cli.ts` — `import { runWhyCommand }` + `case "why": runWhyCommand(rest); return;` — `rest` only,
  no `env` at the call site, exactly like `stats`/`review` (the handler's `env?` defaults to
  `process.env` internally via `loadConfig`).
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