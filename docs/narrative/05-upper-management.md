# Chapter 05 — Upper-Management

*The executive caretaker: the one tier that **designs whole applications** rather than guiding or
tidying a single turn. Where Middle-Management and Housekeeping are cheap models surrounding an expensive
one, Upper-Management inverts the ratio — an **expensive model commanding a peon army of cheap ones** —
because architecture is the one task where deep reasoning pays for itself and the legwork (researching
options, drafting specs, exploring trade-offs) parallelizes across a swarm. It interrogates the user for a
complete technical, API, and architectural specification and produces a buildable plan the other two
caretakers then execute against.*

> **This caretaker is designed, not built.** There is no `src/` code for it today — `corpocode install`
> wires nothing for Upper-Management, and no hook invokes it. This chapter is its **charter**: a durable
> record of *what it is for* and *how it fits the existing substrate*, so the design has a home before the
> code does (the D tenet — document the decision before it lands). It is scheduled after the agent
> substrate of [chapter 06](06-intelligent-router.md) proves out, because it is built entirely on top of
> it.

---

## The inversion: spend on the design, not the typing

Every other part of CorpoCode exists to keep the expensive model *off* the cheap work. Upper-Management is
the deliberate exception. There is exactly one moment where a large model earns its cost: deciding the
shape of a system before a line of it is written — the choice of service boundaries, the data flow, the
seams that will or won't exist for the next two years. Getting that wrong is the most expensive mistake a
project can make, and no swarm of cheap models substitutes for one strong one reasoning over the whole.

So Upper-Management is an **executive** (a Provider pointed at a strong model) directing a **peon army**
(the [chapter 06](06-intelligent-router.md) fan-out of cheap agents). The executive decides *what to ask*
and *how to weigh the answers*; the army does the breadth — reading the existing code, researching each
option, drafting each section of the spec, surfacing each risk — all in parallel. The same
decompose-then-aggregate shape as every other caretaker, with the tiers of the pyramid simply flipped.

## What it produces: a complete specification

Upper-Management's deliverable is not code; it is a spec complete enough that Middle-Management can guide
the main model through building it. It gets there by **thoroughly interrogating the user** — not a single
prompt but a directed conversation — until it has, at minimum:

- **The technical and API spec** — entities, contracts, endpoints, data shapes: the precise surface the
  build will implement.
- **Expansion of current capabilities** — for an existing codebase, what is being added and how it grafts
  onto what already exists (grounded in the KnowledgeGraph, not imagined).
- **Future plans** — the features and updates the architecture must *not* foreclose, so today's seams
  survive tomorrow's roadmap.
- **Parallelization of the work** — which tasks are independent, so the build itself can fan out.
- **Compartmentalization of services** — the boundaries, each with one reason to change (the Atomicity
  tenet applied at the service grain).
- **The path to production scale** — what has to hold when the load is real, decided up front rather than
  retrofitted.
- **Reusable systems built once** — the shared substrate to factor out so it is written a single time and
  consumed everywhere (the same interface-not-implementation discipline that shapes [chapter 02](02-abstractions.md)).

It also **records major architectural flaws to memory** — a design-grade `MemoryStore` entry that protects
future decisions the way a `mistake` memory protects future edits, so a structural trap discovered once is
never walked into twice.

## It is already mostly built — as substrate

The reason Upper-Management can be deferred without risk is that almost everything it needs already exists
behind the four abstractions and the agent seam. The charter is mostly *composition*, not new
infrastructure:

| It needs | It reuses |
| --- | --- |
| an expensive executive model | a `Provider` pointed at a strong model — the registry already runs each component on its own provider ([chapter 02](02-abstractions.md)) |
| a cheap army doing breadth in parallel | the IntelligentRouter's bounded fan-out, judge, and synthesize ([chapter 06](06-intelligent-router.md)) |
| grounding in an existing codebase | `KnowledgeGraph.scoreFiles` / `query` to anchor "expand current capabilities" in real structure |
| reference material at the right depth | the tiered `ContextStore` (L0/L1/L2) for spec drafts and research |
| durable memory of architectural flaws | the `MemoryStore`, with a design-grade entry alongside `decision` / `mistake` / `rule` / `approach` |
| a way to reach the model | the same `additionalContext` channel and fail-open dispatcher every caretaker uses ([chapter 01](01-hook-engine.md)) |

What remains to build is the *executive logic* itself — the interrogation flow that knows which questions
remain unanswered, the plan producer that turns answers into an `OrchestrationPlan` for the army, and the
synthesis that assembles the spec — plus the surface that triggers it (a command, or a categorized
"design a system" moment). All of that is an action-pattern in the [chapter 06](06-intelligent-router.md)
sense: a small module that emits a plan the engine runs, not a new engine.

## Why it is shaped this way

- **Spend where it counts.** The whole rest of CorpoCode minimizes model cost; Upper-Management is the one
  place that deliberately spends, because a wrong architecture is costlier than any number of cheap calls.
- **Executive over army, not executive alone.** A strong model reasoning *and* doing all the legwork is
  slow and expensive; a strong model directing cheap agents that do the breadth keeps the deep reasoning
  scarce and the research wide.
- **Interrogate, don't assume.** A spec the user never confirmed is a guess; the value is in driving the
  conversation until the unknowns are closed — which is "the user disposes" applied to design itself.
- **Built on the substrate, deferred on purpose.** Shipping it before the agent layer is proven would mean
  building its army twice. Deferring it is the same infrastructure-first discipline that governs
  [chapter 06](06-intelligent-router.md) — and keeping the charter documented now is how the design stays
  coherent until the code arrives.
- **Memory of flaws is protective, like mistakes.** A `mistake` memory keeps the model from repeating an
  edit error; an architectural-flaw memory keeps a *design* from repeating a structural one — the same
  loop, one altitude up.

## How it will connect

When built, Upper-Management changes nothing about the contracts the rest of the suite relies on. It runs
as an action-pattern under the agent substrate, reaches the model only through `additionalContext`,
inherits the dispatcher's catch-all and timeout for free ([chapter 01](01-hook-engine.md)), and hands its
finished spec to Middle-Management to guide and Housekeeping to keep clean. The caretaker set is extensible
precisely so this third tier — and any future fourth — is an additive seam rather than a structural change.

## Invariants the build must honor

- **Reuse the substrate, don't fork it** — the army is the [chapter 06](06-intelligent-router.md) engine,
  the executive is a `Provider`, the memory is the `MemoryStore`. New infrastructure here is a smell.
- **Fail open** — even the executive tier degrades to doing nothing; a failed design pass must never break
  the host's turn.
- **The user disposes** — the spec is *proposed*; it becomes the plan only on the user's confirmation, the
  same bar that gates a git promotion or a skill.
- **Structure, not presentation** — the spec carries entities, contracts, and boundaries (meaning), never
  rendered markup, exactly as the one rule requires of every CorpoCode output.

---

*Continue to [chapter 06 — the IntelligentRouter](06-intelligent-router.md).*
