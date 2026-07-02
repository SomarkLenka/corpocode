# Design — `bug-hunt` action-pattern (IntelligentRouter Phase 1 / A1)

**Date:** 2026-07-02
**Status:** Approved design, ready for implementation plan
**Scope:** The first live IntelligentRouter action-pattern. Also pins two shared foundations that later
patterns (`pre-write`, the Phase-5 capabilities) and the `corpocode why` observability feature inherit:
the **action-pattern contract** and the **decision-event schema**.

---

## 1. Goal

On a bug-shaped user prompt, spend a few cheap read-only agents to actually open the top-ranked
candidate files, decide whether each is implicated in the bug, and inject **cited lines** into the same
turn — so the expensive main model receives a conclusion (`auth/session.ts:140-158 — TTL compared
before clock skew is applied`) instead of a reading list.

The entire feature ships **dark**: gated on `agents.enabled` (default `false`). With the flag off,
`ctx.agents` is `undefined`, the pattern is never reached, and `UserPromptSubmit` output is
byte-identical to today.

This is a **POC** whose primary job is to prove the IntelligentRouter substrate end-to-end and
establish the path every later pattern follows. It is not meant to re-open the categorizer or add new
engine machinery.

---

## 2. Context: what already exists (compose, do not rebuild)

The orchestration substrate is built and tested; `bug-hunt` only composes it.

| Block | Signature | File |
|---|---|---|
| `Intent` | `{kind:"prompt", prompt, sessionId, transcriptPath} \| …` | `src/intelligence/types.ts` |
| `gather` | `gather(intent, {graph, memory, project, limit?, logger?, runRetrieval?}) → Promise<Candidates>` — deterministic, per-source fail-open | `src/intelligence/gather.ts` |
| `OrchestrationPlan` | `{ tasks: AgentTask[]; fanoutWidth?; judge? }` | `src/intelligence/types.ts` |
| `engine.run` | `run(plan, {forTask, limiter?, now?, log?}) → Promise<OrchestrationResult>` — bounded fan-out, pluggable judge, aggregated usage, per-task fail-open; emits `agent_item` + `orchestrate` | `src/intelligence/engine.ts` |
| `synthesize` | `synthesize(result, {tag?, header?}) → string` — one tagged block, `""` no-op | `src/intelligence/synthesize.ts` |
| `AgentBackend` seam | `invoke<T>(AgentCall<T>) → Promise<AgentResult<T>>` (never throws) | `src/agents/backend.ts` |
| registry | `ctx.agents?.forTask(kind)` — present only when `agents.enabled` | `src/agents/registry.ts`, `src/hooks/context.ts` |
| `readLastDecision` | `readLastDecision(sessionId, cwd?, env?) → CachedDecision \| null` — written by the router each non-trivial `UserPromptSubmit`; **skipped on the stage-1 trivial early-exit**, so a read can return a stale prior-turn entry (`CachedDecision.ts` enables a freshness check) | `src/session/decision-cache.ts` |

Task kind used: **`file-relevance`** (already in `AGENT_TASK_KINDS`). No new task kind is introduced.

**Not used by this POC (deferred concretions):** `router-router.route` (we reuse the categorizer's
cached decision instead of a second triage call), `gather`'s `runRetrieval` fold, and any `session`
reuse (`bug-hunt` uses `ephemeral` sessions only).

---

## 3. The action-pattern contract (shared foundation)

Every pattern under `src/intelligence/patterns/<name>.ts` exports four atomic pieces. `bug-hunt` is the
reference implementation; `pre-write` and the Phase-5 capabilities follow the same shape.

1. **Plan producer** — pure `(intent, candidates, cfg) → OrchestrationPlan`. No I/O. All deferred
   decisions (which tasks, fan-out width, per-agent `tools`/`session`, the `judge`) live here.
2. **Prompt ids** — registered in `prompts/registry.ts`, resolved via `prompts/resolve.ts`
   (local → global → built-in). Never inline strings.
3. **Synthesizer** — `(result, intent) → string`. Uses `synthesize`. Structure/meaning only, never
   HTML/markup. `""` when nothing survives.
4. **Handler adapter** — thin, gated `(envelope, ctx, decision) → Promise<HookResponse>`. Builds the
   `Intent`, runs `gather → plan → engine.run → synthesize`, returns a `HookResponse`. Reached only when
   `ctx.agents` is present.

---

## 4. `bug-hunt` design

### 4.1 Trigger gate (free, deterministic — no extra LLM call)

There is **no `bug` moment type**; the categorizer's `type` enum is
`["code-edit", "code-gen", "exploration", "docs", "config", "other"]`. Bug reports land as `code-edit`
(fixing is editing) or `exploration` (investigating). The gate therefore uses signals that exist:

```
isBugLike(prompt, decision, turnStartedAt):
  if decision is null: return false             // categorizer didn't classify → do nothing
  if decision.ts < turnStartedAt: return false  // stale cache: the stage-1 trivial early-exit
                                                // skips writeLastDecision, so the last entry may
                                                // belong to a previous turn — never gate on it
  if decision.type not in {"code-edit","exploration"}: return false
  return BUG_SIGNAL.test(prompt)                // free regex on the envelope prompt only
```

The regex scans **the prompt only**. `CachedDecision` carries no free text (only enum-ish fields), and
the session reader's line of thought costs a model call — scanning it would contradict "no extra LLM
call" and is deferred. `turnStartedAt` is captured by the composed handler before it invokes the base
handler (§4.6), so a fresh `decision.ts` proves the entry was written this turn.

`BUG_SIGNAL` matches whole-word, case-insensitive: `error, errors, fails, failing, failed, broken,
breaks, throws, throwing, thrown, exception, stack trace, traceback, regression, crash, crashes,
crashing, bug, "not working", "doesn't work", "does not work", "unexpected", "wrong output"`.
The exact list is finalized in the plan; it lives as a named constant in `bug-hunt.ts` and is unit-tested.

When the gate is false, `bug-hunt` is skipped, emits a `pattern` decision event with `decision:"skipped"`,
and the turn is byte-identical to today.

### 4.2 Plan producer — `planBugHunt(intent, candidates, cfg) → OrchestrationPlan`

- Take the top `cfg.maxFiles` (default 3) entries of `candidates.files` (already graph-scored, ordered).
- Emit one `AgentTask` per file:
  - `id`: the file path (stable attribution/ordering).
  - `call`: `{ component:"router", taskKind:"file-relevance", task:<resolved prompt id>,
    inputs:{ files:[path], reasoning:<the bug prompt> }, tools:"read-only", session:"ephemeral",
    effort:"minimal", timeoutMs: cfg.perAgentMs, schema: BUG_RELEVANCE_SCHEMA }`.
  - `inputs.files` carries the **path only**, never file contents — the agent reads the file itself
    through its read-only tools. This is what makes it an investigation, not prompt-stuffing.
- `fanoutWidth: cfg.maxFiles` (still bounded by the config-level global cap `agents.max_parallel`,
  default 3, via the engine's limiter).
- `judge`: keep tasks where `result.ok`, `data.implicated === true`, and
  `data.confidence >= cfg.confidenceFloor` — **validating shape defensively** (`implicated` is a real
  boolean, `confidence` a number in 0..1, `lines` entries have integer `start`/`end`), because the
  backend does not validate against the schema (see below).
- Pure and finite → the plan is its own stop condition. Empty `candidates.files` → `{ tasks: [] }`,
  which the engine runs to an empty result and `synthesize` turns into `""`.

`BUG_RELEVANCE_SCHEMA` (JSON Schema, passed via `AgentCall.schema`). **Caveat:** the `anthropic-cli`
backend only JSON-*parses* the agent's output — it does not validate against the schema and does not
retry; malformed output surfaces as `ok:false` (`invalid_response`) and is dropped fail-open. Shape
validation is therefore the judge's job (above). Backend-side validation+retry is a later concretion.
```json
{
  "type": "object",
  "required": ["implicated", "confidence"],
  "properties": {
    "implicated": { "type": "boolean" },
    "confidence": { "type": "number", "description": "0..1" },
    "lines": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["start", "end", "why"],
        "properties": {
          "start": { "type": "integer" },
          "end": { "type": "integer" },
          "why": { "type": "string" }
        }
      }
    }
  }
}
```

### 4.3 Prompt id — `bug-hunt-file-relevance`

Flat kebab-case, matching every existing id (`router`, `filter-classify`, …) — there are no dotted ids
in the registry and this POC does not introduce a new naming scheme. Registration is two compile-time
edits, both enforced by `assertCatalogComplete`:

- `BUILTIN_PROMPTS["bug-hunt-file-relevance"]` in `prompts/registry.ts` — the built-in body.
- `PROMPT_META` entry in `prompts/catalog.ts` with on-disk path `intelligence/bug-hunt-file-relevance.md`
  (the path `corpocode prompts --scaffold` writes for user overrides; resolution stays
  local → global → built-in via `prompts/resolve.ts`).

Intent (final wording tuned in the plan): *"You are given ONE file path and a bug description. Read the
file. Decide whether it is implicated in the bug. If so, cite the exact line ranges and a one-line
reason for each. Be strict — default `implicated:false` unless the file plausibly contains the fault.
Return only the schema."*

### 4.4 Synthesizer — `synthesizeBugHunt(result, intent) → string`

- Delegates to `synthesize(result, { tag: TAGS.intelligentRouter, header })` with a one-line header
  (e.g. `Bug-hunt: files investigated, cited lines below.`).
- Truncates to `cfg.maxInjectedTokens` (default 800) using the `length/4` token estimate. There is no
  shared helper today (two private copies exist, in `retrieval/aggregator.ts` and the OpenViking
  adapter); use a local copy of the same one-liner rather than inventing a util module for the POC.
  Drops lowest-confidence survivors first if over budget.
- Returns `""` when zero survivors → handler injects nothing.

### 4.5 Handler adapter — `handleBugHunt(envelope, ctx, decision) → HookResponse`

```
handleBugHunt(env, ctx, decision):
  intent = { kind:"prompt", prompt: env.prompt, sessionId: env.session_id,
             transcriptPath: env.transcript_path }
  candidates = await gather(intent, { graph: ctx.graph, memory: ctx.memory,
                                      project: ctx.project, logger: ctx.logger })
  plan = planBugHunt(intent, candidates, cfg)
  result = await race(engine.run(plan, { forTask: ctx.agents.forTask, log: ctx.logger.log }),
                      deadline(cfg.deadlineMs))     // deadline → empty result, nothing injected
  block = synthesizeBugHunt(result, intent)
  emit pattern decision event (see §5)
  return block ? { hookEventName:"UserPromptSubmit", additionalContext: block } : {}
```

- **Latency (approved: synchronous, hard-bounded).** The **per-agent `timeoutMs` = `cfg.perAgentMs`
  (10s) is the primary bound** — it is enforced inside the backend, each timed-out task fails open
  individually, and the fast tasks' results still land. With fan-out ≤ 3 running in parallel,
  `engine.run` completes in ~one agent-timeout, so surviving-partial behavior ("slow agent dropped,
  fast survivors injected") comes from the per-agent timeout, **not** from the outer race.
- **The `cfg.deadlineMs` (30s) race is a backstop only.** `engine.run` exposes no abort or
  partial-result channel (and this POC must not modify the engine), so when the deadline fires the
  race resolves to an **empty result and nothing is injected** — the pattern event records
  `reason:"deadline"`. With 10s agents × parallel fan-out 3 this path is effectively unreachable; it
  exists to guarantee the turn stays bounded if the backend's own timeout enforcement ever fails. The
  dispatcher's 45s backstop remains as defense-in-depth, never the primary guard.
- **Fail-open.** Any throw anywhere → return `{}`. `engine.run` is already per-task fail-open; the race
  wrapper resolves (never rejects) on deadline.

### 4.6 Composition — `src/hooks/handlers.ts`

Wrap the `UserPromptSubmit` handler in `buildHandlers()` so `router/handler.ts` and its tests stay
untouched:

```
composedUserPromptSubmit(env, ctx):
  turnStartedAt = now()
  base = await handleUserPromptSubmit(env, ctx)     // existing: rec + retrieval + review + delegation + toolbox
  if !ctx.agents: return base                        // flag off → byte-identical
  decision = readLastDecision(env.session_id, ctx.repoRoot, ctx.env)
  if !isBugLike(env.prompt, decision, turnStartedAt): { emit skip event; return base }
  hunt = await handleBugHunt(env, ctx, decision)
  return mergeContext(base, hunt)                     // append hunt's block to base.additionalContext
```

`mergeContext` is **new** (nothing like it exists today — the closest is `joinBlocks` in
`hooks/response.ts`, which joins tagged blocks with `\n\n`): it concatenates `hunt.additionalContext`
onto `base.additionalContext` with `\n\n` (both already tag-wrapped), preserving `base.hookEventName`.
When `hunt` is `{}`, returns `base` unchanged. It lives in `hooks/handlers.ts` next to the composition.

`writeLastDecision` is called synchronously inside `handleUserPromptSubmit` before it returns, **except
on the stage-1 trivial early-exit**, which writes nothing — so the composed handler may read a stale
prior-turn entry. The `decision.ts >= turnStartedAt` freshness check in `isBugLike` (§4.1) makes that
path a clean skip. This reuses the existing cross-hook cache rather than changing the base handler's
signature.

---

## 5. Decision-event schema (shared foundation)

Beyond the engine's existing `agent_item` (per task) and `orchestrate` (run summary) NDJSON lines, every
pattern emits **one** pattern-level decision event. Standardized here because `corpocode why` (feature
B1) and every later pattern consume it:

```json
{
  "event": "pattern",
  "pattern": "bug-hunt",
  "surface": "UserPromptSubmit",
  "session_id": "…",
  "decision": "ran" | "skipped",
  "reason": "gate:no-fresh-decision" | "gate:not-bug-like" | "ran" | "deadline" | "empty-candidates" | "error",
  "files_considered": 0,
  "files_fanned": 0,
  "survivors": 0,
  "injected_tokens": 0,
  "cost_usd": 0,
  "latency_ms": 0
}
```

Fields are best-effort; a missing value is `0`/omitted, never a thrown log. `pattern` and `surface` are
the stable keys B1 groups by; `reason` is a small closed vocabulary extended per pattern.

---

## 6. Configuration

New Zod slice `agents.bug_hunt` in `src/config/schema.ts`, all defaulted (so an absent block is valid):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Per-pattern off switch (only consulted when `agents.enabled`). |
| `max_files` | `3` | Fan-out cap = number of top candidate files investigated. |
| `per_agent_ms` | `10000` | Per-agent `timeoutMs`. |
| `deadline_ms` | `30000` | Hard overall race deadline for the fan-out. |
| `confidence_floor` | `0.5` | Judge drops survivors below this. |
| `max_injected_tokens` | `800` | Synthesis truncation budget. |

Env overrides flow through the existing flat `CORPOCODE_*` mechanism.

---

## 7. Observability & cost

- Engine already emits `agent_item` + `orchestrate`; `bug-hunt` adds the `pattern` decision event (§5).
- **Cost ceiling (POC-level):** a simple per-turn guard — if `result.usage.costUsd` exceeds a configured
  ceiling the run is already finished, so the guard is advisory for this POC (logged in the event). Full
  per-turn short-circuiting via `cost/tracker.ts` (cross-cutting requirement #5) is a later concretion,
  noted but **out of scope for A1**.

---

## 8. Testing — `tests/intelligence/patterns/bug-hunt.test.ts`

Fixture repo + synthetic transcript JSONL; no real `claude` spawns. Injection follows the existing
conventions — `buildHandlers()` takes no deps, so fakes enter either through a hand-built
`HookContext` passed straight to the handler (fake graph/memory/`AgentBackend` registry, as in
`tests/router/handler.test.ts` and `tests/intelligence/engine.test.ts`) or at dispatcher level via
`DispatchDeps.handlers`/`makeContext` (as in `tests/hooks/dispatch.test.ts`).

1. **Cited lines injected** — bug prompt + implicated fake result → injection contains the cited lines
   under the `intelligentRouter` tag.
2. **Flag-off parity** — with `agents.enabled:false`, composed `UserPromptSubmit` output is identical to
   the base handler's (byte-for-byte).
3. **Fail-open** — a throwing/erroring `AgentBackend` → composed handler still returns a clean response
   (base blocks preserved, no bug-hunt block).
4. **Per-agent timeout** — a fake agent slower than `per_agent_ms` fails open individually; fast
   survivors are still injected (this is the partial-survival path — see §4.5).
5. **Deadline backstop** — when the whole `engine.run` outlasts `deadline_ms`, the race resolves
   empty: nothing injected, clean response, pattern event `reason:"deadline"`.
6. **Gate** — a non-bug prompt (or a `docs`/`config` decision type) skips the fan-out entirely and emits
   `decision:"skipped"`.
7. **Stale-decision gate** — a cached decision with `ts` older than the turn (the trivial early-exit
   case) skips with `reason:"gate:no-fresh-decision"`; no fan-out.
8. **Judge** — `implicated:false`, below-`confidence_floor`, and schema-shape-invalid results (e.g.
   `implicated` as a string) are dropped.
9. **Plan producer purity** — `planBugHunt` builds the expected tasks from candidates with no I/O
   (unit-level, no engine).

`npm run verify` (build + `tsc --noEmit` + `vitest`) must stay green; existing
`tests/{router,filter,hooks}` pass unchanged with the flag off.

---

## 9. Files touched

**New**
- `src/intelligence/patterns/bug-hunt.ts` — the pattern (4 pieces + `isBugLike` + `BUG_SIGNAL` + schema).
  First file in a new `patterns/` directory.
- `tests/intelligence/patterns/bug-hunt.test.ts`.

**Modified**
- `src/hooks/handlers.ts` — compose `UserPromptSubmit` (wrap base + gated bug-hunt) + `mergeContext`.
- `src/prompts/registry.ts` — `BUILTIN_PROMPTS["bug-hunt-file-relevance"]` (the built-in body lives
  here as a string; no standalone template file is shipped — the on-disk copy is scaffold-generated).
- `src/prompts/catalog.ts` — matching `PROMPT_META` entry (path `intelligence/bug-hunt-file-relevance.md`);
  `assertCatalogComplete` fails the build without it.
- `src/config/schema.ts` — add the `agents.bug_hunt` slice.

**Unchanged (must not need edits)**
- `src/intelligence/engine.ts`, `gather.ts`, `synthesize.ts`, `router-router.ts`.
- `src/router/handler.ts` and its tests.

---

## 10. Invariants this design must not break

- **Gated + dark:** reached only when `ctx.agents` present; flag off ⇒ byte-identical output; tests assert parity.
- **Recursion guard:** every spawned agent runs `--bare` (enforced by the `anthropic-cli` backend; this
  pattern must not introduce an alternate spawn path).
- **Read-only:** all `bug-hunt` tasks are `tools:"read-only"`; asserted in tests.
- **Fail-open everywhere:** `invoke` never throws; the engine guards each task; the handler catches all;
  the deadline race resolves, never rejects.
- **Structure-only synthesis:** no HTML/markup from `synthesizeBugHunt`.

---

## 11. Out of scope (deferred to later patterns / phases)

- `router-router` triage call (reusing the categorizer decision is sufficient and cheaper for A1).
- `session` reuse / `--resume` for files discussed earlier (start ephemeral).
- `gather`'s `runRetrieval` fold.
- Full per-turn cost short-circuiting in `cost/tracker.ts`.
- Adding a real `bug`/`debug` moment type to the categorizer.
- The `corpocode why` reader (feature B1) — it *consumes* the §5 event schema pinned here but is its own
  spec/plan cycle.
