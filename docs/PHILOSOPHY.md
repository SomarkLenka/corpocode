# What CorpoCode is

> *A swarm of cheap authors, one expensive judge, and a human in the cockpit.*

<!-- MISSION:BEGIN — canonical mission statement. Edit HERE; README.md carries the only verbatim
copy (marked as such); every other doc carries the tagline above plus a link to this block. -->
CorpoCode **simulates an expensive frontier coding model** with a massive fan-out of granular,
well-scoped cheap-model agents. The swarm does *all* the work — business requirements, technical
specs, design, codebase navigation, bug hunting, and **the implementation itself: cheap agents
write the code**. The expensive model never authors anything; it **verifies only** — reading a
great deal and emitting very little, because the economics that make this work are that **input
tokens are cheap and output tokens are expensive** (speculative decoding, scaled up to agents;
verification cadence is a tunable knob, not a fixed rite). Coding engines — Claude Code, Codex,
OpenCode — are **interchangeable hands** driven by a standalone CorpoCode **orchestrator**, the
primary product; the original hook mode survives as a secondary assist channel inside a host's
turn. The one thing never simulated and never delegated is **authorship**: intent and judgment
stay with the human, concentrated at spec time in the **Upper-Management cockpit**, which
pre-analyzes every decision fork with a fan-out of consequence agents, teaches before it builds,
and slowly adapts its questions to the pilot — after which the swarm executes autonomously
against fully specified intent.
<!-- MISSION:END -->

## Authorship vs. labor

Total offload of labor, zero offload of intent and judgment. The human's irreplaceable act is
deciding every *what* and every *why*; everything else — including turning the decided intent
into code — is labor, and labor belongs to the swarm. A tool that decides *what* to build has
quietly taken authorship; CorpoCode's cockpit exists so that never happens: every fork is polled
with its consequences already computed, and what the human has not decided is either asked or
explicitly recorded as delegated — never silently guessed. The expensive model's irreplaceable
act is **judgment**: verifying that the swarm's output matches the fully specified intent. It is
the check pilot, not the author.

## The economics

Input tokens are cheap; output tokens are expensive. So the system is shaped like speculative
decoding scaled to agents: a wide, parallel fleet of Haiku-tier drafters produces everything,
and a single strong arbiter reads a very lot to emit a very little — verdict JSON, never prose,
never code. Exhaustive analysis (every consequence of every option of every fork) is
unaffordable on a frontier model and merely cheap on the swarm; that is why the granular cockpit
and the cheap-swarm architecture require each other rather than merely coexisting.

## Two principles, rescoped

- **Fail open at the host boundary.** In hook mode CorpoCode runs inside someone else's turn:
  any error, hang, or missing dependency degrades to *doing nothing* — an empty response and a
  clean exit — never a disrupted turn.
- **Gates may block inside the airframe.** In orchestrator mode CorpoCode *is* the host: its
  verification gates and budget guards may halt its own worker engines. Fail-open still binds
  wherever CorpoCode touches what it does not own — the user's checkout and branches are never
  mutated by a run; landing is always an explicit human decision.
- **The user disposes — concentrated at spec time.** The cockpit polls the forks; after the
  human approves the spec, execution is autonomous. Durable consequences (landing a run,
  promoting a skill, applying a config diff) remain explicit human polls. Telemetry stays
  opt-in and aggregate-only.

## The three caretakers, mapped to the project lifecycle

- **Upper-Management is the front door, built first.** The cockpit: it interrogates intent into
  a complete spec — polling every decision fork with pre-analyzed trade-offs, teaching before it
  builds, adapting its questions to the pilot via a per-concept mastery model — and hands the
  swarm a fully specified target. There is no strong-model executive: a cheap interrogator agent
  and the human author the spec together.
- **Middle-Management owns the implementation phase.** It decomposes the spec into granular,
  deterministically verifiable tasks and fans out write-capable cheap agents through
  interchangeable engines, in isolated worktrees on CorpoCode-owned branches. In hook mode it
  remains the per-turn guide (categorize, retrieve, review, inject).
- **Housekeeping cleans up after the swarm.** Git trace/clean hygiene, documentation from the
  real call graph, memory consolidation, worktree and run cleanup — many cheap hands make many
  small messes, so its importance goes up, not down.

## MOLAR-EDIT

The verifier and the design-review team check work against nine tenets — **M**aintainability,
**O**bservability, **L**ogging, **A**tomicity, **R**esponsiveness, **E**xtensibility,
**D**ocumentation, **I**n-flight, **T**esting. Each tenet is one single-purpose check, fanned out
in parallel and aggregated deterministically; a community `corpocode-tenet-*` package can add
more. The cockpit runs the same shape *prospectively*: the consequence axes of a decision poll
are the tenets pointed forward, computed before the code exists instead of after.
