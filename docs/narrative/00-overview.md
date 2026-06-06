# CorpoCode — Narrative Documentation

This is the guided tour of CorpoCode: not an API reference, but the story of how the system is built
and *why* it is built that way. Read it top-to-bottom to understand the whole; jump to a numbered
chapter to go deep on one subsystem.

> If you want the one-screen pitch, read the root `README.md`. If you want the values behind the
> design, read `docs/PHILOSOPHY.md`. This suite is the layer in between — the architecture, the flow,
> and the rationale, subsystem by subsystem.

## The suite

| # | Chapter | Covers |
| --- | --- | --- |
| 00 | **Overview** (this file) | The system model, the hook lifecycle, the caretaker structure, the two governing principles |
| 01 | [The hook engine](01-hook-engine.md) | Process entry, dispatch, envelopes, context, response, the fail-open backstop, config, logging |
| 02 | [The four abstractions](02-abstractions.md) | `Provider`, `KnowledgeGraph`, `ContextStore`, `MemoryStore` — the interface-not-implementation thesis |
| 03 | [Middle-Management](03-middle-management.md) | The per-turn context pipeline: session reader, router, retrieval, filter, review, toolbox, prompts |
| 04 | [Housekeeping](04-housekeeping.md) | Verify (MOLAR-EDIT), git trace/clean branches, compaction, documentation, skill mining |
| 05 | [The IntelligentRouter](05-intelligent-router.md) | The agent seam + plan-driven orchestration (the active major build) |
| 06 | [Platform & operations](06-platform-and-ops.md) | Dual distribution, install per platform, doctor/stats, plugins, telemetry, the release pipeline |

The remaining-work spec for chapter 05 lives separately at `docs/INTELLIGENT-ROUTER-PHASES.md`. The
durable design decisions live as ADRs under `docs/adr/`.

---

## What CorpoCode is

CorpoCode is a layer of **cheap-model caretakers** that run inside another coding agent's loop — Claude
Code first. The expensive main model is good at exactly one thing: writing code. Everything around that
— reading the transcript to understand intent, finding the relevant files, recalling what was already
decided, verifying an edit, keeping git tidy, documenting finished work — is delegated to small,
single-purpose agents running on cheap models. CorpoCode is where those caretakers live.

It plugs in through the host's **hook system**. Claude Code fires a hook at each significant moment of a
turn (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, …); each hook is a thin shim that pipes
`stdin → corpocode hook <name> → stdout`. CorpoCode reads the event, does its low-cost work, and returns
context for the model through one channel: the hook's `additionalContext`. The main model never calls
CorpoCode directly — it simply finds better context already in front of it.

## Two principles govern everything

Everything in this codebase is downstream of two commitments. When a design choice looks surprising,
it is almost always one of these two being honored.

- **Fail open.** CorpoCode runs inside *someone else's turn*. Any error, hang, or missing dependency
  must degrade to *doing nothing* — an empty `{}` response and a clean exit — never to disrupting the
  turn. This is the single most important property of the system. It is enforced structurally at the
  dispatcher (a catch-all plus an overall timeout — chapter 01) so that every component below is free
  to throw on genuinely exceptional input rather than inventing half-broken return values. See
  `docs/adr/0003-fail-open-hook-dispatch.md`.
- **The user disposes.** CorpoCode *proposes*; consequential, durable changes stay under human control.
  Git promotions default to *suggest*; the review loop proposes config diffs it never applies; a skill
  candidate becomes a real skill only on an explicit promote; telemetry is opt-in and aggregate-only;
  subagent delegation defaults to a recommendation. The agent-orchestration layer (chapter 05) ships
  *dark* — off by default — for the same reason.

## The shape of a process

A fact that explains much of the code: **every hook is a fresh `node` process.** Claude Code spawns
`corpocode hook <name>`, pipes the event in, reads the response out, and the process exits. Nothing is
held in memory between hooks. Every piece of continuity — the distilled "line of thought," the last
routing decision, accumulated memory, agent-session ids — is therefore persisted to **disk** and re-read
on the next hook. This is why you will see a session cache, a decision cache, a flow-log cursor, and an
agent-session store rather than long-lived objects: there is no long-lived anything.

It is also why the binary is a single self-contained `esbuild` bundle (`bin/corpocode.js`) with no
runtime `node_modules`: a fresh process must start instantly and depend on nothing it cannot find.

## The three caretakers

The components are grouped — labels only, not processes — into three caretakers by *when* they run.

- **Middle-Management** opens each turn (chapter 03). On `UserPromptSubmit` it reads the transcript's
  line of thought, categorizes the moment, scores the codebase for relevant files, recalls prior
  decisions, retrieves precise reference context, and reviews the design at a breakpoint — injecting all
  of it as the model's opening context. On `PreToolUse` its filter can deny a dangerous command and its
  injector reshapes file reads.
- **Housekeeping** runs during and after the work (chapter 04). On `PostToolUse` the verifier checks
  each edit against the MOLAR-EDIT tenets and can halt a violating one; each write is recorded to an
  atomic git *trace* branch. On `Stop` the compactor writes the session's lessons back into memory,
  promotes the trace branch into a curated *clean* one, and documents finished code from the real call
  graph.
- **Upper-Management** is reserved for a later build — no code yet.

The **IntelligentRouter** (chapter 05) is the newest layer: a private workspace where, on a hook,
CorpoCode can fan out low-cost agents to actively investigate (read files, call MCPs, review code),
judge their output, and synthesize one tight injection — so the main model receives a conclusion ("the
bug is at `auth/session.ts:140`") instead of a pile of files to open. It is being built infrastructure
first; it ships dark until each concrete behavior is proven.

## The four abstractions

Everything the caretakers do rests on four interfaces (chapter 02). Consumers call the *interface*,
never a concrete adapter, so an implementation can be swapped by a single config word without touching a
single consumer. That discipline is the spine of the project: it let early phases ship fast on borrowed
tools and a later phase replace the entire knowledge substrate with native TypeScript, invisibly.

| Interface | Answers | Default |
| --- | --- | --- |
| `Provider` | "run a cheap model call" | anthropic-cli (keyless), + anthropic/google/openai/openrouter/ollama |
| `KnowledgeGraph` | "how is the code structured?" | native TypeScript (graphify adapter optional) |
| `ContextStore` | "what reference material is relevant, at what depth?" | native (OpenViking adapter optional) |
| `MemoryStore` | "what have we learned and decided?" | native |

## The turn, end to end

One pass through a turn, naming the caretaker at each beat:

1. **`UserPromptSubmit`** → Middle-Management. The session reader distills the line of thought; stage-1
   heuristics graph-score candidate files for free; the stage-2 ranker classifies the moment; memory
   recalls prior decisions; the retrieval team builds a context package; a design-review runs at a
   breakpoint. All of it is injected as a `<middle-management …>` block.
2. **`PreToolUse`** → Middle-Management. The filter classifies the tool call (allow / ask / **deny**);
   the injector intercepts file reads and adds graph-neighborhood context.
3. **`PostToolUse`** → Housekeeping. The verifier fans out the active MOLAR-EDIT tenets and can **block**
   a violating edit; the write is recorded to the git trace branch.
4. **`Stop`** → Housekeeping. The compactor slides the window, writes a tiered digest, consolidates the
   session into memory, promotes trace → clean, and documents the touched code.
5. **`SessionStart` / `SessionEnd`** → toolbox re-gating; agent-seam cleanup.

Everything reaches the model only as hook `additionalContext`. Nothing CorpoCode learns leaves the
machine unless telemetry is explicitly enabled, and even then only whitelisted aggregates.

---

*Continue to [chapter 01 — the hook engine](01-hook-engine.md).*
