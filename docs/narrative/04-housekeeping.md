# Chapter 04 — Housekeeping

*The cheap-model crew that runs during and after the main model's work. At `PostToolUse` it verifies
each edit against the MOLAR-EDIT tenets (and can block it) and records the write to an atomic git
"flight recorder"; at `Stop` it compacts the transcript into tiered memory, consolidates learnings,
curates the trace branch into a clean narrative, and documents the code the session actually changed.
Like everything in CorpoCode, it is fail-open: nothing it does is ever allowed to break the host's turn.*

---

## The `PostToolUse` pipeline: the verifier with teeth

`handlePostToolUse` (`verifier/handler.ts`) runs after every tool call:

1. **Gate and extract.** Bail immediately if `verify_on_edit` is off. `extractWrittenFile` returns a
   path only for `Write`/`Edit`/`MultiEdit`; anything else is a no-op.
2. **Build the engine.** `createMolarEditEngine` is constructed with the verifier's *cheap* provider,
   the config, and any **plugin-contributed checks** (`ctx.plugins.tenets`). If no tenets are active, it
   returns immediately.
3. **Fan out.** `engine.verify([file])` runs one provider call per (active check × file) where the
   check `appliesTo` that path. They run via **`Promise.allSettled`, not `all`** — so a thrown or
   timed-out lens is isolated and degrades to a neutral finding rather than sinking the others. Each call
   is JSON-mode, capped at 250 tokens, with the file content sliced to 6000 chars and an 8s timeout.
4. **Aggregate to a verdict.** `aggregateFindings` collects every `ok === false` finding as a violation,
   but the edit is **blocked only by a single `severity: "block"` finding with `confidence ≥ 0.7`.**
   Everything below that bar is downgraded to advice — *a false block is its own kind of harm.*
5. **The memory write-back loop.** If there are violations, it **recalls this file's prior `mistake`
   memories first** (so the "repeats" count reflects history, not what's being written now), then captures
   each new violation as a file-anchored `mistake`. This is the loop the context injector reads back
   before the next edit to the same file: *a violation today becomes a warning tomorrow.*
6. **Log** one `verifier_check` line per finding plus a summary.
7. **Record the write to git** via `recordWrite` — one atomic trace commit, wrapped best-effort so a
   non-repo or any git error never affects the turn.
8. **Return.** Blocked → `{ continue: false, stopReason }` (the stop reason names the tenet and message).
   Non-blocking violations → `additionalContext` with the formatted advice. Otherwise `{}`.

## The `Stop` pipeline: the compactor

`handleStop` (`compactor/worker.ts`) runs after the model finishes, **wrapped entirely in one
`try/catch`** so any error degrades to an empty response — the plane keeps flying with the compactor's
engine out.

1. **Read and window.** `computeWindow` splits the transcript into `preserved` (recent, kept verbatim)
   and `compactable` (aged-out, to be distilled). The inviolable rule: **preserved turns are never
   compacted** — the model always keeps its most recent context intact.
2. **Tiered digest.** If there is anything compactable, `makeDigest` asks the `compactor` provider for a
   ≤600-token summary (falling back to a keyless plain digest if no provider is available) and writes it
   via the `ContextStore` under a `viking://agent/memories/…` URI, where it is tiered into L0/L1/L2. **On
   any daemon failure it falls back to a plain `memdir` file** — so the learning is never lost. Setting
   `compaction.backend: "memdir"` makes the plain dir the primary path for daemon-averse users.
3. **Consolidate memory.** `memory.consolidate` mines typed memories and resolves supersession,
   returning `{ captured, superseded }`; best-effort.
4. **Close the outcome loop.** It reads the session's last routing decision and, if anything was
   recalled, calls `recordOutcome` to reweight those memories — a neutral-positive signal for now, pending
   a real cross-process pass/fail signal.
5. **Log** one `compaction` line.
6. **Promote trace → clean.** A `Stop` is a natural unit boundary, so `maybePromote` plans and (in auto
   mode) applies the promotion; best-effort.
7. **Document the changes.** The trace∆clean file set feeds `runDocGeneration`; best-effort and
   hard-capped.

It returns `{}` — **the `Stop` hook never alters the host.**

## MOLAR-EDIT: nine atomic tenets

The verifier and the design-review team both check work against nine tenets, each a *single*
single-purpose check:

| | Tenet | Check |
| --- | --- | --- |
| **M** | Maintainability | `maintainability:isolated-and-honest` |
| **O** | Observability | `observability:metrics-and-readiness` |
| **L** | Logging | `logging:structured-and-actionable` |
| **A** | Atomicity | `atomicity:one-thing-per-unit` |
| **R** | Responsiveness | `responsiveness:accessible-and-structural` (UI files only) |
| **E** | Extensibility | `extensibility:swappable-behind-a-seam` |
| **D** | Documentation | `documentation:why-not-what` |
| **I** | In-flight | `in-flight:timeout-retry-fallback` |
| **T** | Testing | `testing:regression-and-failure-paths` |

**One check per tenet, atomic by design.** Each `TenetCheck` carries exactly: a tenet letter, a short
name, an `appliesTo(file)` predicate (drawn from shared file-type regexes, so "what counts as
source/UI/docs" is defined once), and a single-purpose prompt derived from the rubric. The engine fans
out one provider call per active tenet and aggregates deterministically. This is *why* growing from two
tenets to nine was purely additive — the registry under `tenets/` grew, the runner never changed shape.
The same engine backs both `verify()` (post-edit, over changed files) and `review()` (at a breakpoint,
over a proposed approach).

**Community extension.** `createMolarEditEngine` takes `extraChecks`, and the merge filters
`[...ALL_CHECKS, ...extra]` by the active set. So a `corpocode-tenet-*` plugin package appends checks into
the *same registry the engine reads* — never the engine itself. Disabling a tenet in `active_tenets`
stops its checks, including plugin ones.

## The git model: flight recorder vs narrative

A coding agent emits a torrent of edits, and you want two contradictory things from that history — an
atomic, bisectable record *and* a curated, readable one. One branch can't be both, so CorpoCode keeps
two:

- **Trace branch** (`corpocode/trace`) — **one atomic commit per write.** It is the bisectable flight
  recorder. It is safe to do automatically because it **never touches the user's index, HEAD, or working
  tree** (see the plumbing trick below).
- **Clean branch** (`corpocode/clean`) — the curated narrative. `planPromotion` diffs `clean..trace`,
  buckets the changed files by concern (directory), and produces a deterministic list of `CommitSet`s —
  the same decompose-then-aggregate shape the retrieval team uses. `promote` squashes each bucket onto
  clean.

**Suggest vs auto** (`config.git.mode`, default `suggest`): in *suggest* mode `promote` is a no-op — the
plan is computed and surfaced via the log, but applied by no one. The user disposes. In *auto* it commits
onto clean.

**The plumbing trick.** `commitFilesToBranch` builds each commit through a *temporary index file*
(`GIT_INDEX_FILE = .git/corpocode-index-<branch>`): read-tree the branch tip → add working-tree content
→ write-tree → commit-tree → update-ref. The user's index, HEAD, and worktree are never touched — which
is precisely what licenses automatic per-write trace commits. And destructive operations are refused
*structurally*: `assertSafe` throws on force-push, hard reset, and history rewrite before they ever reach
git, so no bug elsewhere can issue one. `git/hook.ts` is the thin best-effort bridge (`recordWrite`,
`maybePromote`, `tracedFiles`); all three no-op on a non-repo.

## Documentation from the call graph, not the diff

The doc generator's defining choice: the **blast radius** of a change (`touches`) is *resolved from the
KnowledgeGraph's neighbors, never asked of the model* — the structural truth already exists in the graph,
so it is looked up, not guessed. Everything else (impacts, risks, the input/transformation/output facets)
is a cheap single-purpose pass fanned out in parallel and assembled deterministically. A `signature`
field makes the work idempotent: an unchanged symbol costs nothing to "re-document." Generation is
hard-capped (a handful of source symbols per `Stop`).

## Why it is shaped this way

- **Verify per-edit, not at the end** — a violation is caught while the model still has context, and the
  next edit to the same file can see yesterday's mistake.
- **Block only on high-confidence `block`** — a false block wastes a turn and trains distrust, so the bar
  to halt the host is deliberately high; everything else is advice.
- **Two git branches** — you need both a flight recorder (debugging) and a narrative (review); one branch
  can't be both.
- **Suggest by default** — trace recording is automatic because it is isolated and safe, but a durable
  change to the user's clean history is theirs to approve. The same philosophy governs skill mining: it
  stops at "candidate," and `skillify --promote` is the explicit user step.
- **Compaction at `Stop`** — the natural quiescent boundary: the model is idle, the transcript is
  complete, and it's a clean unit boundary for promotion. Compacting mid-turn would fight the model for
  context.
- **Fail-open everywhere** — `allSettled` in the fan-out, the whole compactor wrapped, git hooks no-op on
  a non-repo, a failed doc facet returns empty, a corrupt sidecar is treated as absent.

## Key types

```ts
interface TenetCheck { tenet: Tenet; name: string; appliesTo(file: { path: string }): boolean; prompt: string; }
interface TenetFinding { tenet: Tenet; ok: boolean; severity: "info"|"warn"|"block"; message: string; confidence: number; }
interface MolarEditEngine { activeTenets(): Tenet[]; verify(files: string[]): Promise<TenetFinding[]>; review(designContext: string): Promise<TenetFinding[]>; }

const BLOCK_CONFIDENCE = 0.7;
interface VerifierVerdict { violations: TenetFinding[]; blocked: boolean; blockFinding?: TenetFinding; stopReason?: string; }

type GitMode = "suggest" | "auto";
interface CommitSet { files: string[]; message: string; rationale: string; }
interface GitManager {
  ensureBranches(name: string): Promise<BranchPair>;
  commitWrite(file: string, opts: { sessionId: string; mode: GitMode }): Promise<void>;
  planPromotion(repoRoot: string, since: string): Promise<CommitSet[]>;
  promote(sets: CommitSet[], mode: GitMode): Promise<void>;
  conflicts(repoRoot: string): Promise<string[]>;
}

interface WindowSplit { preserved: TranscriptMessage[]; compactable: TranscriptMessage[]; }
// DocRecord.touches is resolved from the graph; DocRecord.signature gates re-documentation.
```

## How it connects

- **MemoryStore** — the verifier captures/recalls file-anchored `mistake` memories (the violation →
  warning loop); the compactor calls `consolidate` and `recordOutcome`; skill mining harvests
  `mistake`/`approach` memories.
- **ContextStore / OpenViking** — the compactor's primary digest path, with `memdir` the keyless
  fallback.
- **KnowledgeGraph** — the doc generator's `touches` comes from `getNode` + `getNeighbors`.
- **Provider registry** — every component here pulls a *cheap* model via `forComponent`.
- **Plugin tenet packs** — `corpocode-tenet-*` packages contribute checks through `ctx.plugins.tenets`,
  merged into the same registry behind the same interface.

## Invariants a contributor must not break

- **Preserved turns are never compacted.**
- **Block requires both `severity === "block"` and `confidence ≥ 0.7`** — a lower-confidence block is
  intentionally downgraded to advice.
- **Recall before capture** in the verifier — the `repeats` count must read prior history before this
  turn's violations are captured.
- **No destructive git, by construction** — `assertSafe` refuses force-push / hard reset / rebase /
  filter-branch, and the `GitManager` API has no such operations.
- **Trace recording never touches HEAD/index/worktree** — it works through a throwaway index file. This
  is the invariant that licenses automatic per-write commits.
- **Doc generation is hard-capped and signature-gated** — at most a handful of cheap passes per `Stop`,
  and an unchanged symbol is skipped.

> **A note on file layout.** The git "trace" and "promote" behaviors are *methods on
> `git/manager.ts`* (with low-level work in `git/plumbing.ts` and hook bridges in `git/hook.ts`), not the
> standalone `trace.ts`/`promote.ts` an older spec implied. The skill loop is split into `loops/skillgen.ts`
> (mine → candidate) and `commands/skillify.ts` (promote candidate → installed skill).

---

*Continue to [chapter 05 — the IntelligentRouter](05-intelligent-router.md).*
