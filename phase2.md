# CorpoCode — Phase 2 Implementation Specification

This document expands Phase 2 of the master specification into a complete, self-contained build plan, in the same style as the Phase 1 document: every deliverable is given with the files involved, the types, the behavior step by step, the failure modes to handle, and a clear statement of when the piece is finished. It assumes Phase 1 is built and working, and it frequently refers back to pieces Phase 1 put in place.

## What Phase 2 is, and how it changes the system

Phase 1 produced a system with senses but no hands. It read the transcript, understood the model's intent, scored the codebase, recalled prior decisions, and injected a single advisory recommendation — but it could not stop a command, could not reshape a file read, could not commit anything, and could not halt a turn. Its filter and verifier ran in a deliberately passive mode, thinking out loud into the log while leaving every real decision to the host. That restraint was the point: Phase 1 had to prove the plumbing and the provider layer were trustworthy before any component was given the power to act.

Phase 2 is the turning point where that power is granted, carefully and one component at a time. By the end of it, the filter can deny a dangerous command before it reaches the model or pre-approve a safe one so the user is never prompted; the verifier can halt an edit that violates the design philosophy; the retrieval team fans out across all three knowledge abstractions to assemble precise context instead of leaving the model to grep; the context injector intercepts a file read and hands back a focused slice with any relevant warnings attached; the design-review team weighs in on an approach at a breakpoint before the model commits to it; the compactor distills finished work into tiered, retrievable memory; and — the change that ties everything together — memory begins to be *written* as well as read, so that a mistake made today becomes a warning tomorrow. This is the phase in which CorpoCode stops being an observer and becomes a participant.

Two things stay true from Phase 1 and govern everything here. The first is the dependency floor: every component in this phase is built on Phase 1's providers, configuration, logging, session reader, categorizer, graphify adapter, native memory recall, and fail-open dispatcher. The second is the fail-open principle itself, and it matters more now than ever. Every new power introduced in this phase must still degrade to *inaction* on error, never to disruption. A retrieval worker whose backend dies returns less context, not a broken turn. A verifier whose check throws lets the edit through rather than crashing. A compactor whose daemon is gone falls back to a plain file rather than raising. Teeth are added, but the circuit breaker that fails open is never removed.

A word on what is still deferred, so the boundaries are clear. Phase 2 does not broaden installation beyond Claude Code, does not build the git two-branch model, does not generate documentation, does not generate skills or run the weekly `corpocode review`, and does not automatically route the developer's own work to a delegate subagent. Those belong to Phase 3 and beyond.

The sections below are ordered by dependency, as in Phase 1. First the substrate is completed — the OpenViking adapter that finishes the `ContextStore`, and the writing side of the memory store — because several later components read from and write to them. Then come the components that consume that substrate to *read*: the retrieval team and the context injector. Then the components that *act* on the host: the filter's teeth and the verifier's fan-out. Then the design-review team, then the compactor that writes finished work back into memory, and finally the honoring of the model and effort selection when CorpoCode spawns its own work. If you implement them in this order, nothing references a piece that does not yet exist.

## 1. Completing the ContextStore: the OpenViking adapter

The `ContextStore` interface was declared in Phase 1 but left without a working implementation, because nothing in Phase 1 needed tiered document retrieval. Phase 2 needs it in two places — the retrieval team reads from it and the compactor writes to it — so the first task is to implement the adapter behind it.

It helps to understand what the store is for. A `ContextStore` holds reference material at three levels of depth, which the interface calls tiers L0, L1, and L2. The best analogy is a good librarian: asked about a topic, the librarian can hand you a one-line note about what a document contains (L0, the abstract), a fuller summary (L1), or the complete text (L2), and which one you want depends on how deep you actually need to go. This tiering is what lets CorpoCode pull in just enough context to be useful without flooding the model with whole files it does not need. The interface, declared in Phase 1 and now implemented, is the following:

```typescript
export type Tier = "L0" | "L1" | "L2";                 // abstract → summary → full text
export type ResourceKind = "memory" | "resource" | "skill";
export interface Resource { uri: string; kind: ResourceKind; tier: Tier; content: string; tokens: number; score?: number; children?: string[]; }
export interface TreeEntry { uri: string; kind: ResourceKind | "directory"; abstract?: string; childCount?: number; }
export interface FindResult { query: string; tier: Tier; resources: Resource[]; trajectory?: string[]; }

export interface ContextStore {
  readonly id: string;                                                                  // "openviking"
  find(query: string, opts: { tier: Tier; limit: number; root?: string }): Promise<FindResult>;
  load(uri: string, tier: Tier): Promise<string>;
  write(uri: string, content: string, opts?: { kind?: ResourceKind }): Promise<void>;
  tree(uri: string, opts?: { depth?: number }): Promise<TreeEntry[]>;
  grep(pattern: string, opts?: { root?: string }): Promise<Resource[]>;
  start(): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
}
```

The adapter, in `src/backends/context/openviking-adapter.ts`, is an HTTP client that talks to the OpenViking daemon on `localhost:1933`. The method mapping is direct: `find` issues the daemon's find endpoint with the requested tier and limit and records the retrieval trajectory it took; `load` fetches a specific URI at a specific tier; `write` stores content, which is how the compactor lands a digest under `viking://agent/memories/...`; `tree` lists a subtree, drawing each entry's abstract from its L0 representation; and `grep` runs a literal search. The `health` and `ping` calls map to the daemon's status endpoint.

One detail is worth singling out because it makes the user's life simpler. The daemon's own configuration file, `ov.conf`, is generated from CorpoCode's provider configuration at install or `--repair` time, not maintained separately. OpenViking needs an embedding model and a vision-language model to do its tiering, and rather than asking the user to configure those a second time, CorpoCode translates its own provider key and model into OpenViking's configuration format. The user authenticates once, and the store inherits the same credentials.

The resilience behavior here is specific and you should implement it exactly. A daemon can be down momentarily — restarting, or not yet started after a reboot — so when the adapter gets a connection-refused error, it makes exactly one attempt to start the daemon (the error kind is `daemon_restart`, which the shared retry policy treats as retryable) and then retries the call once. If it still fails, it raises a normalized error rather than hanging or retrying forever. This single-restart pattern is what lets the compactor and the retrieval team treat a briefly-absent daemon as a transient hiccup without turning every call into an unbounded retry loop.

This section is done when `find`, `load`, `tree`, and `write` round-trip correctly against a running daemon at all three tiers, when `health` and `ping` reflect whether the daemon is actually up, and when a refused connection triggers exactly one restart attempt followed by either success or a clean error.

## 2. Completing the MemoryStore: capture, consolidation, supersession, and outcomes

In Phase 1 the memory store could be read but barely written: `recall` was fully implemented because the categorizer needed it, `capture` was a simple append, and `consolidate` and `recordOutcome` were present only as minimal stubs. Phase 2 implements the writing side in full, and in doing so it closes the loop that makes CorpoCode able to learn across sessions rather than starting fresh each time. This is conceptually the most important change in the phase: a system that only reads memory can be helpful, but a system that writes memory can get better.

`capture` is finalized first. It appends a new typed memory and generates its embedding on write, through the configured provider, so that the new memory is immediately findable by a later semantic `recall`. The four kinds of memory — decisions, mistakes, rules, and approaches — each carry their text, an optional set of file anchors, and a timestamp.

`consolidate` is the centerpiece, and it runs at the end of a session (the `Stop` hook, driven by the compactor). Its job is to read the transcript and mine it for memories worth keeping, and then — the subtle part — to reconcile them against what is already stored. When a newly mined memory *reverses* an existing one (the model decided to use a different approach than it settled on earlier, say), `consolidate` does not delete the old memory; it sets the old memory's `supersededBy` pointer to the new one. The reasoning is that history has value: you want the current decision to win at recall time, but you also want to be able to see that a decision was once made the other way and why it changed. The effect is like a changelog in which superseded entries are struck through but still legible, rather than erased.

```typescript
// src/backends/memory/native.ts — the supersession step inside consolidate (sketch)
async function consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult> {
  const mined = await mineTypedMemories(transcript); // a cheap-model pass: decisions/mistakes/rules/approaches
  let captured = 0, superseded = 0;
  for (const m of mined) {
    // If this new memory contradicts an existing live one, retire the old by pointer, not by deletion,
    // so recall returns the current truth while the prior decision stays auditable.
    const conflict = await findLiveConflict(m, scope);
    if (conflict) { conflict.supersededBy = m.id; superseded++; }
    await capture(m);                                 // embeds on write so it is immediately recallable
    captured++;
  }
  return { captured, superseded };
}
```

The decay model deserves a clear statement because it encodes a judgment about which lessons age and which do not. Mistakes and rules never expire: a bug that bit you once can bite you again no matter how much time passes, and a rule is a rule until it is explicitly superseded. Decisions and approaches, by contrast, decay by recency, because an old decision may simply have been overtaken by the way the project actually evolved. The `recall` scoring you built in Phase 1 therefore blends three factors — semantic similarity to the query, recency (with the decay applied only to the kinds that decay), and an outcome weight — and excludes any memory that already carries a `supersededBy` pointer.

That outcome weight is supplied by `recordOutcome`, the last method to finish. When CorpoCode recalls a set of memories and surfaces them, and the work that follows turns out well (the verifier comes back clean), `recordOutcome` strengthens those memories; when it turns out badly, it weakens them. This is a genuine feedback loop: advice that proves good rises in future recalls, and advice that proves misleading sinks. Over time the store curates itself.

This section is done when a captured memory is immediately ranked by a relevant recall; when `consolidate` run over a transcript that reverses an earlier decision sets the old memory's `supersededBy` pointer and the old memory drops out of recall while the new one appears; when a mistake survives the passage of time while a stale decision is correctly down-ranked; when `recordOutcome` demonstrably shifts ranking; when a fresh session can recall decisions made in a prior one; when a corrupt store still yields an empty recall rather than throwing; and when embeddings are produced through the configured provider.

## 3. The retrieval team: checklist fan-out across all three abstractions

This is the largest single component in the phase, and it is where all three knowledge abstractions finally converge. Recall that in Phase 1 the categorizer already decided whether retrieval was warranted and set a `dispatch_retrieval` flag, but nothing consumed it. Phase 2 builds the worker that runs when that flag is set, in `src/retrieval/`.

The governing idea is checklist decomposition, and it is worth dwelling on because it is what makes retrieval both precise and fast. The naive approach to retrieval is a single, vague call — "find everything relevant to this prompt" — which tends to return a shallow, unfocused grab-bag. The checklist approach instead breaks the need into several small, specific items, runs them in parallel, and aggregates the results. The analogy is a research team: you get far better results by giving each member one precise question than by telling one person to "go find everything," and because they work simultaneously, the whole job takes about as long as the slowest single question rather than the sum of all of them.

The planner, in `planner.ts`, builds that checklist. It selects a template by the moment's type — the categorizer's classification of code-edit, code-gen, exploration, docs, or config maps to a template file under `templates/` — and each template encodes the checklist that kind of task usually needs. Crucially, the planner folds the session reader's `retrievalCues` into each item's query, so that retrieval reasons from the model's actual line of thought rather than from the bare prompt. If no template matches the moment, the planner makes a single constrained selection call, choosing items from a fixed menu of kinds rather than inventing them freely, which keeps even the fallback path predictable.

The fan-out, in `fanout.ts`, runs the checklist items concurrently with `Promise.all`, capped at `max_parallel_instances`, each item bounded by `per_item_timeout_ms`, and each issued as a fresh provider call. This is the parallelism that makes the team's total latency approximate a single item's latency.

The item handler, in `item-handler.ts`, is the convergence point: it maps each item kind to exactly one abstraction call. Items asking about code structure — get a node, get its neighbors, find a path between two symbols, query the graph — go to the `KnowledgeGraph`. Items asking for reference material go to `ContextStore.find` and `load`, escalating through the tiers as needed. Items asking what was learned or decided go to `MemoryStore.recall`. A single retrieval pass can therefore touch all three at once, each answering the kind of question it is best suited to.

```typescript
// src/retrieval/item-handler.ts — one checklist item resolves to exactly one abstraction call
async function handleItem(item: ChecklistItem, ctx: Backends): Promise<ItemResult> {
  switch (item.kind) {
    case "get_node":      return wrap(item, ctx.graph.getNode(item.symbol));
    case "get_neighbors": return wrap(item, ctx.graph.getNeighbors(item.nodeId, { depth: item.depth }));
    case "find_path":     return wrap(item, ctx.graph.findPath(item.from, item.to));
    case "query_graph":   return wrap(item, ctx.graph.query(item.query, { budget: item.budget }));
    case "ov_find":       return wrap(item, ctx.context.find(item.query, { tier: item.tier, limit: item.limit }));
    case "mem_recall":    return wrap(item, ctx.memory.recall({ query: item.query, kinds: item.kinds, scope: ctx.scope, limit: item.limit }));
  }
}
// wrap() applies the per-item timeout and converts any failure into a result marked timed_out/failed,
// so that one dead backend degrades that single item rather than the whole package.
```

The aggregator, in `aggregator.ts`, merges the item results deterministically: it deduplicates file references, ranks results by the product of each item's confidence and priority, and truncates the whole package to `package_token_budget` so the injected context can never balloon. An optional coherence pass runs only if `coherence_pass` is set in the configuration. The final package is injected into the model's context wrapped in a `<middle-management retrieved-context>` tag, the companion to the `<middle-management recommendation>` tag from Phase 1.

The resilience story is the fail-open principle applied at the granularity of a single item. If one item's backend dies mid-run — graphify is killed, say — that item simply times out and is dropped from the package, the other items succeed, and the package still returns. The model gets slightly less context, never a broken turn.

This section is done when a medium-complexity prompt produces one retrieval summary log line plus one `retrieval_item` line per checklist item; when on the happy path the number of succeeded items equals the number of checklist items; when the team's total latency approximates a single item's rather than the sum; when killing graphify mid-run drops only the affected item while the rest succeed and the package still returns; and when the injected retrieved-context stays within `package_token_budget`.

## 4. The context injector: intercepting file reads

The context injector runs on the `PreToolUse` hook, specifically when the tool is a file read — a `Read`, `Glob`, or `Grep`. Its premise is that when the model opens a file it rarely needs the whole thing; it needs the part relevant to what it is currently doing. The injector's job is to intercept that read and hand back a focused slice, with any relevant warnings attached, rather than letting the full, noisy file pour into the context. It lives in `src/filter/inject.ts`.

The injector assembles its response from three inputs, each drawn from a piece already built. The first is *purpose*: it asks the session reader, via `filePurpose`, why this file is being read in light of the current line of thought. If the reader cannot determine the purpose and returns null, the injector does not guess — it emits a brief clarifying question instead, on the principle that asking is far safer than slicing the file wrongly and hiding the part the model actually needed. The second is the *slice* itself: a relevance pass bounded by the `KnowledgeGraph` neighborhood of the file, scoped to the determined purpose, which keeps the slice anchored to what is structurally connected to the work rather than to a naive keyword match. The third is *warnings*: a `memory.recall` filtered to this file and to the mistake and rule kinds, which surfaces any hard-won lesson about this file right before the model edits it. If a function in this file caused a regression last week, the model should be reminded now, not after it repeats the mistake.

Two guardrails keep the injector from ever doing harm. The categorizer's classification decides whether interception even applies: a targeted edit gets a focused slice, but an exploration — where the model genuinely is trying to understand the whole file — gets the whole file, because slicing would defeat the purpose. And even when interception applies, if the relevance pass comes back low-confidence, the injector injects nothing and lets the full read proceed. The injector must never make the model blind to something it needs; when in doubt, it degrades to the ordinary full read.

This section is done when an obvious file purpose is correctly carried onto the slice; when an unknown purpose produces a clarifying question rather than a guess; when a file with a recorded past mistake surfaces that warning before the edit; and when a low-confidence relevance pass falls back cleanly to the full read.

## 5. Giving the filter teeth: deny, allow, and ask

In Phase 1 the filter's classifier produced advice and wrote it to the log, but set no permission decision, so every tool call proceeded exactly as it would without CorpoCode. Phase 2 lets that classifier act. This is the first component that can stop the host from doing something, so its design is deliberately conservative.

The decision logic, in `src/filter/classify.ts`, draws on three lists held in `src/filter/policies.ts`. The deny-list names operations that should be stopped before they ever reach the model — destructive commands like `rm -rf ~`, writes into system locations like `/etc`, and the like — and it is explicit and narrow rather than clever, because a false denial is its own kind of harm. The always-allow list names operations that are genuinely safe — read-only commands, common test runners — and pre-approving them spares the user a needless permission prompt. Everything that falls into neither list is the soft case, where the classifier makes a judgment and returns `deny`, `allow`, or `ask`. When the classifier is uncertain, the correct default is `ask`: the human decides. The dispatcher takes the returned decision and sets `hookSpecificOutput.permissionDecision` accordingly.

The way to think about the three outcomes is as a spectrum of confidence. `Deny` and the deny-list are for things you are confident are wrong; `allow` and the always-allow list are for things you are confident are safe; and `ask` is the honest middle, the place where CorpoCode declines to substitute its judgment for the user's. Erring toward `ask` is always the safe default, and the deny-list should grow only with care.

This section is done when an auto-deny stops a destructive command before the model can act on it; when an auto-allow suppresses the permission prompt for a clearly safe command; and when an uncertain command is routed to `ask` so the user decides.

## 6. The MOLAR-EDIT verifier fan-out

Phase 1 ran a single check after an edit and only logged what it found. Phase 2 turns the verifier into the full design-philosophy gate: after a file write, on the `PostToolUse` hook, it runs one family of checks per active design tenet, in parallel, and it can halt an edit that fails badly enough. The verifier lives in `src/verifier/`.

The design philosophy it enforces is MOLAR-EDIT, a set of nine tenets, each a single lens on code quality. Maintainability asks whether a change is isolated to the files it needs and free of dead or commented-out code. Observability asks whether critical paths emit metrics and propagate trace identifiers. Logging asks whether errors are logged once with context and whether secrets stay out of the logs. Atomicity asks whether each unit does one thing nameable in a few words. Responsiveness asks the user-facing questions — small-viewport behavior, keyboard completeness, labels and alternative text — and applies only to UI files, which is why its strictness defaults to off for non-UI code. Extensibility asks whether new code sits behind an abstraction that can be swapped. Documentation asks whether decisions are recorded and why-comments are present. In-flight asks whether external calls have timeouts, retries, and graceful degradation. And Testing asks whether a bug fix came with a regression test and whether failure paths are exercised. Which tenets are active, and at what strictness, comes from the `molar_edit` block of the configuration.

The worker, in `worker.ts`, runs the checks for each active tenet whose `appliesTo(file)` predicate is true, in parallel, each as a fresh provider call bounded by a per-check timeout of eight seconds. It is built directly on the `runChecks(checks: TenetCheck[])` signature you were careful to establish in Phase 1, so the change from one check to nine families is purely additive — you are filling in the tenet modules under `tenets/`, not rewriting the worker.

The aggregator, in `aggregator.ts`, collects the findings and decides the consequence. A finding carries a severity of info, warn, or block, and the rule is that a single high-confidence `block` halts the edit by returning `continue: false` with a stop reason, while warns and infos are surfaced to the model but do not stop it. On any failure the verifier also calls `memory.capture` with a mistake anchored to the file, and `memory.recall` to recognize whether this is a repeat of something seen before. This is the concrete mechanism by which a violation today becomes a warning tomorrow — the verifier writes the mistake, and the context injector later reads it back before the next edit to that file.

```typescript
// src/verifier/worker.ts — fan-out over active tenets; one failing check must not sink the rest
async function verify(files: string[], engine: MolarEditEngine, mem: MemoryStore): Promise<TenetFinding[]> {
  const checks = engine.activeTenets()
    .flatMap(t => checksFor(t))
    .filter(c => files.some(f => c.appliesTo({ path: f })));   // only run checks that apply to the changed files
  // allSettled, not all: a thrown check is isolated to its own slot and the other lenses still report.
  const settled = await Promise.allSettled(checks.map(c => runCheck(c, files)));
  const findings = settled.flatMap(s => s.status === "fulfilled" ? [s.value] : []);
  for (const f of findings) {
    if (!f.ok) await mem.capture({ kind: "mistake", text: f.message, files, sessionId: currentSession });
  }
  return findings;
}
```

The resilience requirement is explicit in that code and you should not weaken it: the fan-out uses `Promise.allSettled` rather than `Promise.all`, so that one check throwing is isolated to its own result and the other tenets still report. And because the active set is read from configuration, removing a tenet from `active_tenets` simply stops its checks from running. The verifier emits one summary log line plus one `verifier_check` line per check.

This section is done when an edit that violates two tenets produces one verifier summary plus one `verifier_check` per tenet, run in parallel so the summary's latency approximates the slowest check rather than the sum, with both violations surfaced; when a single broken check does not stop the others; when a high-confidence block halts the edit; when removing a tenet from the active set stops its check; and when a violation is captured to memory.

## 7. The design-review team

The verifier checks code after it is written. The design-review team does the complementary thing: it weighs in on an *approach* before the model commits to it, at the moments the categorizer flagged as breakpoints. Catching a design problem at the breakpoint is far cheaper than catching it after a dozen files have been written against the flawed design. The team lives in `src/review/`.

It runs on the `UserPromptSubmit` hook when the categorizer's `breakpoint` flag is set. The mechanism mirrors the verifier's fan-out, but applied to a design context rather than to changed files: `MolarEditEngine.review(designContext)` spawns one reviewer per active tenet, in parallel, each bringing its single lens to the proposed approach, and the aggregated feedback is injected into the model's context before it proceeds. The analogy is a design-review meeting where each reviewer is responsible for one concern — one person watches maintainability, another watches testability, another watches extensibility — so that no single lens is forgotten and the review is fast because the reviewers work at once.

This section is done when a breakpoint prompt produces one `review_check` log line per active tenet, run in parallel, with the aggregated feedback injected before the model writes anything; and when narrowing the active tenet set causes only those lenses to fire.

## 8. The transcript compactor with sliding-window enforcement

The compactor runs on the `Stop` hook, in the background after the model has finished, and it has two jobs that pull in the same direction: keep the working context lean, and preserve what the session learned. It lives in `src/compactor/`.

The first job is governed by the sliding window, computed in `sliding-window.ts`. The window defines what stays verbatim — the most recent turns and tool outputs, sized by `preserved_turns` and `preserved_tool_outputs` — and everything outside it is the compactable region. The single inviolable rule here is that the preserved turns are *never* compacted; the model always keeps its recent context in full, and compaction only ever touches the older material that has aged out of the window.

The second job is where the compactor and the `ContextStore` meet. The compactable region is distilled into a digest and written, through `openviking.ts`, to `viking://agent/memories/<session>/<turn>.md`, where OpenViking tiers it into an L0 abstract, an L1 summary, and the L2 full digest. This is the hierarchical-compaction idea in practice: finished work does not simply vanish from the context, it becomes hierarchical, retrievable memory that a later retrieval pass can pull back in at whatever depth it needs. In the same step the compactor calls `memory.consolidate` to mine typed memories from the transcript and `recordOutcome` to update the weights of whatever was recalled during the session — which is the call site that finally exercises the consolidation and supersession logic built in section 2.

The defensive fallback lives in `memdir.ts`. If OpenViking is unavailable, the compactor writes the digest to a plain memory directory instead, so that the learning is never lost even when the daemon is down. The `compaction.backend` setting chooses which is primary — OpenViking by default, or the plain directory for users who prefer it. The interaction with the adapter's restart logic from section 1 is the complete resilience story: a momentarily-refused daemon triggers exactly one restart attempt, and if that still fails the compactor falls back to the directory rather than raising. A compaction failure must never surface as a session error.

This section is done when the compactor runs successfully on both backends and produces valid summaries; when the preserved turns are demonstrably never compacted; and when killing the daemon mid-compaction triggers one restart attempt followed by a clean fallback, with no error reaching the session.

## 9. Honoring the dynamic model and effort selection on spawn

The last piece of Phase 2 activates something Phase 1 computed but deliberately left inert. In Phase 1 the categorizer ran `selectModelEffort`, which maps a moment's classified difficulty to a model and an effort level, and it emitted and logged that choice — but nothing acted on it. Phase 2 honors it.

The honoring happens in two ways. When CorpoCode spawns its own units of work in this phase — the parallel retrieval workers, the design-review reviewers, the verifier checks — the chosen effort level shapes how they run, influencing the token budget, the reasoning effort for providers that expose such a control, or the model variant used. A moment classified as hard causes CorpoCode to spend a little more on its own helpers because the stakes justify it; a trivial moment causes it to spend the minimum. And the recommendation that reaches the main model now carries the model-and-effort guidance as actionable advice rather than as a logged afterthought, so the model itself is told plainly when a moment warrants a stronger model at higher effort or a downshift to something cheaper.

It is worth drawing the line to Phase 3 clearly, because the two are easy to conflate. Phase 2 honors the effort and model selection for the work CorpoCode itself spawns, and surfaces the guidance. Automatically routing the *developer's own task* to a specialized delegate subagent — acting on the categorizer's `delegate_to` field — is a Phase 3 deliverable. Phase 2 makes the selection consequential for CorpoCode's internal work; Phase 3 makes delegation of the main work automatic.

This section is done when a moment classified as hard causes CorpoCode to spawn its workers at the higher effort and to surface the stronger-model guidance, and when a trivial moment causes it to spawn at minimal effort.

## Definition of done for Phase 2

Phase 2 is complete when all of the following hold, which together form the acceptance criteria for the phase.

The OpenViking adapter completes the `ContextStore`: find, load, tree, and write round-trip at all three tiers against a live daemon, health and ping reflect the daemon's real state, and a refused connection triggers exactly one restart attempt before either succeeding or erroring cleanly. The memory store's writing side is finished: a captured memory is immediately recallable, consolidation over a reversing transcript sets the prior memory's supersession pointer and removes it from recall while the new one appears, mistakes survive decay while stale decisions are down-ranked, recorded outcomes shift future ranking, a fresh session recalls prior decisions, a corrupt store yields an empty recall without throwing, and embeddings are produced through the configured provider. The retrieval team fans out across all three abstractions: a medium prompt yields a retrieval summary and one item line per checklist item, succeeded items equal checklist items on the happy path, total latency approximates a single item's, killing a backend mid-run drops only the affected item while the package still returns, and the injected context stays within budget. The context injector intercepts file reads: an obvious purpose rides onto the slice, an unknown purpose yields a clarifying question, a file with a recorded mistake surfaces that warning before the edit, and a low-confidence relevance pass falls back to the full read. The filter has teeth: a destructive command is denied before the model acts, a safe command is auto-allowed without a prompt, and an uncertain command routes to ask. The verifier fans out over the active tenets: an edit violating two tenets produces a summary and one check line per tenet run in parallel with both surfaced, a broken check does not sink the others, a high-confidence block halts the edit, removing a tenet stops its check, and a violation is written to memory. The design-review team weighs in at breakpoints with one review line per active tenet, run in parallel, injected before any write, and narrowing the active set fires only those lenses. The compactor runs on both backends, never compacts the preserved window, and falls back cleanly when the daemon is killed rather than raising. And the model-and-effort selection is honored for the work CorpoCode spawns while its guidance reaches the main model.

When all of that holds, CorpoCode is no longer an observer. It assembles precise context from three kinds of knowledge, reshapes file reads into focused slices, stops dangerous commands and halts design-violating edits, reviews approaches before they are committed, and — most importantly — writes down what it learns so that each session makes the next one better. Phase 3 builds outward and upward from here: it broadens installation to the other coding-agent platforms, and it adds the craftsmanship layer — the two-branch git model that turns the raw stream of edits into a clean, coherent history, the documentation generator that documents finished code, the skill generator and the weekly `corpocode review` that turn accumulated memory into reusable skills and configuration improvements, and the automatic routing of the developer's work to the delegate subagents the categorizer has been identifying all along.
