# CorpoCode — Phase 3 Implementation Specification

This document expands Phase 3 of the master specification into a complete, self-contained build plan, in the same style as the Phase 1 and Phase 2 documents. It assumes Phases 1 and 2 are built and working, and it refers back to their pieces throughout.

## What Phase 3 is, and how it changes the system

It helps to recall the arc so far. Phase 1 gave CorpoCode senses: it could read the transcript, understand intent, score the codebase, recall prior decisions, and inject one advisory recommendation, but it could not act. Phase 2 gave it hands and a memory: it could deny a command, halt a design-violating edit, assemble precise context from three kinds of knowledge, reshape a file read, and — the change that mattered most — write down what it learned so each session improved the next. Phase 3 gives it *reach* and *craftsmanship*.

Those two words name the two themes of this phase. Reach means CorpoCode stops being a Claude Code tool and runs across the other coding-agent platforms — Codex, opencode, Cursor, and the Gemini CLI — through a single, thin platform-adapter layer. Craftsmanship means CorpoCode stops producing only in-the-moment help and begins producing durable artifacts that outlive the session: a clean, readable git history distilled from the raw torrent of edits; documentation generated from the finished code and the knowledge graph; reusable skills mined from accumulated memory; and proposed improvements to its own configuration drawn from watching its own behavior. And in the same phase it begins dispatching the developer's own work to specialists, acting at last on the delegation hints the categorizer has been emitting since Phase 1. By the end, CorpoCode is not merely helpful within a session; it leaves the codebase, its history, its documentation, and even its own behavior better than it found them.

Two threads from the earlier phases continue and one widens. The dependency floor still holds: this phase builds on Phase 1's session reader, categorizer (including the `delegate_to` field it has always produced), Claude Code installer, and the helper subagent it installed, and on Phase 2's verifier (whose clean result is one of the signals that a section of work is finished), memory writes (which the skill generator mines), and the compactor's `Stop`-hook timing (which the documentation generator and git promotion share). The fail-open principle still holds, too. But it widens here into a broader idea worth stating plainly, because Phase 3's features are powerful and persistent: *the user stays in control of consequential, durable changes.* Git defaults to suggesting promotions rather than performing them; the review loop proposes configuration changes as a pull request rather than editing its own settings; promoting a candidate into a real skill is a deliberate manual step; and delegating the developer's work defaults to a recommendation rather than an automatic hand-off. CorpoCode proposes; the human disposes. The circuit breaker that fails open is now joined by a governor that keeps lasting changes under human approval.

What remains deferred is the work of turning a capable tool into a public product, which is Phase 4: the npm release going live, opt-in telemetry, the plugin API that lets others extend the templates and tenets, a performance pass, and a documentation site. And Phase 5 still waits beyond that, to replace the Python-backed graph and context backends with native implementations.

The sections below run in dependency order. Multi-platform installation comes first, because it broadens the ground every other feature runs on. Then the git two-branch model, the documentation generator, and the skill generator with the review loop — the craftsmanship layer, ordered from during-the-work to after-the-work to across-many-sessions. Auto-delegation comes last, as the capstone that changes how the developer's work is dispatched.

## 1. Multi-platform installation

Phase 1's installer handled only Claude Code, and the temptation now is to imagine that supporting four more platforms means writing four more large installers. It does not, and understanding why is the key to this section. Almost everything CorpoCode does is platform-agnostic and lives behind a single entry point, `corpocode hook <name>`. The session reader, the categorizer, the retrieval team, the verifier, the compactor — none of them know or care which coding agent fired the hook. The only genuinely platform-specific work is the *installation and registration* layer: where the hook shims go, how they are registered, what shape the response envelope takes, and which hook events the platform can fire at all. Phase 3 therefore introduces one small abstraction, the platform adapter, and leaves every hook handler untouched.

The adapter lives in `src/install/` with one implementation per platform, behind a common interface:

```typescript
export type PlatformId = "claude-code" | "codex" | "opencode" | "cursor" | "gemini-cli";
export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SubagentStart";

export interface PlatformAdapter {
  readonly id: PlatformId;
  detect(): Promise<boolean>;                       // is this platform installed on the machine?
  hookEvents(): HookEvent[];                         // the subset of our events this platform can actually fire
  shimDir(): string;                                 // where this platform expects hook scripts to live
  registerHooks(events: HookEvent[]): Promise<void>; // edit the platform's settings to call our shims (parse/modify/write, never text-edit)
  unregisterHooks(): Promise<void>;
  responseEnvelope(out: HookOutput): string;         // wrap our output in the platform's expected stdout shape
  installAssets(): Promise<void>;                    // subagent/skill definitions, where the platform supports them
}
```

The platforms differ along exactly the axes this interface exposes, and it is worth naming them so the implementer knows what to look for. They differ in *which hook events exist* — a platform may have no equivalent of `PreToolUse`, or no `Stop` event — which determines which CorpoCode components can run there. They differ in the *location and format of the settings file* where hooks are registered, which is why `registerHooks` parses and rewrites structured settings rather than editing text, so it cannot corrupt unrelated configuration. They differ in the *field name and shape of the response envelope* through which injected context is delivered, which `responseEnvelope` absorbs. And they differ in *whether they support subagents or skills at all*, which `installAssets` accounts for.

The behavior that makes this robust is graceful degradation. If a platform cannot fire a hook event that some component relies on, CorpoCode does not refuse to install; it installs the subset the platform supports and simply does not run the components that need the missing event. A platform without a `PreToolUse` equivalent gets everything except the context injector and the filter's teeth, and that is a coherent, useful install rather than a failure. The mental image is a single engine fitted to several different chassis with platform-specific mounting brackets: the engine — the hook logic — is identical, and only the brackets change.

One honesty note belongs in the spec rather than buried in the code. The precise hook-event names, settings-file paths, and envelope formats for Codex, opencode, Cursor, and the Gemini CLI must be confirmed against each platform's current hook documentation at implementation time, because these integration surfaces evolve independently of CorpoCode. The platform adapter is deliberately the one stable seam that absorbs whatever those specifics turn out to be, so that confirming them is an exercise in filling in five small adapter implementations rather than in changing anything central. The `install` command's flags from Phase 1 — `--platform`, `--all`, `--dry-run`, `--skip-backends`, `--repair` — carry over unchanged, with `--all` now iterating over every platform `detect` finds.

This section is done when `install` on at least three platforms beyond Claude Code each produces correct shims and a correct registration, when a reference prompt yields the expected injected-context envelope on each of those platforms, and when a platform that lacks one of CorpoCode's hook events installs the supported subset cleanly rather than erroring.

## 2. The git two-branch model

A coding agent produces a torrent of small edits, and that torrent creates a genuine dilemma for version control. If you commit once per edit, you get a history that is perfect for safety — every single change is atomic, so any step can be reverted in isolation and a regression can be bisected to the exact edit that caused it — but that history is unreadable as a story, a wall of hundreds of tiny commits no human would page through. If instead you hand-curate the history into a handful of meaningful commits, it reads beautifully but you have thrown away the granular safety. CorpoCode refuses the dilemma and keeps both, on two branches, which is the heart of this section. It lives in `src/git/`.

The first branch is the trace branch, named `corpocode/trace` by configuration, and the right way to think about it is as an aircraft's flight recorder. On the `PostToolUse` hook, after the verifier has run, every file write becomes one atomic commit on this branch — complete, revertable, and bisectable. Because the trace branch is entirely isolated from the branch the user actually works on, recording to it carries no risk to the user's work, which is what makes it safe to do automatically.

The second branch is the clean branch, `corpocode/clean`, and it is the curated narrative a human reviewer would actually read. When a major section of work is finished, the trace commits that make it up are squashed into a single coherent commit and promoted onto the clean branch. The interface that manages both, declared in the master spec and implemented here, is:

```typescript
export type GitMode = "suggest" | "auto";
export type PromoteSignal = "verifier_clean" | "unit_boundary" | "tests_passed";
export interface CommitSet { files: string[]; message: string; rationale: string; }
export interface BranchPair { trace: string; clean: string; }

export interface GitManager {
  ensureBranches(name: string): Promise<BranchPair>;
  commitWrite(file: string, opts: { sessionId: string; mode: GitMode }): Promise<void>;   // one atomic commit on TRACE
  planPromotion(repoRoot: string, since: string): Promise<CommitSet[]>;                    // group a trace range into logical sets
  promote(sets: CommitSet[], mode: GitMode): Promise<void>;                                // squash sets onto CLEAN
  conflicts(repoRoot: string): Promise<string[]>;                                          // surface conflicts only; never resolve destructively
}
```

The interesting question is how CorpoCode knows a section is "finished," and the answer reuses machinery from the earlier phases rather than inventing a heuristic. The `promote_on` configuration lists the signals that together mean done: a `unit_boundary` detected by the Phase 1 session reader (the model has visibly moved from one coherent unit of work to the next), a `verifier_clean` result from the Phase 2 verifier (the work passed its design checks), and `tests_passed`. When the configured combination of signals is satisfied at the `Stop` hook, promotion runs. The grouping itself, in `planPromotion`, follows the same checklist-decomposition pattern used elsewhere in the system: one cheap pass per changed file sorts it into a logical bucket, the buckets are aggregated deterministically into commit sets, and each set's message is generated from the section's diff together with the line of thought the session reader distilled, so the commit message describes not just what changed but why.

```typescript
// src/git/promote.ts — grouping a trace range into coherent commit sets (sketch)
async function planPromotion(repoRoot: string, since: string): Promise<CommitSet[]> {
  const changed = await filesChangedSince(repoRoot, since);
  // One classification pass per file → a logical bucket (e.g. "auth", "logging"), then a deterministic merge.
  // This is the same checklist-decomposition shape the retrieval team uses: many small calls, one stable aggregate.
  const buckets = await groupByConcern(changed);
  return buckets.map(b => ({
    files: b.files,
    message: synthesizeMessage(b, thoughtStateFor(b)),  // diff + line of thought → a message that explains the why
    rationale: b.reason,
  }));
}
```

The modes and the control they give the user deserve a precise statement, because this is the most consequential feature in the phase. Two settings govern behavior. The boolean `commit_per_write` controls whether the trace recorder runs: when it is on, each write produces an atomic trace commit, and because the trace branch never touches the user's working branch, this is safe to do automatically. The `mode` setting, either `suggest` or `auto`, governs promotion and anything that touches a branch the user works with: in `suggest` mode CorpoCode computes the commit sets, writes their messages, and surfaces the plan for the user to apply, while in `auto` mode it performs the promotion itself. A user who wants no automatic git activity at all sets `commit_per_write` to false, and one who wants the git manager entirely out of the way sets `enabled` to false. In every mode, without exception, the destructive operations are out of scope: CorpoCode never force-pushes, never rewrites history, and never performs a hard reset. The `conflicts` method only surfaces conflicts for a human to resolve; it never resolves them by discarding work.

This section is done when three writes produce three atomic single-file trace commits and the middle one reverts cleanly on its own; when a finished section spanning two concerns, with the promote signal satisfied, produces two coherent commits on the clean branch while the trace branch retains the full granular history; when `suggest` mode surfaces the promotion plan without applying it and `auto` mode applies it; and when no destructive git operation is ever issued under any configuration.

## 3. The documentation generator

The documentation generator runs on the `Stop` hook, in parallel with the compactor, over the units of code touched during the session. Its premise is that the best moment to document code is right after it is finished and while the knowledge graph still reflects exactly what it connects to, and its distinguishing quality is that it documents code by reading the *call graph*, not by reading a function in isolation. It lives in `src/docs/`.

It produces two things. The first is ordinary inline documentation — doc comments written beside the code. The second is richer and more characteristic of CorpoCode: a structured "what this code does" record whose shape is the following.

```typescript
export interface WhatCodeDoes {
  impacts: string[];            // what downstream behavior this code affects
  touches: string[];            // what it connects to — resolved from the KnowledgeGraph, not guessed
  risks: string[];
  futureConsiderations: string[];
  input:  { params: string; structure: string; mutabilityIfChanged: string };
  transformation: { how: string; purpose: string };
  output: { structure: string; considerations: string };
}
export interface DocGenerator {
  inlineDocs(file: string, symbol: string): Promise<string>;
  whatCodeDoes(file: string, symbol: string): Promise<WhatCodeDoes>;
  refresh(changedFiles: string[]): Promise<void>;   // regenerate records a change has staled, in the same change
}
```

Notice what this record captures that an ordinary doc comment does not. Beyond a plain description, it records the code's blast radius — what it impacts, what it touches, what risks it carries, and what to consider in future — and it lays out the code's contract as an input, a transformation, and an output, including the often-overlooked question of what happens to the input's mutability if the code changes. The single most important correctness detail is the `touches` field: it is resolved from the `KnowledgeGraph`, not inferred from the text of the function, so the documentation reflects what the code actually connects to in the real call graph rather than what a reader might assume from its body. The analogy is the difference between describing a person's role by interviewing everyone they work with versus by reading their own job title.

The `refresh` method is what keeps these records honest over time. When a change stales an existing record — a function's signature changes, say — the generator regenerates the affected record in the same change, so the documentation never drifts away from the code it describes. Stale documentation is worse than none, and `refresh` is the mechanism that prevents it.

This section is done when a touched unit receives both inline documentation and a `WhatCodeDoes` record, when an edit to a function's signature refreshes that function's record within the same change, and when the record's `touches` field matches the unit's neighbors in the knowledge graph rather than a guess.

## 4. The skill generator and `corpocode review`

This section is where CorpoCode turns the experience it has been accumulating in the memory store into durable artifacts, and where it begins to tune itself. Both features share a single governing principle, the one introduced at the top of this phase: they propose, and the human disposes.

The skill generator lives in `src/loops/skillgen.ts`. It reads the mistake and approach memories that the system has been writing since Phase 2, and it looks for recurring patterns — the same approach reached for again and again across sessions, or the same class of mistake repeatedly caught and avoided. When it finds one, it writes a candidate-skill memo to a candidates directory. Crucially, that candidate does not become a live skill on its own. Promotion is a deliberate, manual step: the user runs `corpocode skillify`, which moves a candidate from the candidates directory into the platform's skills directory, at which point it begins shaping future behavior. The reason the promotion is manual is exactly that a skill changes what CorpoCode does going forward, and a change to future behavior is precisely the kind of durable, consequential change that should pass through human approval rather than happen silently.

The review loop, exposed as `corpocode review`, is CorpoCode's self-tuning mechanism, intended to run on something like a weekly cadence. It reads the NDJSON log that every component has been writing since Phase 1 and looks for two kinds of signal: places where the user repeatedly overrode the categorizer's recommendation, which suggests the categorizer is miscalibrated for this user or this codebase, and places where a particular check kept misfiring with a high false-positive rate, which suggests a tenet's strictness is set wrong. From these signals it proposes concrete configuration changes — but it proposes them as a pull request, never by editing its own settings file directly. The reason, once more, is the control principle: a tool that quietly rewrites its own behavior is unsettling and hard to trust, whereas a tool that opens a reviewable diff explaining "you overrode the retrieval recommendation eleven times this week, so I propose lowering its default aggressiveness" is a collaborator the user can actually supervise.

This section is done when the skill generator surfaces a candidate skill derived from recurring memories and `corpocode skillify` promotes that candidate into the skills directory, and when `corpocode review` produces a configuration-change pull request from a log that contains overrides and misfires.

## 5. Auto-routing the developer's work to delegate subagents

The final piece of Phase 3 activates a capability that has been latent since the very first phase. The categorizer has emitted a `delegate_to` field on its decision since Phase 1, identifying when a moment would be better handled by a specialized subagent than by the main model. Phase 1 only recorded it. Phase 2 honored the related model-and-effort selection, but only for the work CorpoCode itself spawned. Phase 3 finally acts on `delegate_to` for the *developer's own* work.

When the categorizer identifies that a moment is best handled by a specialist — a test-writing agent for a moment that calls for test coverage, a refactoring agent for a cleanup, and so on — CorpoCode routes the work accordingly. This connects two pieces already built: the helper subagent installed back in Phase 1, and the capability flags exposed by the platform adapter from this phase's first section. The connection to the platform adapter is what keeps the feature honest across platforms, because programmatic dispatch of a subagent is something only some platforms support. Where the platform can spawn a subagent and the user has enabled automatic routing, CorpoCode dispatches the work to the named subagent directly; where it cannot, or where the user has left routing in its default state, CorpoCode instead surfaces the delegation as a recommendation for the model or the user to act on.

That default is, once again, the control principle in action. Delegation defaults to suggesting rather than to automatically handing work off, and it dispatches automatically only where automatic routing has been explicitly enabled and the platform actually supports it. The result is that the developer is never surprised to find their work silently taken over by a different agent; in the common case they see a suggestion, and the automatic hand-off is an opt-in for users who want it on a platform that allows it.

This section is done when a delegable moment produces a routing recommendation in the default suggesting mode, when on a capable platform with automatic routing enabled the work is dispatched to the named subagent, and when on a platform that cannot spawn subagents the same moment degrades cleanly to a recommendation.

## Definition of done for Phase 3

Phase 3 is complete when all of the following hold, which together form the acceptance criteria for the phase.

Multi-platform installation works through the platform-adapter layer: installing on at least three platforms beyond Claude Code produces correct shims and registrations, a reference prompt yields the expected injected-context envelope on each, and a platform missing one of CorpoCode's hook events installs the supported subset cleanly rather than failing. The git two-branch model keeps both histories: three writes produce three atomic single-file trace commits with the middle one independently revertable, a finished two-concern section with the promote signal satisfied yields two coherent commits on the clean branch while the trace branch keeps the granular record, `suggest` mode surfaces the promotion plan without applying it while `auto` mode applies it, and no destructive git operation is ever issued under any configuration. The documentation generator documents finished work accurately: a touched unit receives both inline documentation and a structured record, a signature change refreshes the affected record within the same change, and the record's `touches` field is drawn from the knowledge graph rather than guessed. The skill generator and review loop turn experience into reviewable artifacts: a recurring pattern in memory surfaces as a candidate skill that `skillify` promotes on demand, and `corpocode review` produces a configuration-change pull request from a log of overrides and misfires. And auto-delegation acts on the categorizer's long-standing hint: a delegable moment yields a recommendation by default, dispatches automatically only where enabled and supported, and degrades to a recommendation where the platform cannot spawn a subagent.

When all of that holds, CorpoCode has both reach and craftsmanship. It runs across the major coding-agent platforms through one thin adapter; it distills the raw stream of edits into a clean, readable history while preserving a complete flight recorder; it documents finished code from the real call graph and keeps that documentation from drifting; it mines its own memory into reusable skills and its own logs into configuration improvements; and it dispatches specialized work to specialists — all while keeping every durable, consequential change under the user's review. Phase 4 takes the last step toward a public product: bringing the npm release and its automated pipeline live, adding opt-in telemetry that reports only documented aggregate fields, opening the plugin API so the community can ship `corpocode-template-*` and `corpocode-tenet-*` packages that auto-register at startup, running a performance pass, and standing up a documentation site. Phase 5 then remains as the architectural finale: replacing the Python-backed knowledge graph and context store with native implementations and dropping the external toolchain entirely, leaving a system whose only hard dependency is the cheap models that have powered it from the start.
