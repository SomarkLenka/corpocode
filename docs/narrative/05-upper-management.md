# Chapter 05 — Upper-Management: the cockpit

*The front door. Every CorpoCode engagement begins here: Upper-Management interrogates intent
into a **complete specification** — polling every decision fork with its consequences already
computed, teaching before it builds, and slowly adapting its questions to the pilot — and then
hands the swarm a fully specified target to execute **autonomously**. It is built **first**,
because everything downstream consumes its output.*

> *A swarm of cheap authors, one expensive judge, and a human in the cockpit.* — the mission of
> record lives in [`docs/PHILOSOPHY.md`](../PHILOSOPHY.md); this chapter is the cockpit's
> charter, and [chapter 08](08-orchestrator.md) is the run it launches.

---

## There is no executive

The earlier version of this charter imagined an expensive "executive" model directing the spec
work. That framing predates the reframe and is **dead**: in the entire system the expensive
model has exactly one role — the **arbiter**, which verifies the swarm's output
([chapter 08](08-orchestrator.md)) — and it appears nowhere in the cockpit. The spec is authored
by two parties only:

- a **cheap interrogator agent** (a persistent, resumable agent thread — one directed
  conversation, not a series of one-shot prompts) that drafts the decision forks, tracks which
  charter sections remain open, and folds answers into the spec, and
- **the human**, who makes every decision that matters.

Deep reasoning over the whole design is not bought with an expensive model; it is *assembled*
from breadth — one cheap agent per consequence of each option of each fork — which is exactly
the trade the economics favor: exhaustive analysis is unaffordable on a frontier model and
merely cheap on a swarm.

## The cockpit: decisions arrive pre-analyzed

The defining move (inherited from [SUPERPOWERING-SUPERPOWERS](../SUPERPOWERING-SUPERPOWERS.md)
Part I, which remains the vision source): the MOLAR-EDIT review fan-out, run **prospectively**.
Where the verifier fans one cheap agent per tenet over code already written, the cockpit fans
one cheap agent per **option × consequence axis** over a decision the pilot has not yet made —
performance, maintainability, extensibility, failure modes, idiom — and aggregates the findings
into a poll whose every branch carries its computed trade-offs. The pilot chooses from a
pre-analyzed tree instead of answering an open question. The recommendation attached to a poll
is a **deterministic majority-of-axes fold** (tie → no recommendation) — never a hidden model
call.

**"Nothing left to interpretation" is the correctness mechanism, not an aesthetic.** Flaws enter
a system exactly where it interpolates intent it was never given. Every silent guess a coding
agent makes is a place the artifact can diverge from what the human wanted. Polling every fork
removes the interpolation entirely; the granularity dial (`every-fork` → `major-forks` →
`minimal`) is the difference between a guarantee and a guess, and it belongs to the user. A
fork the pilot declines ("you decide") is recorded in the decisions ledger as **`delegated`** —
answered by the deterministic recommendation, never silently guessed.

**It teaches before it builds.** When a poll involves a concept the pilot is not yet equipped to
decide, the cockpit shows a teaching block pitched to their level before asking. And **it morphs,
very slowly, to the pilot**: a per-concept mastery model (a `mastery` memory kind, global to the
user rather than per-project) tracks what the pilot decides confidently; mastered concepts drop
out of the poll, frontier concepts get teach-then-poll, concepts past the frontier stay hidden.
The morph rate is a control law (EMA + hysteresis + debounce), tuned between interrogation
fatigue and stagnation. Mastery changes **what is polled and taught, never what is enforced** —
envelope protection stays on regardless of assumed mastery.

## What it produces: the interrogation deliverable

The cockpit's deliverable is not code; it is a spec complete enough for **autonomous
execution** — after spec approval there is no human in the implementation loop, so anything
unspecified now is a guess later. The interrogation drives until it has, at minimum:

- **The technical and API spec** — entities, contracts, endpoints, data shapes: the precise
  surface the build will implement.
- **Expansion of current capabilities** — for an existing codebase, what is being added and how
  it grafts onto what exists (grounded in the KnowledgeGraph, not imagined).
- **Future plans** — the features the architecture must *not* foreclose.
- **Parallelization of the work** — which tasks are independent, so the swarm can fan out.
- **Compartmentalization of services** — boundaries with one reason to change each.
- **The path to production scale** — decided up front rather than retrofitted.
- **Reusable systems built once** — the shared substrate factored out a single time.

Concretely, a completed interrogation emits into `.corpocode/runs/<runId>/`:

- **`spec.json`** (Zod-validated structure — entities, contracts, constraints, future seams,
  compartments, scale path, reusable systems, `acceptance[]` with a verify method per criterion,
  and `taskSeeds[]`) with **`spec.md` derived from it, one direction only** — structure, not
  presentation;
- **the decisions ledger** — every poll, its per-axis findings, the answer, and its source
  (`pilot` | `delegated` | `default`): the single audit trail of every human choice, extended
  later by any mid-run escalation;
- **`tasks.json`** — a task graph in a superset of the superpowers plan schema, so a spec-only
  run hands back artifacts executable with superpowers-equipped Claude Code today;
- **design-grade `MemoryStore` entries** — architectural flaws recorded once, never walked into
  twice (and immediately enriching hook-mode recall).

The exit is visible and explicit: each charter section above is a ledger lamp that goes
amber → green, and the run leaves the cockpit only when all are green **and** the pilot answers
the final "approve spec" poll.

## The superpowers harvest: v0 now, absorbed later

The superpowers plugin's `brainstorming` and `writing-plans` skills are a proven, novice-grade
draft of exactly this interrogation spine, so the cockpit **harvests them as v0**: their prompt
content is **vendored, version-pinned, provenance-commented** into CorpoCode's prompt registry
(`um-interrogate-v0`, `um-decompose-v0`) — content and schema, never process. There is no
runtime dependency on the installed plugin (agents spawn with `--bare`, which skips plugins; the
cockpit must own the conversation). Superpowers' execution gates are **not** harvested: the
orchestrator's own wave/verify gating supersedes them ([chapter 08](08-orchestrator.md)).
Absorption is complete when deleting the vendored constants changes prompt text, not
architecture.

## Substrate map

| It needs | It uses |
| --- | --- |
| the directed conversation | a cheap agent on a **persistent session** (`sessionKeyForTopic`, `src/agents/sessions.ts`) so the interrogation is literally one resumed thread |
| breadth per decision | the intelligence engine's bounded fan-out (`src/intelligence/engine.ts` — the cockpit is its first live consumer), one read-only cheap agent per option×axis |
| grounding | `gather()` (`src/intelligence/gather.ts`): `KnowledgeGraph.scoreFiles` + `MemoryStore.recall`, zero model calls |
| a way to ask the human | the **Interactor seam** (`src/interact/`) — the codebase's first interactive surface: terminal Q&A now, a monitor-style local web cockpit next, a scripted answers file for CI |
| the spec state | a pure state machine (`src/um/interrogator.ts`) over the seven sections — `nextMoves` / `applyAnswer` / `isComplete`, zero IO |
| durable memory | `MemoryStore` with `design-flaw` and `mastery` kinds |
| run state | `.corpocode/runs/<runId>/` via `src/config/paths.ts`, journaled through the Logger seam so `corpocode why`/`monitor` narrate it for free |

## Invariants the build must honor

- **The arbiter is the only strong-model component in the system.** The cockpit runs entirely on
  cheap agents plus the human. No executive, ever.
- **Never silently guess.** Every fork is polled, delegated (recorded), or defaulted (recorded —
  a dead interactor resolves a declared default and journals `answer_defaulted`, or pauses the
  run). The ledger is complete or the run does not leave the cockpit.
- **Reuse the substrate, don't fork it** — the fan-out is the engine, the conversation is an
  agent session, the memory is the MemoryStore, the prompts ride the existing resolver.
- **Fatigue is a failure mode** — `max_polls` guards the loop; the granularity dial and the
  mastery model exist to keep interrogation proportionate to the pilot.
- **The user disposes, concentrated here.** The spec becomes the plan only on the explicit
  approve poll; after that the swarm runs autonomously and every later escalation lands in the
  same ledger.
- **Structure, not presentation** — `spec.json` is the artifact; `spec.md` is derived, one way.

---

*Continue to [chapter 06 — the IntelligentRouter](06-intelligent-router.md), the substrate the
cockpit fans out through, or jump to [chapter 08 — the orchestrator run](08-orchestrator.md) it
launches.*
