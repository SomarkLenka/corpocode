# Chapter 06 — The IntelligentRouter

*The agent substrate the three caretakers fan out through, and CorpoCode's private workspace: on a hook,
triage whether the moment is worth investigating, gather
deterministic candidates, fan out low-cost agents per a pattern-emitted plan, judge their output, and
synthesize exactly one tagged injection — so the main model receives a **conclusion**, not a pile of
files to open.*

> This is the newest and largest in-progress feature. Its **infrastructure is built and wired but
> ships dark** (off by default); the concrete behaviors that consume it are deliberately deferred. The
> remaining-work spec is `docs/INTELLIGENT-ROUTER-PHASES.md`; this chapter is the narrative of the
> *why* and the *shape*.

---

## The problem it solves

The caretakers of [chapter 03](03-middle-management.md) inject *candidates* — "here are the files that
look relevant." That is already a large saving, but it still hands the main model a reading list. The
IntelligentRouter is the place where CorpoCode does the reading itself: it can spend a few cheap-model
agents to actually open `auth/session.ts`, decide whether the bug is there, and inject *"the bug is at
`auth/session.ts:140-158` because the session TTL is compared before the clock skew is applied"* — a
conclusion the expensive model can act on directly. Every bit of investigation the router absorbs is
repaid as fewer tokens and less wandering for the main model. This is the engine that turns each
caretaker's fan-out from a team of one-shot *model calls* into a team of true *agents* — the realization
of Middle-Management's team-of-agents charter ([chapter 03](03-middle-management.md)) and the army
[Upper-Management](05-upper-management.md) will command.

## The governing principle: infrastructure first, behaviors deferred

The single rule that shapes the whole subsystem: **the engine never hardcodes what an agent does.** The
agent-loop shape — which tasks run, the fan-out width, the session policy, the judging, the stop
condition — lives entirely in an `OrchestrationPlan` that an *action-pattern* emits. The engine just
runs the plan. This is a deliberate inversion: rather than build "a bug-hunter" and "a pre-write
advisor" as bespoke pipelines, CorpoCode builds **one abstract orchestrator** and lets each concrete
behavior be a small module that *produces a plan*.

The payoff is that every hard concretion we have not yet settled — turn caps, `--resume` versus
`--fork-session`, the confidence floor, the injected-token budget — is **deferred to the pattern that
emits the plan**, and patterns can evolve independently without ever touching the engine. Premature
integration of any one behavior would make the others harder to shape; keeping the core ignorant of
specifics keeps it malleable.

### Ships dark

The entire layer is gated on `agents.enabled` (default **false**). When off, `ctx.agents` is
`undefined` and every caller falls back to today's behavior, so output is **byte-identical** to a build
without the IntelligentRouter. The seam, the registry, the engine, `gather`/`synthesize`/`router-router`,
and the SessionEnd cleanup are all built and wired — but inert until the flag flips and the first
action-pattern lands. This is "the user disposes" applied to a whole subsystem: it proves itself in
isolation before it is allowed to touch a live turn.

## The architecture in one diagram

```
handler (thin, gated)
  └─ RouterRouter.route(intent)          triage: dumb (caller keeps control) | smart (investigate)
       └─ action-pattern (atomic, deferred):
            1. gather(intent, ctx)        deterministic candidates — graph + memory, fail-open per source
            2. (intent, candidates) → OrchestrationPlan   the agent-loop shape, decided per-pattern
            3. engine.run(plan)           bounded fan-out · pluggable judge · aggregated usage
            4. synthesize(result)         ONE tagged injection (TAGS.intelligentRouter), "" if empty
                 └─ AgentBackend seam     agnostic; config picks the backend
                      ├─ anthropic-cli    `claude -p` loop, always --bare (recursion guard)
                      └─ agent-engine     lazy optional adapter; fail-open if absent
```

## The seam: `AgentBackend`

At the bottom sits the only coupling point between CorpoCode and any model runtime — a deliberately
**dumb** contract that executes one agentic call and maintains session persistence. *All* reasoning,
routing, fan-out, aggregation, and judging live above it in `src/intelligence/`.

```ts
export interface AgentBackend extends Pingable {
  readonly id: "anthropic-cli" | "agent-engine";
  invoke<T>(call: AgentCall<T>): Promise<AgentResult<T>>;  // NEVER throws — fail-open
  release(sessionId: string): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
  shutdown(): Promise<void>;
}
```

`invoke` is the broadened successor to `Provider.chat()`: a one-shot completion is just
`invoke({ tools: "none", schema })`; tool loops, filesystem access, MCP, persistent sessions, and model
fan-out are all *additive* on top of that base. Like every external boundary in CorpoCode, `invoke`
never rejects — failures resolve to `{ ok: false, error }` (the In-flight tenet).

An `AgentCall` carries `{ component, taskKind, task, inputs?, model?, effort?, schema?, tools?, session?,
strategy?, timeoutMs? }`. A subtle but important detail: `inputs` carries candidate file **paths**, never
their contents — the agent reads the files itself through its tools, which is what makes this a real
investigation rather than a prompt-stuffing exercise. The `taskKind` (one of `triage`, `rank`,
`file-relevance`, `pre-write-guidance`, `review`, `housekeeping`, `general`) drives default model, tool
posture, and which backend handles it; the list is a single source of truth in `agents/backend.ts`, from
which the config's Zod validator is built so config and code can never drift.

### Two interchangeable backends

- **`anthropic-cli`** — each `invoke` is one `claude --print --output-format json` agent loop. It is
  **always** spawned with `--bare`, the *mandatory recursion guard*: `--bare` skips hooks and plugins, so
  a spawned `claude` can never re-trigger CorpoCode's own hooks and recurse infinitely. It is read-only by
  default (`Read, Glob, Grep`); write and MCP access are explicit per-task opt-ins. Sessions live
  server-side in `claude`; CorpoCode persists only the returned uuid so a later fresh hook process can
  `--resume`. The spawn function is injectable, so no real `claude` runs in tests. This is the zero-dependency
  default.
- **`agent-engine`** — a lazy, optional adapter to the private `corpocode-agent-engine` package (an
  opencode-backed runtime). It is dynamic-imported via a **non-literal specifier**, so neither `tsc` nor
  `esbuild` resolves or bundles the heavy opencode SDK into the self-contained `bin/corpocode.js`. When the
  package is absent, the backend resolves fail-open with `model_unavailable` — so `anthropic-cli` stays the
  default and CorpoCode never breaks. Its pure adapter functions (`toEngineCall`, `fromEngineResult`,
  `toEngineTools`) are exported and unit-tested without the package installed.

The **registry** picks a backend per task: `forTask(kind)` returns the configured backend (default
`anthropic-cli`, per-task override via `task_backends`), and fails open — a missing or unloaded configured
backend falls through to any other loaded backend.

## The engine

`run(plan, deps) → OrchestrationResult` is the abstract core. Its `deps` are injected
(`{ forTask, limiter?, now?, log? }`), so it tests against fakes and is decoupled from how `ctx.agents`
is built. It fans out the plan's tasks with bounded concurrency — a local `fanoutWidth` (default 3) *under*
the process-global provider limiter, the same two-layer concurrency model as the retrieval team. It applies
a pluggable **judge** (default `keepOk`, which keeps the `ok` results; a pattern supplies a stricter
confidence/fit filter), aggregates usage (cost, calls, succeeded), and is per-task fail-open: even a
build-time misconfiguration with no backend registered degrades to a single failed task, never a thrown
run. It emits one `agent_item` NDJSON line per task and an `orchestrate` summary. It knows *nothing* about
what any agent does.

## The three helpers around the engine

- **`gather`** is the *deterministic* half — no model calls. For a `prompt` intent it scores files
  (`graph.scoreFiles`) and recalls rules/mistakes (`memory.recall`); for a file-scoped intent it centers on
  the file's graph node, its neighborhood, and file-scoped memories. Every source is independent and
  **fail-open**: a dead backend degrades *that source* to empty (logging `gather_source_degraded`), never
  the whole gather. The heavier retrieval fold is left behind an optional dep — a deferred concretion a
  pattern opts into.
- **`synthesize`** is the *last* step: it folds an `OrchestrationResult` into **one** block under
  `TAGS.intelligentRouter`. Two invariants: structure and meaning only — never HTML or markup (the one
  rule); and a true no-op — it returns `""` when nothing survived, so the handler injects nothing and the
  turn stays byte-identical.
- **`router-router`** is the strict triage gate *above* the whole thing. `route(intent, deps)` returns
  `dumb` (the caller keeps full control — the cheapest path) or `smart` (run an action-pattern). It does
  two checks, cheapest first: a **free** deterministic trivial test (reusing the categorizer's
  `isTrivialPrompt`) short-circuits to dumb; otherwise **one** minimal-effort, tool-less triage call asks
  "is this absurdly simple?". Its bias is **strict toward smart**: it dumb-routes only on a confident agent
  `true`; any error, malformed reply, missing backend, or uncertainty falls open to smart, so context is
  never withheld on doubt. With `enabled: false` everything routes smart — the gate is fully removable
  without touching the router beneath it.

## Sessions: continuity on disk

Because every hook is a fresh process, a `claude` agent thread opened in one hook can only be resumed in
the next if its server-side uuid is persisted. The session store does exactly that and nothing more:
`createSessionStore(...)` gives `{ get, put, remove, evict, all }` over one small JSON record per
purpose-scoped key. Keys are `sessionKeyForFile(host, relpath)` and `sessionKeyForTopic(host, slug)` —
both `sha1` of `host:…`, so host ids and paths stay out of the filename and keys are fixed-length. `get`
drops expired records (TTL); `evict` does a TTL sweep then an LRU trim to `maxSessions`. It is fully
fail-open — a missing or corrupt record reads as `null`, write errors are swallowed (losing a session only
costs one cold start).

The **SessionEnd** handler is the cleanup, and it is *already wired into the dispatcher* (it is the one
piece of this subsystem that runs on a live hook, as a no-op until the flag flips). On a session ending, it
releases just *that* host session's threads — on every registered backend, since the owning backend isn't
recorded and `release` is fail-open, so a wrong-backend call is a harmless no-op — removes their records,
then runs `evict()`. When `ctx.agents` is undefined it returns immediately.

## What is built, and what is deferred

**Built** (Phases 0, 1a, 4): the seam and both backends, the registry, the disk session store and
SessionEnd cleanup, the engine, `gather`/`synthesize`/`router-router`, the config knobs
(`agents.{enabled, default_backend, task_backends, max_parallel, session_ttl_ms, max_sessions,
router_router}`), and the lazy `ctx.agents` wiring. There are no live consumers yet —
`src/intelligence/patterns/` and `src/intelligence/cache-guard.ts` do not exist.

**Deferred** — the concrete behaviors, each an atomic module finalized one at a time:

- **Phase 1 (POC) `bug-hunt`** — fan out one `file-relevance` agent per ranked file (read-only, schema
  `{ implicated, lines, confidence }`), judge out the not-implicated and low-confidence, synthesize cited
  lines. The first pattern; it proves the infra end-to-end and the path for everything after.
- **Phase 3 `pre-write`** — two atomic units: `architectural-guidance` (injected now at `PreToolUse`) and
  `deferred-actions` (a `pending-actions` disk record consumed later in `handlePostToolUse`).
- **Phase 5** — eight independent capability modules (`relevance`, `test-author`, `docs`,
  `git-housekeeping`, `skill-load`, `mcp-invoke`, `subagent-request`, `review`), each its own module with an
  asserted tool allow-list.
- **Phase 6 `cacheGuard`** — built last, advisory and nix-able: it maximizes cache hits (stable maximal
  prompt prefix, session-warmth bias toward `--resume`, in-turn memoization) without changing *what* runs.

### The action-pattern contract

Every deferred behavior is one module under `src/intelligence/patterns/<name>.ts` exporting four atomic
pieces: (1) a pure **plan producer** `(intent, candidates, cfg) → OrchestrationPlan` — where the deferred
decisions live, no I/O; (2) **prompt ids** registered in `prompts/registry.ts`, never inline strings; (3) a
**synthesizer** `(result, intent) → string`; and (4) a thin **handler adapter**
`(envelope, ctx) => Promise<HookResponse>` that runs `router.route → gather → plan → engine.run →
synthesize`. The wiring rule: a pattern is reached only via its surface handler, and only when `ctx.agents`
is present.

## How it connects to the rest

`buildContext` constructs `ctx.agents` only when `config.agents.enabled`, registering both backends as
cheap factory objects. Injections flow through the same `HookResponse.additionalContext` channel as every
other caretaker, wrapped in the `intelligentRouter` tag. The deferred handler adapters keep the standard
`(envelope, ctx) => Promise<HookResponse>` shape, so they inherit the dispatcher's catch-all and 45s budget
([chapter 01](01-hook-engine.md)) for free.

## Invariants a contributor must not break

- **Recursion guard (mandatory):** every spawned agent runs `--bare`. Any new write-capable or alternate
  spawn path must preserve it — a spawned `claude` must never re-enter CorpoCode's hooks.
- **Fail-open everywhere:** `invoke` never throws; the engine guards each task; `gather` is per-source
  fail-open; `router-router` biases to smart on any doubt; the session store swallows IO errors.
- **Gated + dark:** flag off ⇒ `ctx.agents` undefined ⇒ byte-identical output. Every new pattern must be
  reachable only when `ctx.agents` is present, and must assert flag-off parity in tests.
- **Never bundle the optional package:** `agent-engine` stays dynamic-imported via the non-literal
  specifier; absence stays fail-open `model_unavailable`. The opencode SDK must never enter
  `bin/corpocode.js`.
- **Read-only by default:** widen tool posture only per task that needs it, asserted in tests.
- **Strict triage; structure-only synthesis:** dumb-route only on a confident `true`; never emit HTML or
  markup from `synthesize`.

---

*Continue to [chapter 07 — platform & operations](07-platform-and-ops.md), or back to
[chapter 05 — Upper-Management](05-upper-management.md).*
