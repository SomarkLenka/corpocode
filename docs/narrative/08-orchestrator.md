# Chapter 08 — The orchestrator: the run

*The primary product. `corpocode start "<task>"` drives a whole engagement end to end: the
cockpit interrogates intent into a frozen spec ([chapter 05](05-upper-management.md)); a swarm
of cheap, write-capable agents implements it through interchangeable engines; a single expensive
arbiter verifies; Housekeeping promotes and cleans. The human authors every decision at spec
time and accepts the result at the end — everything between is autonomous.*

> This chapter is the run's charter. The mission of record is in
> [`docs/PHILOSOPHY.md`](../PHILOSOPHY.md); the hook/assist channel this mode grew out of is
> chapters [00](00-overview.md)–[04](04-housekeeping.md) and the spec in `corpocode-spec.md`.

---

## The lifecycle

```
corpocode start "<task>"
  ▼ UPPER-MANAGEMENT — the cockpit (chapter 05)
      interrogation → decisions ledger → spec.json + tasks.json → explicit approve poll
  ▼ MIDDLE-MANAGEMENT — the swarm
      decompose: taskSeeds → task graph (every task carries a verifyCommand, by construction)
      schedule:  topological waves, file-disjoint; overlaps serialized
      execute:   one write-capable cheap agent per task, in its own git worktree,
                 on corpocode/run/<id>/* branches — never the user's checkout
  ▼ VERIFICATION — the arbiter (the only strong-model role in the system)
      tier 1: run the task's verifyCommand — a red build never reaches a model
      tier 2: cheap MOLAR-EDIT screen over the diff
      tier 3: the arbiter reads spec slice + diff + digests, emits tiny verdict JSON
  ▼ HOUSEKEEPING
      promote trace → corpocode/run/<id>/clean, docs, memory consolidation, worktree cleanup
  ▼ THE HUMAN
      landing on the user's branch is an explicit poll — permanently never automatic
```

A run is a persisted state machine (`interrogating → specified → planned → building → verifying
→ rescuing → promoting → done/failed/paused`). Ctrl-C pauses and persists; resume picks up from
the artifacts (`spec.json`, `tasks.json` statuses, `run.json`) — checkpoints, not journal
replay. One active run per repo (lockfile).

## Engines as hands

The swarm writes code through the `AgentBackend` seam (`src/agents/backend.ts`) — the interface
that makes coding platforms interchangeable thrust. Today that is the `anthropic-cli` backend
(headless `claude --print --bare`, tool access via `--allowedTools`, resumable sessions); the
`agent-engine` backend (an optional opencode-backed peer) is the path to Codex, OpenCode, and
local models. Engine selection is one config word (`agents.task_backends.implement`), and
nothing outside the orchestrator's context builder names a backend — swapping the entire swarm's
hands is a config flip, not a refactor. Write-capable tool policy is the norm **only** for
implementer tasks; everywhere else the read-only default stands.

Isolation is physical, not advisory: an implementer's process runs with its **cwd set to its own
git worktree** under `.corpocode/runs/<id>/worktrees/`, that worktree is the only directory the
engine is granted, and the user's checkout is never in scope. The permanent regression invariant:
**the user's branch SHA is unchanged after any run.**

## The economics

Input tokens are cheap; output tokens are expensive. The swarm is wide and cheap and writes
everything; the arbiter is narrow and expensive and writes almost nothing — verdict JSON with a
hard output-token cap, guidance never code. The verification funnel enforces the thesis
mechanically: deterministic checks run first (free), the cheap tenet screen second, and only
evidence that survives both reaches the strong model. Costs flow through the existing usage
tracking, and a `BudgetGuard` checks the run's cap **before** each wave — a breach pauses the
run and asks, never silently degrades.

## Verification cadence is a knob

`orchestrator.verify.cadence` (`per-task` | `per-wave` | `final`) × `mode` (`gate` |
`verify-rescue`) is explicitly experimental — the right cadence is an empirical question the
journals will answer. Semantics are fixed even where support lands later: **gate** halts on a
failed verdict and raises an escalation poll (fix manually / respec / accept-with-waiver);
**verify-rescue** re-dispatches the verdict to the *same* persistent implementer session (its
context survives rescue rounds) up to `max_redispatch`, then escalates. Unsupported cadences
coerce to `final` with a journaled warning rather than failing. The arbiter's `spec_gaps`
always route back to the cockpit regardless of verdict — verification finds spec holes, not
just code faults.

## CorpoCode as host: the principle inversion

In hook mode, CorpoCode lives inside someone else's turn and **fails open, always**. In
orchestrator mode the polarity flips: CorpoCode *is* the host, and its gates — verification,
budget, watchdog, scope — may **block** its own worker engines. Fail-open still binds at every
boundary CorpoCode does not own: the user's checkout, the user's branches, a dead interactor
(which resolves a declared default, journaled, or pauses the run — never hangs, never guesses).
The git trace/clean machinery becomes native run hygiene: per-task atomic trace commits on
CorpoCode-owned branches, promotion squashes to a readable `clean` branch, and the boundary
where the human takes over is the landing poll.

## Run state and observability

Everything a run is lives in `.corpocode/runs/<runId>/`: `spec.json` (+ derived `spec.md`),
`tasks.json`, `run.json`, the decisions ledger, worktrees, and an NDJSON journal written through
the same Logger seam as every hook event — so `corpocode why` explains a run and `corpocode
monitor` watches one with zero new plumbing. The run journal is narration; the artifacts are the
checkpoints. Runs are pruned on a TTL like sessions.

The **Interactor seam** (`src/interact/`) is the repo's first interactive surface: a terminal
Q&A loop first, then a monitor-style local web cockpit (loopback only — poll cards with
per-axis consequence tables, the amber→green section ledger, a live task board, an intervention
box whose entries land in the same decisions ledger). A paused run is always surfaced: a badge
in the web cockpit/monitor, a terminal exit summary, and a non-zero exit code in scripted runs.

On release builds, all of this is gated behind `corpocode init` onboarding — the user chooses
the arbiter model, the poll granularity, and the budget before `start` will run (local
testing: `--dev` / `CORPOCODE_DEV=1`).

## Hook mode: the assist channel

The original hook channel keeps running unchanged beside the orchestrator — same abstractions,
same memory, same logs, byte-identical behavior whether or not orchestrator config is present
(enforced by a parity suite, plus a ban on any `src/hooks/` → orchestrator import). The agent
substrate stays dark there (`agents.enabled` default false); orchestrator commands construct it
unconditionally, because here there is no host to protect. Coexistence with superpowers inside
a host's turn remains the secondary-mode roadmap
([SUPERPOWERING-SUPERPOWERS](../SUPERPOWERING-SUPERPOWERS.md) Part II) — the two modes
deliberately share the `tasks.json` schema so specs and plans flow both ways.

---

*Back to [chapter 05 — the cockpit](05-upper-management.md), or
[chapter 06 — the IntelligentRouter](06-intelligent-router.md) for the engine this run fans out
through.*
