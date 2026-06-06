# Chapter 01 — The Hook Engine

*The fail-open plumbing that turns one short-lived process into a validated, time-bounded round-trip
from the host's stdin to a structured stdout — and is never allowed to disrupt the host's turn.*

> Prerequisite: [chapter 00](00-overview.md). The one fact to carry in: **every hook is a fresh
> process**, so there is no in-memory state and the dispatcher is the single circuit breaker for the
> whole system.

---

## Why this layer exists

CorpoCode runs inside another agent's loop. A crash, a non-zero exit, or even a *hang* in a hook could
break the host's turn — and that is the one thing CorpoCode must never do. Every design choice in this
chapter is downstream of a single sentence at the top of `src/hooks/dispatch.ts`: *a buggy CorpoCode
must fail open, never disruptive.* The hook engine is the machinery that makes "fail open" true by
construction rather than by hope.

## The round-trip, step by step

Follow one `corpocode hook PreToolUse` invocation from spawn to exit. Each step names the function and
file so you can read along.

1. **Entry is deliberately trivial.** `src/index.ts` is one line — `void runCli(process.argv.slice(2))`.
   All logic lives behind the CLI router, so the entry point has nothing to get wrong.
2. **CLI routing.** `runCli` (`cli.ts:32`) switches on `argv[0]`. For `hook` it pulls an optional
   `--platform <id>` flag and calls `runHook(name, platform)`, whose contract is stated in a comment:
   *always exits clean.*
3. **stdin read.** `readStdin` (`dispatch.ts:171`) resolves `""` immediately if stdin is a TTY (no piped
   input), else accumulates chunks. Crucially, even the stream's `error` event *resolves* with whatever
   was read rather than rejecting — a broken pipe yields data, never a throw.
4. **Dispatch entry.** `runHook` wraps `dispatchHook(name, stdin, deps)` in its own try/catch, defaulting
   the output to `emptyResponse()` (`"{}"`). `dispatchHook` (`dispatch.ts:87`) is the heart, documented
   as *never throws.*
5. **Hook-name guard.** An unknown hook name is silently a no-op (`isHookName`, `envelope.ts:83`).
6. **Parse + BOM strip.** `JSON.parse(rawStdin.replace(/^﻿/, ""))` — some shells prepend a byte-order
   mark to piped stdin, so it is stripped before parsing.
7. **Envelope validation.** `baseEnvelope.parse(parsed)` validates the common fields (`session_id`,
   `transcript_path`, optional `cwd`/`hook_event_name`). The schema uses `.passthrough()` so a newer host
   that adds payload fields never breaks validation — this is load-bearing for surviving host upgrades.
8. **Config load.** `loadConfig({ env })` reads `~/.corpocode/config.json`. A missing file degrades to
   defaults; a present-but-broken file throws `ConfigError`, which the outer catch turns into a clean
   empty response.
9. **Platform resolution.** Explicit `deps.platform`, else `CORPOCODE_PLATFORM` (set by the installed
   shim) if valid, else `"claude-code"`. Resolved *before* the context so platform-aware handlers can read
   it.
10. **Context build.** `buildContext(config, { env, repoRoot: base.cwd, logger, platform })`
    (`context.ts:59`) assembles the shared dependency graph — providers, graph, context store, memory,
    session reader, prompts, plugins, and the optional agent registry. It is cheap and lazy: nothing spawns
    a process or hits the network until first use, so *building a context never blocks or fails a hook.*
11. **Handler routing.** A `switch` on the hook name calls `runTyped(...)` with the matching per-hook Zod
    schema and the registered handler; the default branch is an exhaustiveness `never` check.
12. **Typed parse + handler call.** Inside `runTyped`, the *full* payload is parsed by the per-hook schema
    (the base step only validated common fields), then `await handler(envelope, ctx)`. A handler-less hook
    returns `{}`.
13. **Flow record — always.** `flow.record(eventName, parsed, response)` runs for *every* surface, even
    handler-less ones, so the human-readable flow log observes every hook Claude Code fires exactly once.
14. **`hookEventName` stamping.** The response is returned as
    `serialize({ ...response, hookEventName: response.hookEventName ?? eventName })`. Claude Code *requires*
    `hookEventName` whenever `hookSpecificOutput` is present, so the dispatcher guarantees it.
15. **Serialization.** `serializeForPlatform(r, platform)` produces the platform-correct stdout (see
    "The platform seam" below).
16. **stdout write + clean exit.** `process.stdout.write(out)` is itself wrapped in try/catch. The process
    exits clean — no code path in the hook flow sets a non-zero exit.

## The two backstops: error and hang

Fail-open is not one mechanism but two, because there are two ways to break a turn.

**Errors** are caught structurally. The entire body of `dispatchHook` sits inside one `try { … } catch`,
which on *any* failure — parse error, Zod rejection, `ConfigError`, a thrown handler, a timeout — logs a
structured `hook_error` line (itself nested in a try/catch so logging the failure can't throw), optionally
writes a stderr diagnostic *only* when `CORPOCODE_DEBUG` is set (safe, because stderr on a 0-exit hook is
shown by the host but doesn't break the turn), and returns `emptyResponse()`. There are further try/catch
rings around `runHook` and the stdout write. No path throws or exits non-zero.

**Hangs** are caught by time. The whole routing promise is wrapped in
`withTimeout(route(), deps.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)`, where
`DEFAULT_HOOK_TIMEOUT_MS = 45_000` (`dispatch.ts:44`). This is *defense in depth*: individual external
calls have their own, tighter timeouts; this overall budget guarantees the hook returns even if a backend
wedges. A subtlety worth internalizing (recorded in `docs/adr/0003`): the catch and the timeout cover
thrown errors and rejected promises, but **not** a Node `EventEmitter` `'error'` event with no listener —
Node treats that as a fatal uncaught exception that bypasses the dispatcher. So any code that spawns a
process must attach its own `'error'` handler at the source; fail-open at the dispatcher is necessary but
not sufficient.

> **The payoff of a single circuit breaker:** because the dispatcher catches everything, every component
> *below* it is free to throw on genuinely exceptional input rather than inventing degraded return values.
> The discipline lives in one place.

## Configuration: total by construction

`src/config/schema.ts` is the authoritative Zod `configSchema`, and its defining trait is that **every
block carries `.default(...)`**. So `configSchema.parse({})` yields a *complete, valid* config — which is
exactly what a fresh install writes and what `load.ts` uses to fill in a partial file. Three consequences
fall out of that one choice:

- A config that predates a newer block still loads cleanly (the missing block defaults).
- Unknown keys are *stripped*, not rejected, so a newer config read by an older binary degrades gracefully
  rather than failing — the In-flight tenet applied to the config file itself.
- The schema can define future-phase blocks today, so the file format never needs migrating.

The default provider is the keyless `anthropic-cli`, so cheap-model calls work with **zero** API-key setup.
A cross-field `superRefine` enforces that every `components.*` value names a provider that actually exists,
turning a typo into a clear config error instead of a confusing runtime failure.

`load.ts` is the only module that reads config; the dispatcher loads once and hands each handler its slice,
so handlers stay pure functions of their passed config and never reach for global state. The load path is
*read → validate → apply env overrides → re-validate*, so a bad `CORPOCODE_*` override fails identically to
a bad file value.

### Env overrides and secrets

`CORPOCODE_*` overrides (`env-overrides.ts`) can't naively split on `_`, because config keys themselves
contain underscores (`heuristic_candidate_limit_files`). Instead the override system enumerates the known
leaf paths of the defaults-filled config and matches each leaf's canonical env name — unambiguous and
underscore-safe, and only existing leaves are overridable. A value that fails type coercion is left raw so
Zod rejects it with a clear message. Secrets live separately in `~/.corpocode/secrets` (a dotenv-style file,
chmod 600); the config references keys *by name* and `resolveApiKey` reads them at use — secrets are never
inlined into `config.json`.

### Where state lives: the home / project split

`src/config/paths.ts` is the **single source of truth for every on-disk location** — no other module
hard-codes a path, so platform differences live in exactly one file. It draws one important line:

- **Global** state — config + secrets — lives in `~/.corpocode` (a `.corpocode` dotfolder in the user's
  home on *every* OS, deliberately not APPDATA/XDG, so it's predictable cross-platform).
- **Project-local** state — logs, memory, the session/decision caches, editable prompts, agent sessions —
  lives in `./.corpocode` under the repo, so per-project state is easy to find and, critically, *secrets
  never land in a repo*.

`CORPOCODE_HOME` overrides **both** (it short-circuits the project-local path too), pinning all state into
one directory — which is exactly how the tests isolate state into a temp dir. Don't "fix" `projectStateDir`
to ignore it; that override is an invariant the test suite relies on.

## Two logs, two questions

CorpoCode keeps two logs because they answer different questions.

- **`corpocode.ndjson`** (`log/ndjson.ts`) — append-only, one JSON object per line — answers *"what did
  each component decide?"* It never throws into its caller (a failed side effect must not take down a hook)
  and collapses to a no-op when logging is disabled. Callers are responsible for never passing secrets/PII;
  the logger writes faithfully whatever it is given.
- **`corpocode-flow.log`** (`log/flow.ts`) — answers *"what did the flow look like?"* by interleaving, on
  every hook, the transcript delta since the last hook with that hook's output, so the turn reads
  top-to-bottom. It renders the transcript *flow-locally* rather than through the SessionReader's distiller,
  because following the flow needs structure the distiller discards — a tool *result* carries `role:"user"`
  but must not look like a user message after the tool call, so each content block is classified by type and
  kept in file order. It uses a **separate** byte-offset cursor from the SessionReader's, so the two
  consumers of the transcript never starve each other of the slice each needs to read.

## The platform seam

Almost all of CorpoCode is platform-agnostic; the *one* axis hosts differ on for CorpoCode's *output* is
the stdout envelope shape. `hooks/platform-output.ts` is the single seam that absorbs it: Claude Code gets
the `hookSpecificOutput` wrapper (built by `response.ts:buildResponse`); other platforms get a flat object
whose context field name varies per platform. The file carries an honesty note that non-Claude shapes are
best-effort and must be confirmed against each platform's docs at integration time. A `SUBAGENT_CAPABLE`
table gates *auto* delegation — only confirmed-capable platforms can be *directed* to a subagent; the
*suggest* path works everywhere.

## How the engine connects to everything else

Two functions are the seams to the rest of the system.

`buildHandlers()` (`handlers.ts`) wires each hook to one caretaker component:

| Hook | Handler | Caretaker |
| --- | --- | --- |
| `UserPromptSubmit` | `handleUserPromptSubmit` | Middle-Management (categorize + retrieve + review) |
| `PreToolUse` | `handlePreToolUse` | Middle-Management (deny/allow/ask + inject) |
| `PostToolUse` | `handlePostToolUse` | Housekeeping (MOLAR-EDIT verify, can block) |
| `Stop` | `handleStop` | Housekeeping (compact + promote + document) |
| `SessionStart` | `handleSessionStart` | toolbox re-gate |
| `SessionEnd` | `handleSessionEnd` | agent-seam cleanup (no-op until `agents.enabled`) |

The remaining four surfaces (`SubagentStart`, `SubagentStop`, `Notification`, `PreCompact`) have **no**
handler — they are registered only so the flow log observes every hook the host fires.

`buildContext()` (`context.ts`) exposes the four abstractions of [chapter 02](02-abstractions.md) — the
provider `registry`, `graph`, `context` store, and `memory` — plus the `sessionReader`, the `prompts`
resolver, discovered `plugins`, and the *dark* `agents` registry (built only when `config.agents.enabled`,
so the orchestration layer of [chapter 05](05-intelligent-router.md) is absent unless explicitly switched
on).

## Invariants a contributor must not break

- **Nothing in the hook path may throw or exit non-zero.** The dispatcher's catch is a backstop, not a
  license; new external calls in handlers must still respect fail-open, and new blocking work must respect
  (or tighten) the 45s budget — a synchronous wedge *before* the first `await` won't be caught by the
  timeout.
- **Any code that spawns a process must attach an `'error'` handler at the source** — the dispatcher cannot
  catch an unhandled emitter `'error'`.
- **`flow.record` must run for every surface**, including handler-less ones; moving it inside the handler
  branch would blind the flow log to four hooks.
- **`hookEventName` must always be stamped when `hookSpecificOutput` is present** — Claude Code rejects
  output that omits it.
- **The flow-log cursor and SessionReader cursor stay separate** — sharing them starves one consumer.
- **Config blocks keep `.default(...)`** so `parse({})` stays total and old configs keep loading; the
  `components → providers` `superRefine` must hold.
- **Components never call `load.ts` directly** — the dispatcher loads once and passes slices down.
- **`paths.ts` is the only place that hard-codes a path**, and `CORPOCODE_HOME` overrides project-local
  paths too.
- **`.passthrough()` on envelopes is load-bearing** — it's what lets a newer host add payload fields without
  breaking CorpoCode.

---

*Continue to [chapter 02 — the four abstractions](02-abstractions.md).*
