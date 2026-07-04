# IntelligentRouter — Remaining Phases (explicit spec)

Imperative spec for the work that remains on the IntelligentRouter. The **infrastructure is built**
(Phases 0, 1a, 4 — see "Built" below); what remains is the set of **atomic action-patterns** and the
final **cacheGuard**. This document is the authoritative checklist to review before building each phase.
Narrative / recap documentation will be written separately, on top of this.

> **Re-scoped under the orchestrator build order.** This engine is the execution substrate of the
> orchestrator mode (`docs/narrative/08-orchestrator.md`) — its first live consumers are the
> Upper-Management cockpit's consequence fan-out and Middle-Management's implementer swarm
> (`docs/narrative/05-upper-management.md`), which land **before** the hook-mode action-patterns
> below. The phase list that follows (bug-hunt → pre-write → workspace capabilities → cacheGuard)
> is the *hook-channel* roadmap and proceeds after — its flag-off parity acceptance criteria are
> the hook-mode non-regression tests and stay binding.
>
> Source plan (working notes): `~/.claude/plans/flesh-out-our-anthropic-cli-stateful-rose.md`.
> Governing principle: **infrastructure first, action-patterns atomic and deferred.** The engine never
> hardcodes what an agent does; each pattern is a small module that *produces a plan* the engine runs.
> The agent-loop shape — turn caps, stop conditions, fan-out width, session reuse — lives in the plan a
> pattern emits, decided per-pattern, **not** baked into the engine. Everything fail-open (In-flight).
> Gating is **mode-conditional**: in the hook channel this layer is config-gated (`agents.enabled`,
> default false), ships dark in hook mode, and is byte-identical with the flag off; orchestrator
> commands construct the agent registry unconditionally — there, this engine is live and primary.

---

## Built (do not rebuild — compose these)

The shared building blocks every pattern composes, with their real signatures:

| Block | Signature | File |
| --- | --- | --- |
| Intent | `type Intent = {kind:"prompt",prompt,sessionId,transcriptPath} \| {kind:"pre-write",file,proposedContent?,…} \| {kind:"pre-read",file,…} \| {kind:"post-write",file,…}` | `src/intelligence/types.ts` |
| gather | `gather(intent, deps:{graph,memory,project,limit?,logger?,runRetrieval?}) → Promise<Candidates>` where `Candidates = {files:ScoredFile[],nodes:GraphNode[],neighborhoods:Neighborhood[],memories:ScoredMemory[],retrieval?}` — deterministic, per-source fail-open | `src/intelligence/gather.ts` |
| OrchestrationPlan | `{ tasks: AgentTask[]; fanoutWidth?: number; judge?: Judge }`, `AgentTask = {id, call: AgentCall}` | `src/intelligence/types.ts` |
| engine.run | `run(plan, deps:{forTask,limiter?,now?,log?}) → Promise<OrchestrationResult>` — bounded fan-out, pluggable judge (default keepOk), aggregated usage, per-task fail-open | `src/intelligence/engine.ts` |
| synthesize | `synthesize(result, opts?:{tag?,header?}) → string` — ONE tagged block (`TAGS.intelligentRouter`), `""` no-op when nothing survives | `src/intelligence/synthesize.ts` |
| router-router | `route(intent, deps:{forTask,enabled?,isTrivial?}) → Promise<RouteDecision>` — `{route:"dumb",…}\|{route:"smart",…}`, STRICT→smart | `src/intelligence/router-router.ts` |
| AgentBackend seam | `invoke<T>(AgentCall<T>) → Promise<AgentResult<T>>` (never throws), `release/health/ping/shutdown` | `src/agents/backend.ts` |
| AgentCall | `{component, taskKind, task, inputs?{transcript,files,reasoning,decisions}, model?, effort?, schema?, tools?, session?, strategy?, timeoutMs?}` | `src/agents/backend.ts` |
| registry | `ctx.agents?: AgentRegistry` → `forTask(kind)`, `all()`, `availableFor(kind)` — present only when `agents.enabled` | `src/agents/registry.ts`, `src/hooks/context.ts` |
| sessions | `createSessionStore({ttlMs,maxSessions,cwd?,env?,now?,logger?})` → `{get,put,remove,evict,all}`; `sessionKeyForFile(host,relpath)`, `sessionKeyForTopic(host,slug)` | `src/agents/sessions.ts` |

Config knobs (all under `agents`, default off): `enabled`, `default_backend`, `task_backends`,
`max_parallel`, `session_ttl_ms`, `max_sessions`, `router_router`.

Task kinds (`AGENT_TASK_KINDS`, single source of truth in `backend.ts`): `triage`, `rank`,
`file-relevance`, `pre-write-guidance`, `review`, `housekeeping`, `general`.

---

## The action-pattern contract (every pattern below implements exactly this)

One module under `src/intelligence/patterns/<name>.ts`, exporting four atomic pieces:

1. **Plan producer** — pure `(intent: Intent, candidates: Candidates, cfg) → OrchestrationPlan`. No I/O.
   This is where the **deferred decisions live**: which tasks, fan-out width, per-agent `tools`/`session`,
   the `judge` (confidence/fit filter), and the implicit stop condition (the plan is finite).
2. **Prompt ids** — the editable prompt(s) the agent task(s) use, registered in `prompts/registry.ts`
   and resolved via `prompts/resolve.ts` (local→global→built-in), never inline strings.
3. **Synthesizer** — `(result: OrchestrationResult, intent) → string`. Uses `synthesize` (or a
   pattern-specific shape via `joinBlocks`). Structure/meaning only — never HTML/markup (the one rule).
4. **Handler adapter** — thin, gated. Builds the `Intent` from the hook envelope, runs
   `router.route → gather → plan → engine.run → synthesize`, returns a `HookResponse`. Signature stays
   `(envelope, ctx) => Promise<HookResponse>` so the dispatcher's catch-all + 45s budget are untouched.

**Wiring rule:** a pattern is reached only via its surface handler, only when `ctx.agents` is present
(`agents.enabled`). With the flag off the handler path is not taken and output is byte-identical to today.

---

## Phase 1 (POC) — `bug-hunt`  ·  `src/intelligence/patterns/bug-hunt.ts`

The first pattern. Proves the whole infra end-to-end and the path for Phases 3 + 5.

- **Surface / intent:** `UserPromptSubmit` → `Intent{kind:"prompt"}`.
- **gather:** `graph.scoreFiles(prompt)` + `memory.recall({kinds:["mistake","rule"]})` (already what
  `gather` does for a prompt intent). Optionally fold `runRetrieval` later.
- **plan:** fan out **one `file-relevance` agent per ranked file**. Each task:
  `tools:"read-only"`, `task = "read this span, decide if implicated, cite exact lines"`,
  `schema = {implicated:boolean, lines:[{start,end,why}], confidence:number}`.
  Initial loop shape (a **deferred decision** to confirm): `session:"ephemeral"`, `fanoutWidth ≤ 3`.
- **judge:** drop `!implicated`, low-confidence, and timed-out; keep diagnostics.
- **synthesize:** cited-lines block under `TAGS.intelligentRouter` → the main model skips the reads.
- **Deferred decisions to finalize here:** per-file `session:{reuse,persist}` (resume a file discussed
  earlier) vs ephemeral; fan-out width vs the 45s budget; the confidence floor; the injected-token cap.
- **Gating / acceptance:** flag off ⇒ `UserPromptSubmit` output byte-identical to today. Tests: a
  fixture repo + synthetic transcript JSONL, fake graph/memory + fake `AgentBackend` injected via
  `dispatch.ts` deps; assert the injection contains cited lines, flag-off parity, and that a throwing
  backend still yields a clean fail-open response.

---

## Phase 3 — `pre-write` (atomic sub-patterns)  ·  `src/intelligence/patterns/pre-write.ts`

`PreToolUse(Write|Edit)` → `Intent{kind:"pre-write",file,proposedContent}`. PreToolUse can only inject
(and optionally `ask`/`deny`), so the architectural guidance lands now and heavier work is deferred to
`PostToolUse`. Two **independent atomic units**:

- **`architectural-guidance`** — `gather` → `graph.getNode(file)+getNeighbors` (blast radius) +
  `memory.recall({file})`; one `pre-write-guidance` agent: "what not to touch, how this breaks Y";
  `schema = {warnings:[{claim,severity,refs}]}`. Synthesize a guidance block injected **now**.
- **`deferred-actions`** — write a `pending-actions` disk record keyed by session+file (same handoff
  discipline as `session/decision-cache.ts`), consumed at the top of `handlePostToolUse`
  (`verifier/handler.ts`) and committed via the existing `git/hook.ts:recordWrite`. Candidates for the
  deferred set: a pre-test agent (scoped write), an inline-docs agent.
- **Deferred decisions:** which actions run inline vs deferred; whether to ever `ask`/`deny` (default:
  inject only); the scoped-write posture for the pre-test agent (`--add-dir` sandbox vs diff-only).

---

## Phase 5 — the integral workspace capabilities (each its OWN atomic module)

Finalized independently, one at a time, each `src/intelligence/patterns/<name>.ts` with its own tests
and an asserted tool allow-list. Each decides its own agent-loop shape and stop condition.

| Module | Purpose | Surface(s) | Notable tool posture |
| --- | --- | --- | --- |
| `relevance.ts` | distill the gathered candidates into the few that matter | UserPromptSubmit | read-only |
| `test-author.ts` | author / propose a failing regression test (TDD for fixes) | pre-write / post-write | scoped write (sandbox `--add-dir` or diff-only) |
| `docs.ts` | inline-docs / doc authoring for a changed unit | post-write | scoped write |
| `git-housekeeping.ts` | stage/commit narrative upkeep | post-write / Stop | `housekeeping`, git via `git/hook.ts` |
| `skill-load.ts` | load a relevant skill by name into context | UserPromptSubmit / PreToolUse | read-only + skill load |
| `mcp-invoke.ts` | call a relevant MCP tool and fold the result | PreToolUse | `tools.mcp:[…]` opt-in |
| `subagent-request.ts` | request a host subagent (reuse `router/delegation.ts`) | UserPromptSubmit | read-only |
| `review.ts` | route the breakpoint review (`router/handler.ts`) through agent fan-out | post-write breakpoint | read-only, multi-lens judge |

**Cross-cutting for Phase 5:** widen tool posture **only** per task that needs it; everything else stays
read-only. Each module asserts its allow-list in tests. `review.ts` should use a perspective-diverse
judge (correctness / security / repro), not N identical verifiers.

---

## Phase 6 (FINAL) — `cacheGuard`  ·  `src/intelligence/cache-guard.ts`

A cross-cutting advisor that maximizes cache hits. Does **not** change WHAT runs — only HOW calls are
shaped/ordered. Built **last**, after the patterns' call shapes have settled (building earlier chases a
moving target). Advisory + nix-able: with it off, calls run unshaped.

- **Stable maximal prefix.** Per `AgentTaskKind`, fix the system/task prompt + tool set and place it
  first; append variable inputs last → repeated calls share the longest cacheable prefix (the `claude`
  CLI prompt-caches a stable prefix).
- **Session-warmth bias.** When a per-file/per-topic session is warm, prefer `--resume` (already cached
  server-side) over a cold ephemeral call — feeds the router's reuse-vs-new decision.
- **In-turn memoization.** Content-address identical `(taskKind + normalized inputs + model)` calls and
  return the cached `AgentResult` within a short TTL (reuse `perf/cache.ts`), so a fan-out that re-asks
  the same thing pays once.
- **Acceptance:** measured by cache-hit rate + cost drop in the NDJSON; off ⇒ no behavior change.

---

## Cross-cutting requirements (apply to every phase above)

1. **Recursion guard (mandatory).** Every spawned agent runs with `--bare` (skips hooks/plugins) — a
   spawned `claude` must never re-trigger CorpoCode's hooks. Correctness, not perf.
2. **Gated + dark.** Reached only when `agents.enabled`; flag off ⇒ byte-identical to today; existing
   `tests/{router,filter,hooks}` pass unchanged with the flag off.
3. **Fail-open.** `invoke` never throws; the engine degrades a missing/failed backend to a dropped task;
   a pattern that errors must still return a clean `HookResponse`.
4. **Observability.** One NDJSON line per agent + a run summary (the engine already emits `agent_item` +
   `orchestrate`); patterns add their own `event` lines for gather/synthesize decisions.
5. **Cost ceiling.** Extend `cost/tracker.ts` with a per-turn cap that short-circuits fan-out and
   degrades to deterministic candidates when exceeded.
6. **Read-only by default.** Widen tool posture only per task that needs it, asserted in tests.

## Open decisions to resolve per pattern (the deferred concretions)

These are intentionally **not** decided yet; each pattern fixes them in the plan it emits:
turn caps (`--max-turns`) · stop conditions · `--resume` vs `--fork-session` per task kind · scoped-write
sandboxing for write-capable agents · confidence floor + injected-token budget cap · synchronous vs
deferred-to-next-turn agent enrichment if latency pressures the 45s hook budget.

---

## Build order

Phase 1 (`bug-hunt` POC) → Phase 3 (`pre-write`) → Phase 5 (each capability, independently) →
Phase 6 (`cacheGuard`). Review this spec, then write the narrative recap, **before** starting Phase 1.
