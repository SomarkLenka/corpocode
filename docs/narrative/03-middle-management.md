# Chapter 03 — Middle-Management

*The caretaker that **guides** the developer. It opens every turn: reads the transcript to understand
what the main model is doing, categorizes the moment, and then — rather than route to one template —
**instantiates a team of independent, single-purpose cheap-model agents** to handle everything the model
might need that isn't the code itself. It recalls memory and graph structure, builds a budget-bounded
context package, design-reviews the approach at a breakpoint, picks the model and effort to match the
difficulty, and injects all of it — so the expensive model arrives already oriented and writes less to
get there.*

> This chapter is the longest because it is the heart of the per-turn experience. Two hooks drive it:
> `UserPromptSubmit` (orient) and `PreToolUse` (guard and focus).

---

## The charter: a prompt engine, not a prompt router

Middle-Management is the clearest expression of the [fan-out engine](00-overview.md#the-fan-out-engine-not-a-prompt-router).
The point is **not** to inspect the prompt and pick a response. It is to **classify the moment the hook
fired in** and then dispatch a team of cheap agents, each answering one small question, whose findings
aggregate into one injection. The main model should be thinking about code; *what* to build and *how* to
approach it is Middle-Management's job. Its charter — each item an independently-decided branch off the
categorized moment — is:

| Responsibility | How it is decided | Status |
| --- | --- | --- |
| **Delegate to a subagent?** | the ranker's `delegate_to` → `planDelegation` (suggest, or auto on a capable platform) | built |
| **Load a skill?** | toolbox `classifyRelevant` picks gated skills by name | built |
| **Is this a design breakpoint?** | the ranker's `breakpoint` flag gates the review team | built |
| **Instantiate MOLAR-EDIT** | one cheap reviewer per active tenet — the set is `molar_edit.active_tenets` | built |
| **What exactly to inject** | stage-1 candidates + retrieval package + file-read interception | built |
| **Pick the model & effort** | `selectModelEffort` by difficulty — effort is live; model escalation lands via ch. 06 | built |
| **Call an MCP on the side** | a deferred capability of the agent substrate (chapter 06) | designed |

Every branch is decided *independently* from the one classification, which is why the pipeline reads as a
sequence of small fail-open steps rather than one big decision.

## The `UserPromptSubmit` pipeline

One function orchestrates the whole opening: `handleUserPromptSubmit` (`router/handler.ts`). It runs as
a sequence of small, individually fail-open steps — each spawned sub-task's failure costs *context*,
never the recommendation or the turn.

**1 — Distill the line of thought.** `sessionReader.lineOfThought` reads *only the transcript bytes
appended since the last hook* (it tracks a byte offset per session), parses the new JSONL slice, and
makes **one** cheap-model pass that merges the slice into the prior `ThoughtState`. The consequence is
that per-turn cost stays *flat no matter how long the session runs* — and if there are no new bytes,
there is no model call at all.

**2 — Stage-1 heuristics (free, with a trivial early-exit).** `stageOne` first checks `isTrivialPrompt`
— "hi", "thanks", "what is 2+2", anything ≤2 words — and short-circuits at zero cost, so the handler
injects nothing. Otherwise it folds `prompt + thought.intent + thought.entities` into a query and calls
`graph.scoreFiles` to surface structurally-central candidate files the prompt never named. If the graph
isn't built yet, it degrades to a string-overlap fallback.

**3 — Stage-2 ranker (the one paid call).** `stageTwo` makes a single structured-JSON call through the
`router` provider, validated against `routerDecisionSchema`. This is where the moment is classified
(`type`, `complexity`, `breakpoint`, `dispatch_retrieval`, `delegate_to`, `effort`,
`context_files_to_preload`). A critical invariant: `context_files_to_preload` is filtered to the actual
stage-1 candidate set — **the ranker cannot invent a file reference.** On any failure, a
`defaultDecision` keeps the turn moving.

**4 — Dynamic model and effort selection.** `selectModelEffort` maps `trivial | medium | hard` to a
concrete `{ effort, model? }` via `config.effort.difficulty_to_model`. The **effort** is live: it threads
into retrieval, review, and the filter, where — per [chapter 02](02-abstractions.md) — it is spent as
*token budget*, not a vendor reasoning dial. A trivial moment runs the team at `minimal`, a medium one at
`medium`, a hard one at `high`, so the team spends in proportion to the difficulty it just classified. The
default hard tier additionally **names a stronger model** (`claude-opus-4`); that model escalation is
emitted and logged today and is *acted on* — spawned as a subagent running that model — through the agent
substrate ([chapter 06](06-intelligent-router.md)). Effort is money, spent where the difficulty warrants
it: an easy turn stays cheap, a hard one gets headroom.

**5 — Recall prior decisions.** `memory.recall({ kinds: ["decision", "approach"], limit: 5 })`,
best-effort, surfaces what was already decided so the model doesn't re-litigate it.

**6 — Cache the decision.** `writeLastDecision` persists the routing decision to disk so the
*separate processes* that run `PreToolUse` and `Stop` can read it (see "Cross-process state" below).

**7 — Retrieval team (conditional).** If the ranker set `dispatch_retrieval`, `dispatchRetrieval` pulls
retrieval cues from the session reader and runs the retrieval team, returning its block only if it found
references. This is the fan-out in miniature: a checklist of small, specific questions asked concurrently
against the three abstractions, then merged.

**8 — Design review at a breakpoint.** If the ranker flagged a `breakpoint` *and* review is enabled,
`dispatchReview` builds a design-context string and runs the review team over the *proposed approach* —
one cheap reviewer per active MOLAR-EDIT tenet, aggregating only the concerns. This is where the design
philosophy is *instantiated*: the tenets reviewed are exactly `molar_edit.active_tenets`, so a project
can add or silence a design lens from config without touching code.

**9 — Delegation and toolbox.** `planDelegation` turns a `delegate_to` into a suggestion (or, on a
capable platform in auto mode, a directive); `pickToolboxForPrompt` classifies which gated skills/agents
are relevant — *deciding whether a subagent should take this work and which skills it should carry.*

**10 — Inject.** `joinBlocks` wraps each non-null piece in its source-identifying tag —
`recommendation`, `retrieved-context`, `design-review`, `delegation`, `toolbox` — into one
`additionalContext` payload.

---

## The `PreToolUse` pipeline

`handlePreToolUse` (`filter/handler.ts`) branches by the tool being called.

### File reads → the context injector

For `Read`/`Glob`/`Grep`, `injectFileRead` decides *exactly what to inject* by intercepting the read and
assembling up to three pieces under a single `<middle-management file-context>` tag:

- **WARNINGS** — `memory.recall({ file, kinds: ["mistake", "rule"], limit: 3 })`: this file's past
  mistakes and rules, recalled at the exact moment the model is about to touch it.
- **PURPOSE** — `sessionReader.filePurpose`. If it returns `null`, the session doesn't justify the read,
  so the injector asks a clarifying question rather than slicing the file wrong.
- **SLICE** — guarded twice: if the moment is `exploration` it *never* slices (the model wants the whole
  file); otherwise a `relevancePass` reads the file, bounded by its graph neighborhood, and emits a
  focusing hint only when relevance confidence ≥ 0.5. The slice is delivered as a *hint*, never a
  replacement — a `PreToolUse` hook cannot substitute a `Read`'s result, so the worst case is that the
  full read proceeds untouched.

### Command tools → classification with teeth

For `Bash`/`Shell`/`PowerShell`/`pwsh`, `classifyToolCall` runs **deterministic policy lists** first: a
`deny` regex → deny, an `allow` regex → allow, otherwise `ask`. Only the leftover `ask` consults the LLM
`softClassify` (with a 6s timeout), which may upgrade the decision; any failure stays `ask`. The key
in-flight guardrail: **if no cheap model is loaded, the deny-list is disabled** — only deterministic
auto-allow stands, and everything else defers to the host's own permission prompt. A blind regex deny
with no model behind it is its own kind of harm.

### Write tools → a heavy-coding nudge

`Write`/`Edit`/`MultiEdit` have no permission teeth here, but `maybeRouteHeavyCoding` fires on a write
entering a medium/hard code phase: it recommends a subagent and relevant skills, *once per phase*
(rate-limited via a timestamp in the decision cache).

---

## The components, in brief

- **Session reader** (`session/reader.ts`) — the incremental transcript distiller. A byte-offset cache
  persisted per session means each hook reads only the *new* slice; one capped cheap pass merges it into
  the running `ThoughtState`. Three methods serve the rest of the cluster: `lineOfThought`, `filePurpose`,
  `retrievalCues`. Malformed model JSON falls back to the prior state.
- **Router** — two stages plus effort and delegation. Stage 1 (`heuristics.ts`) is free graph scoring
  with a trivial exit; stage 2 (`ranker.ts`) is the single paid classification; `effort.ts` maps
  difficulty to a model/effort; `delegation.ts` is a pure function gating *suggest* vs *auto* on
  `config.delegation.mode === "auto"` and whether the platform supports subagents.
- **Retrieval team** — plan → fan out → aggregate. `planChecklist` picks a per-moment-type template (or,
  with no match, makes one constrained selection from a fixed menu), capped at `max_checklist_items`; a
  planner outage falls back to a three-abstraction safety-net checklist. `fanOut` runs the items
  concurrently, capped at both a local limit and the process-global limiter. `handleItem` resolves
  exactly **one checklist item → one abstraction call → refs**, each bounded by a per-item timeout, so one
  dead backend degrades one item. `aggregate` dedupes by `source:ref` (keeping the highest confidence),
  ranks, and truncates to `package_token_budget` (always keeping at least one ref).
- **Filter** — deny/allow/ask classification and file-read interception, both fail-open (above).
- **Review team** (`review/team.ts`) — at a breakpoint, runs one reviewer per active MOLAR-EDIT tenet in
  parallel over a *proposed approach* (not finished code). The aggregator surfaces only concerns; a clean
  lens emits nothing; a failed reviewer becomes a neutral finding.
- **Toolbox gating** (`toolbox/`) — `gateToolbox` is pure file-work (no LLM): it rewrites each
  user/project/plugin skill's and agent's description in place to a gating line, backs up the original,
  and records the original "when to use" in a catalog. It re-runs every `SessionStart` so it self-heals
  after a `/plugin update`. `classifyRelevant` then picks the relevant ones *by name* from the catalog,
  dropping hallucinated or duplicate names.
- **Prompts resolution** (`prompts/resolve.ts`) — every cheap-model call site uses a tunable prompt
  resolved project-local → global → compiled-in built-in. A present-but-empty override counts as "not
  set"; placeholders are filled by `renderTemplate`, with unknown ones left intact on purpose so a deleted
  but still-needed placeholder is visible.

---

## Why it is shaped this way

- **A team, not a template.** The whole value proposition is that the *what* and *how* of a turn is
  worked out by a swarm of cheap, specific agents rather than the one expensive model — so the moment is
  decomposed into independent branches (delegate? skill? breakpoint? inject what?) and each is answered by
  the smallest possible call.
- **Two-stage routing — free heuristics before the paid ranker.** Stage 1 is pure graph/string work;
  only a non-trivial prompt reaches the single billed LLM call. Minimizing per-turn cost *is* the point of
  CorpoCode.
- **The ranker can't invent references.** Filtering `context_files_to_preload` to the stage-1 candidate
  set means a hallucinated path can never reach the model.
- **Retrieval fans out** because a checklist of small, specific questions asked *concurrently* makes
  total latency ≈ a single item rather than the sum — a research team asking its questions at once, not in
  turn — and each item is independently timeout-bounded.
- **Breakpoint-gated review.** Reviewing an *approach* before a dozen files are written against a flawed
  design is far cheaper than reviewing the finished code, so review is gated to genuine design moments.
- **Effort scales to difficulty.** Classifying the moment's difficulty and spending the team's token
  budget (and, when hard, a stronger model) in proportion is what keeps an easy turn nearly free while
  letting a hard one think.
- **Editable prompts with a guaranteed fallback** let a user tune any cheap-model call per-project or
  globally without touching code, while a compiled-in default means a missing or empty file never breaks a
  call.
- **Toolbox gating shrinks the model's context.** Stripping each skill's "when to use" stops the main
  model from auto-selecting on descriptive bloat; CorpoCode hands the *relevant* ones back by name.

---

## How it connects

Everything in this cluster touches the abstractions of [chapter 02](02-abstractions.md) through the
`HookContext`: `ctx.graph` (stage-1 scoring, the injector's neighborhood, the retrieval team's graph
queries), `ctx.context` (the retrieval team's `find`), and `ctx.memory` (router recall, the injector's
warnings, the retrieval team's `mem_recall`). A `RetrievedRef.source` is exactly `graph | context |
memory` — the three abstractions normalized for a single ranked merge. Output reaches the model only
through `additionalContext`, wrapped in the `TAGS` from `hooks/response.ts`. When the agent substrate of
[chapter 06](06-intelligent-router.md) is enabled, these same fan-outs upgrade from cheap *model calls* to
true *investigating agents* (and gain the deferred MCP-side-call branch) without changing the charter
above.

## Key types

```ts
interface ThoughtState { intent: string; approach?: string;
  openQuestions: string[]; recentDecisions: string[]; entities: string[]; }

const routerDecisionSchema = z.object({
  type: z.enum(["code-edit","code-gen","exploration","docs","config","other"]),
  complexity: difficultySchema,          // trivial | medium | hard
  breakpoint: z.boolean(),
  delegate_to: z.string().optional(),
  dispatch_retrieval: z.boolean(),
  effort: effortSchema,                  // minimal | medium | high
  context_files_to_preload: z.array(z.string()).default([]),  // subset of stage-1 candidates
});

type ChecklistItem =                     // the discriminated union that keeps "one item → one call" honest
  | { kind: "get_node"; symbol: string } | { kind: "get_neighbors"; nodeId: string; depth?: number }
  | { kind: "find_path"; from: string; to: string } | { kind: "query_graph"; query: string; budget: number }
  | { kind: "ov_find"; query: string; tier: Tier; limit: number }
  | { kind: "mem_recall"; query: string; kinds?: MemoryKind[]; limit: number };

type FilterDecision = "deny" | "allow" | "ask";
```

## Invariants a contributor must not break

- **Fail-open everywhere** — every provider/graph/memory/context/cache call degrades the result, not the
  turn. The `catch {}` blocks here are deliberate fail-open paths documented in the headers.
- **Cross-process state via files only.** `UserPromptSubmit`, `PreToolUse`, and `Stop` are *separate*
  processes; the decision cache and the session reader's offset are their only shared memory, and every
  read degrades to "unknown", never errors.
- **The deny-list only has teeth with a model loaded.**
- **`PreToolUse` never substitutes a `Read` result** — the slice is guidance only.
- **`filePurpose === null` asks rather than guesses; exploration is never sliced; a slice needs
  confidence ≥ 0.5.**
- **The ranker's preload list is a subset of stage-1 candidates** — and the *injected* file list comes
  from the candidates, not the preload field.
- **The review team reviews exactly `active_tenets`** — adding or silencing a design lens is config, not
  code.
- **Template precedence: built-ins override plugin templates**, so a plugin can *add* a moment type but
  never silently override a core one.
- **Toolbox gating skips CorpoCode's own plugin and is idempotent** via a frontmatter marker; the catalog
  holds the only copy of the original descriptions the classifier needs.

---

*Continue to [chapter 04 — Housekeeping](04-housekeeping.md).*
