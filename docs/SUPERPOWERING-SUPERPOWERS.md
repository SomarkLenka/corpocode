# Superpowering Superpowers

**Narrative and technical implementation theory for the system we are building.**

superpowers gave a coding agent skills and discipline so it stopped flailing. We are aiming that exact
move at superpowers itself. Its brainstorm → plan → execute → gate spine is the *seed* — we grow it into
a firm of cheap-model shells that offloads every part of building software **except the authorship**,
wrapped around a coding engine demoted to interchangeable thrust.

One line holds the whole thing together: **total offload of labor, zero offload of intent and judgment.**

> **How to read this.** Part I is the vision — what we are making and why it is shaped this way. Part II
> is the buildable theory: the *near-term* design is grounded in real CorpoCode source (every `src/`
> reference was verified, not assumed) and ships today; the *cockpit endgame* is the part still on the
> drawing board, written down now so the design exists before the code. Where a claim leans on a fact
> about the code, the file and line are named so you can check it instead of trusting it.

---

# Part I — The Vision

## Offload the labor, never the authorship

Every agentic-coding pitch promises to take work off the human. We invert *which* work.

The expensive coding model's one irreplaceable act is turning a fully-specified intent into correct code.
Everything around that act — eliciting the intent, weighing the trade-offs, finding the relevant files,
recalling what was already decided, verifying the edit, keeping git clean, writing the docs, choosing the
dependencies — is **labor**, and labor belongs to a firm of cheap shells. But the *intent* and the
*judgment* — every *what* and every *why* — are **authorship**, and authorship stays with the human,
amplified and educated.

This is the line everyone else blurs and we refuse to. A tool that decides *what* to build has quietly
taken authorship. A tool that only decides *how* to build a thing the human specified exactly has taken
only labor. Our whole telos is to push the boundary of "labor" outward until it holds everything except
authorship — and to make the human a stronger author every session along the way.

## The analogy, made into architecture

The system is the **plane, the pilot, and the control surfaces** — a fly-by-wire airframe that turns a
mental abstraction into a physical manifestation. The human is the **pilot and the passenger**: a
fly-by-wire pilot who says where to go and at what altitude, speed, and load, then sits back as the
airframe flies — but far more granular than any passenger, free to plan the route atom by atom whenever
they want. Claude, Codex, OpenCode, any coding agent, is the **engine**: raw forward thrust, nothing
else.

The architectural claim hiding inside the analogy is the entire design: **intelligence migrates from the
engine to the airframe.** Today a coding agent is asked to be pilot, navigator, mechanic, *and* engine
at once. We strip it to pure thrust and rebuild pilot, navigator, and mechanic as cheap, specialized,
swappable shells. The consequence is deliberately strange and it is the point: **the smartest part of the
system is the part that writes no code.** The engine is the dumbest, most replaceable component, hidden
behind a provider interface precisely so it can be swapped — Claude for Codex for a local model — without
the airframe noticing.

## Three shells

Read through this lens, superpowers is not a peer to bolt on. It is a ready-made, *novice-grade* draft of
three concentric shells the airframe needs — each of which our mature version deepens by an order of
magnitude.

**Cockpit — intent into a flight envelope.** superpowers' `brainstorming` + `writing-plans` + the
`json:metadata` task fence are the embryonic flight plan: they capture *what* and a rough route. Our
cockpit captures the whole envelope — how high the airframe flies before it asks, the task route, the
velocity↔rigor dial, the resource load (cost, model tier, fan-out width), the environmental constraints
(target runtime, framework posture, dependency policy), the context budget. superpowers' `modelTier` is
*one knob on that panel*. The cockpit endgame below is what the panel becomes once it learns the pilot.

**Envelope protection — the gates are control laws.** Fly-by-wire's defining feature is not that it flies
the plane; it is that it *will not let the pilot or the engine leave the safe envelope*, whatever they
command — and that is what lets a novice fly a fighter jet at all. superpowers' hard gates are this,
immature: *can't stall* → no shipping without passing tests; *can't over-G* → no exceeding the cost/load
envelope; *can't depart controlled flight* → no letting architecture drift past declared invariants;
*terrain avoidance* → no running the destructive command. The gates are not in tension with running
fail-open. They sit at a **different radius**: fail-open binds the airframe to the *host* it runs inside
and must never brick; the gates bind the *engine* inside the airframe's own orchestration, where it is
the host and free to block the core's unsafe moves. An onion, not a standoff.

**Airframe — everything that makes the jet go.** Retrieval, git hygiene, documentation, tech-spec,
framework selection, dependency management. superpowers barely touches these. CorpoCode's housekeeping
already owns git and docs; the telos extends it to spec, framework, and dependencies. They run beneath
the flight plan — the pilot sets the destination and the load, the airframe handles fuel, trim, and
systems without ever consulting the engine.

## The cockpit endgame: a prospective decision engine

This is the part with no precedent in either project, and it is what "a novice pushing a fighter jet to
its full potential" actually demands.

**Decisions arrive pre-analyzed.** Claude Code can already ask about an architectural fork — but
reactively and shallowly, when it hits one it can't resolve, with options invented on the spot. We invert
the verifier. The MOLAR-EDIT design-review team fans out one cheap agent per tenet *retrospectively*,
over code already written. The cockpit runs that same fan-out shape *prospectively*, over the option
space of a decision the pilot has not yet reached. For one function signature: an agent each for the
performance consequence, the maintainability cost, the idiomatic-language reading, the future-extensibility
tax, the failure modes — aggregated into a decision with *every trade-off already calculated before the
pilot could have thought of it*. Then, and only then, the pilot is polled, choosing from a pre-analyzed
tree rather than answering an open question.

**"Nothing left to interpretation" is the definition of flawless.** This is the engineering justification
for the granularity, not an aesthetic. Flaws enter a system exactly where it interpolates intent it was
never given. A coding agent silently guesses a hundred times per feature — a library, an error strategy, a
data shape, a name — and every silent guess is a place the artifact can diverge from what the human
wanted. Polling every fork with pre-computed consequences *removes the interpolation entirely*: the cost
is interrogation, the payoff is zero unspecified behavior. The granularity **is** the correctness
mechanism. Overwhelmingly, infuriatingly granular — *if desired* — because that dial is the difference
between a guess and a guarantee.

**The panel morphs, very slowly, to the pilot.** It is not static. A persistent per-concept mastery model
tracks what the pilot has been taught and what they now decide confidently without prompting. The panel's
*default* altitude is a function of that model: mastered concepts drop out of the poll (assumed); frontier
concepts get the full teach-then-poll treatment; concepts past the frontier stay hidden until the pilot
climbs to them. "Very, very slowly" is a **control parameter**, not a mood — the morph rate lives between
two failure modes. Too fast brings interrogation fatigue, or premature autonomy that assumes mastery the
pilot lacks and smuggles silent guesses back in. Too slow brings stagnation: the pilot never grows and the
jet never opens up. Tuning that rate is the product.

**It teaches before it builds.** Before polling a decision the pilot is not yet equipped to make, the
cockpit injects a teaching block pitched to their current level — what this concept is, why it matters
here, what each option means — then implements on the fly once the choice is made. As the mastery model
widens, the panel exposes more sophisticated options as the pilot becomes ready, walking a novice up the
curve toward using the language to its full potential. One non-obvious requirement: **the teaching must
itself pass the gates.** A wrong explanation the pilot then acts on is worse than none — it corrupts the
authorship at the source — so the same adversarial-verify discipline that guards the code guards the
lesson.

**Both seats are load-bearing.** The system *cannot* be autonomous: it polls every fork precisely so the
pilot's intent is irreducible at each one — remove the pilot and there is nothing to interpolate from, and
you are back to guessing. And the pilot *cannot* be left behind: the teaching keeps the passenger in the
loop, growing, so next flight they *are* the pilot for that concept. Total labor offload, zero authorship
offload — and the slow morph is the mechanism that hands more authorship sophistication to a human the
system has spent the whole time qualifying to wield it. The product is cohesive because authorship and
execution are split clean: the human owns every *what* and *why*, the shells own every *how* and *do-it*.
The plane still needs a pilot and a passenger. It requires both for a coherent product.

---

# Part II — The Implementation Theory

## Two planes now, one airframe later

Two honest answers, the same arc at different times.

**Near-term — coexistence (harvest).** superpowers keeps the spine and the *sole exit-2 BLOCK authority*;
CorpoCode becomes its memory / context / routing substrate, its own blocking, git, verifier, and
re-routing side-effects **actively quiesced** while a plan is in flight. The two planes fuse at
*artifacts*, never in one process.

**Long-term — absorption (the telos).** CorpoCode reimplements the cockpit's control laws in TypeScript
and deepens them. The cross-harness TS gate lane (Phase 6) is not an afterthought — it is the first step
of the airframe taking over the cockpit, forced into being by the harnesses where superpowers' bash hooks
cannot run at all.

superpowers is the seed you harvest now and the thing the airframe grows into later. Both phases share one
contract.

## The verified substrate — load-bearing facts

Every premise below was checked against source. These constrain the design; get one wrong and the plan
breaks a superpowers session on contact.

| Fact | Where | Why it matters |
| --- | --- | --- |
| One handler per event; gates compose *inside* a handler by `tool_name`, never per-matcher | `src/hooks/handlers.ts` `buildHandlers()` | Cross-harness gates must be `tool_name` branches inside existing handlers, not new `HandlerMap` entries. |
| Two block channels exist | `src/hooks/response.ts` | `permissionDecision:'deny'` (PreToolUse) and `decision:'block'`/`continue:false`+`stopReason` (PostToolUse/Stop). A one-channel design is false. |
| Fail-open is structural and absolute | `src/hooks/dispatch.ts` — `withTimeout(45_000)` + catch → `emptyResponse()` | Any throw, timeout, or parse failure in a TS gate degrades to **ALLOW**, identical to a superpowers bash ERR-trap. |
| **SessionStart injects nothing** | `src/toolbox/session-start.ts` `handleSessionStart` returns `{}` (line 52) | It is the toolbox gate (`gateToolbox` + `pruneOldSessions`). Memory recall does **not** run here. |
| Memory recall is **paid, per-prompt** | `src/router/handler.ts` `handleUserPromptSubmit` | `lineOfThought` + `recall` run every prompt. "Plans learn from past failures" is a per-prompt cheap-model cost, not a free once-a-session injection. |
| Git side-effects are **live at install**, not dark | `src/config/schema.ts` (`git.enabled`/`commit_per_write`/`branch_management` default `true`), `src/git/manager.ts:45-47` | First Write creates `refs/heads/corpocode/trace` + `corpocode/clean` and per-write commits *inside the superpowers worktree*. |
| The verifier-halt is **live at install** | `verify_on_edit` default `true` (`schema.ts:122`), `src/verifier/aggregator.ts` (BLOCK_CONFIDENCE 0.7) | A coordinator-level Write on a plan file can be halted from day one. |
| The deny surface is wider than Bash | `src/filter/classify.ts:24` `extractCommand` | Returns commands for Bash, Shell, **PowerShell, and pwsh** — on the Windows `run-hook.cmd` stack this intersects superpowers' `verifyCommand` and git steps. |
| Custom-`subagent_type` exemption | `pre-agent-model-routing` hook lines 70-73 | If CorpoCode's `planDelegation` names a custom type the host acts on, tier enforcement silently disengages. |
| The tier gate checks **presence**, not model identity | `pre-taskcreate-model-tier` line 148 | "Teeth" enforce that a valid tier *string* is present and route CorpoCode's own dispatch effort — not a guaranteed vendor reasoning level. |
| `--bare` recursion guard | host subagent flag | CorpoCode's hooks never fire inside subagent turns, so the verifier/memory loop sees only **coordinator-level** edits. |
| Co-registration is real | `src/install/settings.ts:42,52` (`isCorpocodeGroup`), matcher `*` (`:18`) | CorpoCode and superpowers' `run-hook.cmd` group run side by side; both fire on every matching tool call. |

## Plan-quiescent mode

Both of CorpoCode's blocks (verifier-halt on Write/Edit; deny on shell tools) are real and *can* hit a
superpowers-owned step, so the disjointness of the two block surfaces is **not free — it is
manufactured.** A single detector — `src/superpowers/plan-state.ts`, a read-only helper that locates the
co-located `<plan>.tasks.json` and returns the in_progress task's `files` list, `verifyCommand` string,
and `acceptanceCriteria` — drives the mode. While it reports an in_progress task, CorpoCode:

1. suppresses the **verifier-halt** on the plan's files *and* its `verifyCommand` command-string (covering
   PowerShell/pwsh, not just Bash) — `config.superpowers.suppress_block_on_plan_files` +
   `suppress_block_on_plan_commands`;
2. suppresses **`route_on_heavy_coding`** re-recommendation (`src/filter/handler.ts:37`,
   `src/toolbox/route.ts`), so it never tells the host mid-plan to invoke a different skill or spawn a
   delegation subagent that would fight superpowers' deterministic spine;
3. suppresses the **filter file-read injection** (`src/filter/handler.ts:25-31`, fired on every
   Read/Glob/Grep) on the coordinator path, so it never silently appends retrieved context to the
   coordinator's reads of the plan, prior task files, and review diffs — preserving the
   zero-context-subagent rule. Context reaches subagents *only* through the explicit Agent-dispatch
   `gather()` branch, never through ambient read-injection.

CorpoCode still *advises* via `additionalContext` on UserPromptSubmit and on the implementer Agent
dispatch. It just stops *blocking* and stops *re-routing* while superpowers owns the turn.

## The fusion contract — single-writer discipline

The planes fuse at three artifacts and one shared module, never one process.

- **`<plan>.tasks.json`** — superpowers writes, CorpoCode reads. The single source of "a plan is
  in-flight."
- **`docs/superpowers/model-routing.json`** — CorpoCode writes *sanitized, schema-valid* tiers
  (control-byte strip + `iconv -c`); superpowers' existing fail-closed bash gate enforces them. A *trust
  inversion* to respect: a malformed tier makes the bash gate ERR-trap to **allow**, so a unit test must
  assert every emitted value passes `pre-taskcreate-model-tier`, and `doctor` warns if the file is present
  but unparseable.
- **A shared `sp_task_id` correlation key** — the native task id (or a generated trace id) written to
  *both* `corpocode.ndjson` and superpowers' `/tmp/claude-hooks/user-gate-trace.log`, so the Monitor feed
  and the superpowers trace join into one timeline instead of two unjoined streams. Every degrade-to-allow
  is logged here too, so a silently-skipped block is never invisible.
- **`src/superpowers/transcript-model.ts`** — *one* typed, unit-tested, linear-in-bytes transcript reader
  returning `{tasksById, inProgressSet, fenceMetadata, evidenceMarkers, armState}`, replacing the 7+
  duplicated embedded-python3 scanners across superpowers' `hooks/` and fixing the session-2013ea56
  native-id mis-keying bug. Highest-value, lowest-risk deliverable; ships standalone; no live caller in
  Phase 0.

## The new seams, named

| Seam | Purpose |
| --- | --- |
| `src/superpowers/transcript-model.ts` | The one transcript reader (above). |
| `src/superpowers/routing.ts` | Pure tier↔difficulty resolution (mechanical/standard/frontier ↔ trivial/medium/hard) reading `config.effort.difficulty_to_model`. The *same* function that authors `model-routing.json` and that the TS gate uses to compute the allowed set — so advice and enforcement agree **by construction**. |
| `src/superpowers/plan-state.ts` | The read-only in-flight detector driving plan-quiescent mode. superpowers stays sole writer. |
| `config.superpowers` in `src/config/schema.ts` | `{enabled, enforce, suppress_block_on_plan_files, suppress_block_on_plan_commands, write_model_routing}` — each `.default()` so `configSchema.parse({})` stays byte-identical to vanilla. |
| superpowers-detection gate in `src/install/settings.ts` | On detection, also sets `git.enabled=false` (or `branch_management=false`+`commit_per_write=false`), `verify_on_edit=false`, and `route_on_heavy_coding=false` as installed defaults — making the Phase-0 invariant *real*, not asserted. |
| `config.toolbox.exclude_skills` in `gate.ts` **and** `route.ts` | Exclude superpowers' workflow skills from both frontmatter-rewriting **and** mid-execution re-recommendation. |
| plan-quiescent guard in `src/filter/handler.ts` | Wraps `maybeRouteHeavyCoding` (line 37) and the file-read injection (25-31) to no-op during an in_progress plan. |
| task-aware decision lookup | Replaces the stale `readLastDecision` (`src/filter/handler.ts:59`) on the Agent-dispatch path — keys the gather()/effort decision off the *dispatched task's* `modelTier`, not the user's original-prompt decision in `src/session/decision-cache.ts`. |
| `tool_name` branches in `handlePreToolUse`/`handlePostToolUse` | Where the cross-harness TS gates and the gather()→subagent-brief injection live. The PostToolUse branch needs a **new** TaskUpdate-completed reader consuming `transcript-model` evidence. |
| `corpocode-tenet-superpowers` npm package | Data-only `TenetCheck[]` carrying superpowers' Critical/Important/Minor severity taxonomy into the MOLAR-EDIT fan-out via `discover.ts`, fail-open if it throws. |
| `corpocode doctor` superpowers checks | Detects superpowers; asserts both hook groups co-registered, git/`verify_on_edit`/`route_on_heavy_coding` quiesced as installed, frontmatter unmodified, the two-switch sync state, and flag-off parity. |

## Enforcement resolution

The hard-gate-vs-fail-open tension resolves by three mechanisms, through **active quiescence** rather than
an asserted disjointness the code does not provide for free.

1. **On bash-capable harnesses (the common case),** the two enforcement strengths live in physically
   separate processes, and their block surfaces are made disjoint by plan-quiescent mode. superpowers'
   bash gates are the only thing that exit-2 BLOCKs, exclusively on the *planning* surface
   (TaskCreate / Agent / AskUserQuestion / Stop). CorpoCode's blocks are on the *execution* surface (shell
   tools; Write/Edit) and are suppressed on plan-covered files and command strings while a plan is
   in-flight. Fail-open survives both ways: a CorpoCode crash → `emptyResponse()` (turn proceeds, bash gate
   still enforces); a bash ERR-trap → allow (turn proceeds, CorpoCode still advises). The suppression
   **defaults ship in Phase 0** — the mitigation is sequenced *before* the capability that needs it.

2. **Where bash cannot run (Cursor/Codex/Gemini),** the optional cross-harness TS lane reproduces
   enforcement using the fail-open-verdict dispatcher. The verdict is computed *inside* `dispatch.ts`, so
   any throw / malformed stdin / missing config / unparseable transcript / timeout degrades to ALLOW. The
   *only* thing that can BLOCK is a successfully-computed, opt-in-armed (`config.superpowers.enforce` +
   `model-routing.json` present + no `*_GUARD`), **confident-negative** verdict, through the correct
   channel per event. This lane must also reimplement the `specifying-gates` execute-time AskUserQuestion
   flow (the 4–5 fixed questions writing back into the `json:metadata` fence), not only the planning
   gates — otherwise gate-specification silently vanishes on a bash-less harness.

3. **The A/B parity period.** When both a bash gate and CorpoCode's `*` PreToolUse handler are present on a
   bash-capable harness, CorpoCode's TS gate branch runs in **compute-and-log-only** mode: it computes its
   verdict, writes it to the trace log (keyed on `sp_task_id`) beside the bash decision, and never emits
   deny/`continue:false`. Only after decision-parity is proven over real sessions is the TS lane armed on
   the bash-less harness it was always meant for. Two block-capable enforcers never race because, in
   production, exactly one is ever armed per harness.

Three invariants keep this from bricking a session. **(a)** A successfully-parsed transcript showing no
valid `modelTier` fence / no `AC: … — PROVEN BY` marker is a *confident-positive* detection of a structural
violation (parse succeeded, required token provably absent) — distinct from a *failed* parse, which
degrades to allow. **Absence-of-required-evidence blocks; failure-to-determine allows.** **(b)** Every
degrade-to-allow is observable on the Monitor feed and the superpowers trace, joined by `sp_task_id`.
**(c)** The whole TS lane is dormant unless explicitly armed, so a vanilla install is byte-identical to
today.

## The cockpit as a forward-run of the verifier

The cockpit endgame is, mechanically, CorpoCode's design-review team (`src/review/team.ts runDesignReview`)
run *prospectively*. Where the verifier fans out one cheap agent per MOLAR-EDIT tenet over written code,
the cockpit fans the same shape over the option space of an unmade decision, producing a poll whose every
branch already carries its computed consequence. It rides the live fan-out — `gather()`
(`src/intelligence/gather.ts`) for grounding, the provider registry for the per-axis cheap agents,
`additionalContext` for both the poll and the teaching block — and needs no new engine. The pilot's
selection is captured as a `decision` memory; the resulting code is verified by the *retrospective* run of
the same team, closing the loop.

This is the single largest compute driver in the design — a per-decision, per-axis fan-out over an option
space is orders of magnitude more cheap-model calls than the per-turn fan-out. **That is not a problem with
the vision; it is its strongest justification.** Exhaustive prospective trade-off analysis is unaffordable
on the expensive coding model and merely expensive on a firm of cheap caretakers behind a swappable
engine. The granular cockpit is what makes "cheap shells, commodity thrust" non-optional rather than merely
economical: the architecture and the ambition require each other.

## The expertise model — the keystone

The mastery model is the one piece neither superpowers nor CorpoCode has sketched, and everything in the
cockpit endgame hangs off it. It is a new `mastery` record in the memory store alongside
`decision`/`mistake`/`rule`/`approach` — composition, not new infrastructure.

**Concept taxonomy.** A DAG of language and architecture concepts (`ownership/borrowing`,
`async cancellation`, `errors-as-values vs exceptions`, `dependency inversion`, `idempotency`,
`backpressure`, …), edges encoding prerequisites, sourced from the language's feature surface, the
MOLAR-EDIT tenets, and a pattern catalog. Each node carries an `exposure` level and a `mastery` score in
`[0,1]`. The DAG is how the panel exposes the full capabilities of the language without dumping everything
at once: a concept is offered as an *option* only once its prerequisites are mastered. Climbing the DAG
**is** the pilot's growth curve.

**Mastery-update rule.** When the cockpit teaches concept `C` and the pilot makes a decision involving it,
update with a confidence-weighted exponential moving average:

```
m' = m + α · (outcome − m)
```

`outcome ∈ [0,1]` blends three signals — did the pilot choose confidently (or skip the teaching entirely),
did the resulting code pass the gates, and did they need re-teaching. A slow time-decay pulls unused
concepts back down (forgetting), justifying eventual re-teaching and giving the model a spaced-repetition
shape. `α` (learning rate) and the decay constant are two of four tuning knobs.

**Morph-rate control law.** The panel's default treatment of `C` is a function of `mastery(C)` against two
thresholds: below `θ_teach` → **teach-then-poll**; between `θ_teach` and `θ_assume` → **poll-without-teach**;
above `θ_assume` → **silently assume** the pilot's established default. "Very, very slowly" is encoded as
**hysteresis plus rate-limiting**: mastery may only raise the assumed level after `K` consecutive
confident, gate-passing decisions (debounce against a lucky streak), and a single failure does *not*
instantly demote (guard against yanking capability away). The hysteresis gap (`θ_assume − θ_teach`) and `K`
are the other two knobs. Tuning `{α, decay, K, gap}` against the fatigue↔stagnation axis is the product.

**The invariant that makes promotion safe.** The mastery model governs *what is polled and taught, never
what is enforced.* Envelope protection stays on regardless of assumed mastery — a pilot "promoted" past a
concept simply stops being *asked* about it; they are never permitted to leave the safe envelope. Mastery
changes the questions, not the control laws. And because the teaching content is itself gated (a wrong
explanation is worse than none), the verify discipline wraps the pedagogy as tightly as it wraps the code.

## Phased roadmap

Each mitigation ships *before* the capability that needs it.

- **Phase 0 — install-time quiescence + pure modules.** Co-register hooks; on superpowers detection set
  `git.enabled=false`, `verify_on_edit=false`, `route_on_heavy_coding=false` as installed defaults; add the
  `config.superpowers` block + toolbox skill-exclusion (gate.ts *and* route.ts) + suppress flags, each
  `.default()`. Ship `transcript-model.ts`, `routing.ts`, `plan-state.ts` as pure, fully unit-tested
  modules with no live caller. Add the `doctor` assertions. Honest framing: this is *not* "byte-identical
  to vanilla CorpoCode" (the exclusions and quiescence are real changes); it *is* "a superpowers session
  runs byte-identically to superpowers-without-CorpoCode."
- **Phase 1 — memory → plan (paid, live, additive).** Wire `handleUserPromptSubmit` (not
  `handleSessionStart`) to append a file-anchored mistakes/rules recall block, deduped against the router's
  existing retrieval/review/toolbox/delegation blocks. State the cost honestly: one cheap-model
  distill+recall per prompt. Behind a default-on flag, fail-open. Establishes `sp_task_id`.
- **Phase 2 — retrieval → subagent (additive).** Add the PreToolUse/Agent branch running deterministic
  `gather()` (no model call) over the task's `files`, keyed off the dispatched task's `modelTier` via the
  task-aware lookup. Fire only when a files list is present; bound by `globalProviderLimiter(12)`;
  cap/disable during parallel dispatch so it never starves the hot path.
- **Phase 3 — plan-awareness + learning (read-only; git only if opted in).** Scope the verifier to
  in_progress files; inform the compactor of `verifyCommand`/AC; only if git was opted back in, fire
  `PromoteSignal 'tests_passed'` in suggest mode — never owning the user's merge branch or commit narrative.
  The compactor consolidates fired-gate outcomes (joined via `sp_task_id`) into mistake/rule memories;
  skillgen mines repeated gate-failures into candidates behind the human `--promote` gate.
- **Phase 4 — model-tier teeth (opt-in).** Pin mechanical/standard/frontier providers to the exact strings
  the bash gate validates; CorpoCode writes sanitized advisory tiers to `model-routing.json`, activating
  superpowers' existing enforcement. Unit-test that the recommended tier always passes
  `pre-taskcreate-model-tier`; on disagreement the bash gate wins. State honestly: this enforces
  tier-string-presence and routes CorpoCode's own dispatch effort, not a vendor reasoning level.
- **Phase 5 — review fusion (advisory + bidirectional).** Feed `writing-plans` output into
  `runDesignReview`'s `designContext` for a pre-execution per-tenet plan review as `additionalContext`;
  ship `corpocode-tenet-superpowers`. Bidirectional: the verifier's Testing-tenet result + `tests_passed`
  signal feed *back* into `systematic-debugging`'s Iron Law and TDD's failing-test-first — not one-way only.
- **Phase 6 — cross-harness TS gates (deferred, optional).** Only for Cursor/Codex/Gemini. Reimplement the
  planning gates *and* the `specifying-gates` AskUserQuestion flow as `tool_name` branches; the PostToolUse
  TaskUpdate-completed reader is new code. Mandatory compute-and-log-only A/B on a bash-capable harness
  first, decision-parity proven before any cutover. The dark IntelligentRouter and the Upper-Management
  charter stay **unbuilt** — superpowers' `brainstorming`+`writing-plans` *are* the executive front-end.
- **Cockpit endgame (charter).** The prospective decision engine and the expertise model, built on the
  Phase-0 substrate (the shared transcript-model and a `mastery` memory kind), the Phase-5 review team run
  forward, and the Phase-6 control laws keeping the climbing novice inside the envelope.

## Honest limits

Two consequences of the substrate the vision must absorb, not paper over.

- **Real-time supervision stops at the coordinator boundary.** The `--bare` recursion guard means
  CorpoCode's hooks never fire inside subagent turns, and `subagent-driven-development` does most real work
  in subagents. The airframe can supervise the two-stage-review diff and coordinator-level edits, but *not*
  each combustion stroke inside the engine. "Offload everything and watch the engine in real time" hits a
  wall here; you watch at the boundary, not inside. Memory capture and verification are scoped to
  coordinator-visible edits and disclosed as such — no promise of per-subagent real-time verification.
- **The tier teeth bite a string, not a model.** `pre-taskcreate-model-tier` checks presence, and
  `frontier` projects onto an effort budget, not a vendor reasoning knob. The coupling makes the tier
  non-skippable and routes CorpoCode's own effort; it is not extended-thinking-on-demand. The cockpit must
  never promise the pilot a capability the airframe cannot physically deliver.

## Invariants the build must honor

- **Reuse the substrate, don't fork it.** The army is the existing fan-out, the executive is a provider,
  the memory is the memory store, the channel is `additionalContext`. New infrastructure here is a smell.
  The integration rides only *live* paths — the dark engine and Upper-Management stay off.
- **Fail open at the host boundary, always.** Every handler degrades to `{}` via the dispatcher's catch +
  45 s timeout. The turn is never broken; superpowers' gates still enforce.
- **superpowers keeps sole exit-2 BLOCK authority on the planning surface.** CorpoCode advises and
  quiesces; it does not contend for the block on a bash-capable harness.
- **The user disposes.** Plans, tier files, git promotions, skill candidates, and every cockpit decision
  are *proposed*; the human confirms. Authorship never leaves the human seat.
- **Structure, not presentation.** Every artifact — plan, tier file, spec, teaching block — carries meaning
  (entities, contracts, trade-offs, concepts), never rendered markup.
- **Single-writer per artifact.** superpowers owns `<plan>.tasks.json`; CorpoCode owns `model-routing.json`
  and the memory stores. Neither writes the other's file.

---

*Where this came from: Part II's substrate facts and seam design were produced by a multi-agent
understand → design → judge → synthesize → critique pass over both codebases and checked against the
cited `src/` locations. Part I and the cockpit endgame are the design talking ahead of the code. When the
code lands, this document is what it has to stay true to — if it stops matching reality, fix it or delete
it in the same change that made it stale.*
