# Phase 2 — Definition of Done → evidence

Maps every Phase 2 acceptance criterion (from `phase2.md`) to the code and tests that satisfy it.
`npm run verify` (build + `tsc --noEmit` + lint + `vitest`) is green: **238 tests / 39 files**
(up from Phase 1's 190/31).

Phase 2 is the turning point where CorpoCode stops observing and starts participating: the filter
can deny, the verifier can halt, the retrieval team assembles context, the injector reshapes reads,
the design-review team weighs in, the compactor writes finished work back into memory, and memory is
written as well as read. The governing invariant is unchanged — every new power degrades to
**inaction** on error, never to disruption.

| # | Criterion (phase2.md) | Evidence |
| --- | --- | --- |
| 1 | OpenViking adapter completes the ContextStore: find/load/tree/write round-trip at all three tiers; health/ping reflect real state; a refused connection triggers exactly one restart then success or a clean error | `src/backends/context/openviking-adapter.ts`; `tests/backends/context/conformance.test.ts` (8 — tier round-trip, grep, health up/down, one-restart, stays-down clean error, **missing-binary fail-fast**) |
| 2 | Memory writing side: captured memory immediately recallable; consolidation over a reversing transcript sets `supersededBy` and drops the old from recall while the new appears; mistakes survive decay while stale decisions are down-ranked; outcomes shift ranking; a fresh session recalls prior decisions; corrupt store → empty recall, no throw; embeddings via the configured provider | `src/backends/memory/native.ts` (injectable miner + `findLiveConflict` supersession); `tests/backends/memory/conformance.test.ts` (11, incl. supersession + unrelated-no-supersede) |
| 3 | Retrieval team fans out across all three abstractions: a medium prompt yields a retrieval summary + one item line per checklist item; succeeded == items on the happy path; total latency ≈ a single item; killing a backend mid-run drops only that item while the package returns; injected context within budget | `src/retrieval/*` (planner+templates, fanout, item-handler, aggregator, worker); `tests/retrieval/worker.test.ts` (6 — counts, cue-folding, parallelism, mid-run kill, timeout, budget truncation) |
| 4 | Context injector: an obvious purpose rides onto the slice; an unknown purpose yields a clarifying question; a file with a recorded mistake surfaces the warning before the edit; a low-confidence relevance pass falls back to the full read | `src/filter/inject.ts`; `tests/filter/inject.test.ts` (5 — slice, warning, low-confidence fallback, clarifying question, exploration-whole-file) |
| 5 | Filter teeth: a destructive command is denied before the model acts; a safe command is auto-allowed without a prompt; an uncertain command routes to ask | `src/filter/classify.ts` (+ soft LLM classifier), `src/filter/handler.ts`; `tests/filter/handler.test.ts` (6), `tests/filter/classify.test.ts` (4) |
| 6 | Verifier fans out over active tenets: an edit violating two tenets → summary + one check line per tenet in parallel, both surfaced; a broken check doesn't sink the others; a high-confidence block halts the edit; removing a tenet stops its check; a violation is written to memory | `src/verifier/{worker,aggregator,handler}.ts`, `src/verifier/tenets/*` (9), `src/molar/engine.ts`; `tests/verifier/worker.test.ts` (6), `tests/verifier/handler.test.ts` (5), `tests/molar/engine.test.ts` (4) |
| 7 | Design-review team at breakpoints: one review line per active tenet in parallel, injected before any write; narrowing the active set fires only those lenses | `src/review/{team,aggregator}.ts`, `src/molar/engine.ts` `review()`; `tests/review/team.test.ts` (3), `tests/molar/engine.test.ts` |
| 8 | Compactor runs on both backends, never compacts the preserved window, and falls back cleanly when the daemon is killed rather than raising | `src/compactor/{sliding-window,openviking,memdir,worker}.ts`; `tests/compactor/sliding-window.test.ts` (4), `tests/compactor/worker.test.ts` (3 — openviking primary, memdir fallback on daemon failure, memdir primary) |
| 9 | Model-and-effort selection is honored for the work CorpoCode spawns while its guidance reaches the main model | `src/providers/effort.ts` `applyEffort` (threaded into verifier checks, retrieval planner, review reviewers); router emits actionable guidance in the recommendation; `tests/providers/effort.test.ts` (4) |

## Wiring

`src/hooks/handlers.ts` now registers all four hooks: UserPromptSubmit (categorizer → retrieval →
design review), PreToolUse (filter teeth + injector), PostToolUse (verifier), Stop (compactor).
`src/router/handler.ts` dispatches retrieval when `dispatch_retrieval` is set and design review at a
`breakpoint`, threads the selected effort into both, and caches the decision + recalled ids per
session (`src/session/decision-cache.ts`) so the injector and compactor can read them across
processes.

## Notable correctness fix found by smoke-testing the real binary

A non-trivial `UserPromptSubmit` on an unprovisioned machine crashed the host hook process: the
OpenViking adapter's default spawner created a `ChildProcess` for `openviking-server`, whose async
`'error'` (ENOENT) event had **no listener** — an unhandled `'error'` is fatal in Node and bypassed
the dispatcher's fail-open catch entirely. Fixed by attaching an error handler that records the
failure so startup fails fast and degrades, never crashes (the In-flight tenet). Guarded by a
regression test that drives the real spawner against a missing binary
(`tests/backends/context/conformance.test.ts` → "fails fast and cleanly when the server binary is
missing"). graphify's transport already handled this; OpenViking now does too.

## Real-binary smoke (state redirected to a temp dir)

- `PreToolUse` Bash `rm -rf /` → `permissionDecision: "deny"` (deterministic, no provider).
- `PreToolUse` Bash `git status` → `permissionDecision: "allow"`.
- `PreToolUse` Read with no clear purpose → `<middle-management file-context>` clarifying question.
- `PostToolUse` Write with no API key → `{}` (neutral, fail-open).
- `Stop` with no transcript → `{}` (fail-open).
- `UserPromptSubmit` non-trivial with no daemons/key → `<middle-management recommendation>` with a
  graph-scored, structurally-related candidate; retrieval ran and degraded with no crash.

## Environment-limited verifications

Live OpenViking find/load/tree/write against a running daemon and graphify MCP over a real Python
server need credentials/daemons not present in CI; both are exercised with injected fakes behind the
same seam (the conformance suites), and `corpocode doctor` reports each honestly. The deferred
Phase 3+ items (multi-platform install, git two-branch model, doc generator, skillgen, auto-route to
delegates) are intentionally not present.
