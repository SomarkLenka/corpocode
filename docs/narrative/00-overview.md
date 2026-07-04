# CorpoCode — Narrative Documentation

This is the guided tour of CorpoCode: not an API reference, but the story of how the system is built
and *why* it is built that way. Read it top-to-bottom to understand the whole; jump to a numbered
chapter to go deep on one subsystem.

> If you want the one-screen pitch, read the root `README.md`. If you want the values behind the
> design — and the canonical mission statement every other doc defers to — read
> `docs/PHILOSOPHY.md`. This suite is the layer in between — the architecture, the flow, and the
> rationale, subsystem by subsystem. A doc that stops matching reality is fixed or deleted **in the
> same change that made it stale** — that covenant applies suite-wide.

## The suite

| # | Chapter | Covers |
| --- | --- | --- |
| 00 | **Overview** (this file) | The firm, the fan-out engine, the two control planes, the three caretakers, the governing principles |
| 01 | [The hook engine](01-hook-engine.md) | Process entry, dispatch, envelopes, context, response, the fail-open backstop, config, logging *(assist channel)* |
| 02 | [The abstractions](02-abstractions.md) | `Provider`, `KnowledgeGraph`, `ContextStore`, `MemoryStore` — the interface-not-implementation thesis |
| 03 | [Middle-Management](03-middle-management.md) | The caretaker that owns **implementation**: the swarm in orchestrator mode; the per-turn guide in hook mode |
| 04 | [Housekeeping](04-housekeeping.md) | The caretaker that **cleans up**: verify (MOLAR-EDIT), git trace/clean, documentation, compaction, skill mining |
| 05 | [Upper-Management](05-upper-management.md) | **The cockpit — the front door, built first**: pre-analyzed polls, teach-before-build, the spec artifact |
| 06 | [The IntelligentRouter](06-intelligent-router.md) | The agent substrate both modes fan out through — **live in orchestrator mode, dark in hook mode** |
| 07 | [Platform & operations](07-platform-and-ops.md) | Dual distribution, install per platform, doctor/stats, plugins, telemetry, the release pipeline |
| 08 | [The orchestrator](08-orchestrator.md) | **The run — the primary product**: engines as hands, the verification funnel, run state, CorpoCode as host |

The remaining-work spec for chapter 06 lives separately at `docs/INTELLIGENT-ROUTER-PHASES.md`. The
durable design decisions live as ADRs under `docs/adr/`.

---

## What CorpoCode is

*A swarm of cheap authors, one expensive judge, and a human in the cockpit.*

CorpoCode **simulates an expensive frontier coding model** with massive fan-outs of granular,
well-scoped cheap-model agents. The swarm does *all* the work — requirements, technical specs,
design, codebase navigation, bug hunting, and **the implementation itself: cheap agents write the
code**. The expensive model never authors anything; it **verifies only** — one arbiter that reads a
great deal and emits tiny verdicts, because input tokens are cheap and output tokens are expensive.
Coding platforms — Claude Code, Codex, OpenCode — are **interchangeable hands** behind the
`AgentBackend` seam. Authorship — every *what* and *why* — stays with the human, concentrated at
spec time in the Upper-Management cockpit ([chapter 05](05-upper-management.md)). The full mission
of record lives in [`docs/PHILOSOPHY.md`](../PHILOSOPHY.md).

## Two control planes

- **The orchestrator (primary — [chapter 08](08-orchestrator.md)).** `corpocode start "<task>"`
  drives the whole lifecycle: cockpit interrogation → frozen spec → implementation swarm through
  headless engine sessions → tiered verification → promotion. Here CorpoCode **is the host**: its
  gates may block its own worker engines, and the agent substrate runs live.
- **The assist channel (secondary — [chapter 01](01-hook-engine.md)).** The original hook mode:
  Claude Code fires a hook at each significant moment of a turn (`UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, …); each hook is a thin shim that pipes `stdin → corpocode hook <name> →
  stdout`, and everything CorpoCode produces reaches the host's model through one channel: the
  hook's `additionalContext`. Here CorpoCode runs inside *someone else's* turn and is **fail-open,
  always**. Its behavior is byte-identical whether or not the orchestrator exists — enforced
  structurally by tests (no hook-channel file may import orchestrator code or read its config).

## The fan-out engine, not a prompt router

The single idea that shapes every caretaker in both modes: **CorpoCode is a prompt *engine*, not a
prompt *router*.** A router would inspect the prompt and pick one template. An engine does something
larger — it **categorizes the moment it was invoked in, instantiates a team of independent,
single-purpose cheap-model agents to address whatever is needed, and aggregates their findings
deterministically** into artifacts the verifier can judge and the human can authorize. Extensive
low-scope parallel passes, merged — never one monolithic prompt and never one big model call.

This shape recurs everywhere, and recognizing it once explains most of the codebase. The cockpit
fans one consequence agent per option×axis of a decision fork; the retrieval team plans a checklist
of small questions and asks them all at once; the design-review and verifier teams run one cheap
agent per MOLAR-EDIT tenet; the documentation generator runs one pass per facet of a function. In
each case the work is *decomposed into atomic units, run concurrently on a cheap model, and
recombined deterministically* — so total latency is roughly a single unit rather than the sum, and
one dead unit degrades one finding rather than the whole answer.

## The principles, rescoped

Everything in this codebase is downstream of these commitments. When a design choice looks
surprising, it is almost always one of them being honored.

- **Fail open at the host boundary.** In the assist channel CorpoCode runs inside *someone else's
  turn*: any error, hang, or missing dependency must degrade to *doing nothing* — an empty `{}`
  response and a clean exit — never to disrupting the turn. Enforced structurally at the dispatcher
  (chapter 01; `docs/adr/0003-fail-open-hook-dispatch.md`).
- **Gates may block inside the airframe.** In orchestrator mode CorpoCode is the host: its
  verification gates, budget guards, and watchdogs may halt its own worker engines. Fail-open still
  binds at every boundary CorpoCode does not own — the user's checkout and branches are never
  mutated by a run, and landing is always an explicit human poll.
- **The user disposes — concentrated at spec time.** The cockpit polls every fork with pre-analyzed
  consequences ("nothing left to interpretation" is the correctness mechanism); after spec approval
  the swarm runs autonomously. Durable consequences — landing a run, promoting a skill, applying a
  config diff — remain explicit human decisions. Telemetry is opt-in and aggregate-only.

## The shape of a process

A fact that explains much of the hook-channel code: **every hook is a fresh `node` process.** Claude
Code spawns `corpocode hook <name>`, pipes the event in, reads the response out, and the process
exits. Nothing is held in memory between hooks. Every piece of continuity — the distilled "line of
thought," the last routing decision, accumulated memory, agent-session ids — is therefore persisted
to **disk** and re-read on the next hook. The orchestrator inherits the same discipline one level
up: a run's continuity lives in its artifacts (`spec.json`, `tasks.json`, `run.json`), so a paused
or crashed run resumes from checkpoints, not from anything in memory.

It is also why the binary is a single self-contained `esbuild` bundle (`bin/corpocode.js`) with no
runtime `node_modules`: a fresh process must start instantly and depend on nothing it cannot find.

## The three caretakers

The components are grouped — labels only, not processes — into three caretakers by the role they
play across the **project lifecycle**. The set is deliberately **extensible**: a caretaker is a
label over the fan-out engine, so a fourth is an additive seam, not a rewrite.

- **Upper-Management is the front door, built first** (chapter 05). The cockpit: a cheap
  interrogator agent and the human author a complete spec together — every decision fork
  pre-analyzed by a consequence fan-out, taught before it is asked, recorded in a decisions ledger.
  There is no strong-model executive; the arbiter is the only expensive component in the system.
- **Middle-Management owns the implementation** (chapter 03). In orchestrator mode: decompose the
  spec into granular, deterministically-verifiable tasks and fan out write-capable cheap agents
  through interchangeable engines in isolated worktrees. In the assist channel: the per-turn guide —
  categorize the moment, retrieve, design-review at a breakpoint, select model and effort.
- **Housekeeping cleans up after the swarm** (chapter 04). Git trace/clean hygiene, documentation
  from the real call graph, memory consolidation, skill mining, run and worktree cleanup.

## The agent substrate

The **IntelligentRouter** (chapter 06) is the engine that makes a caretaker's fan-out a team of true
*agents* rather than one-shot model calls — agents that read files, call MCPs, and are judged before
their findings survive. In orchestrator mode it is the **live execution substrate**: the cockpit's
consequence fan-out and the implementation swarm are its first consumers. In the hook channel it
stays **dark** (off by default, byte-identical with the flag off) until each behavior is proven.

## The abstractions

Everything the caretakers do rests on the interface-not-implementation discipline (chapter 02).
Consumers call the *interface*, never a concrete adapter, so an implementation can be swapped by a
single config word without touching a single consumer.

| Interface | Answers | Default |
| --- | --- | --- |
| `Provider` | "run a cheap model call" | anthropic-cli (keyless), + anthropic/google/openai/openrouter/ollama |
| `AgentBackend` | "run a cheap agent — the interchangeable hands" | anthropic-cli; agent-engine adapter for Codex/OpenCode |
| `KnowledgeGraph` | "how is the code structured?" | native TypeScript (graphify adapter optional) |
| `ContextStore` | "what reference material is relevant, at what depth?" | native (OpenViking adapter optional) |
| `MemoryStore` | "what have we learned and decided?" | native |

## The run, end to end (orchestrator mode)

1. **`corpocode start "<task>"`** → Upper-Management. The cockpit grounds itself in the code graph
   and memory, then interrogates: fork → consequence fan-out → pre-analyzed poll → ledger, section
   lamps amber→green, until the spec is complete and the pilot approves it.
2. **Decompose → waves** → Middle-Management. Task seeds become a validated task graph (every task
   carries a `verifyCommand`); write-capable cheap agents implement in isolated worktrees on
   `corpocode/run/<id>/*` branches.
3. **Verification** → the arbiter. Deterministic checks first, the cheap tenet screen second, and
   only surviving evidence reaches the one strong model — which emits a tiny verdict, never code.
   Cadence (`per-task` | `per-wave` | `final`) and mode (`gate` | `verify-rescue`) are config.
4. **Housekeeping** promotes trace → clean, documents, consolidates memory, cleans worktrees.
5. **The human lands it** — always an explicit poll, permanently never automatic.

## The turn, end to end (assist channel)

1. **`UserPromptSubmit`** → Middle-Management. The session reader distills the line of thought;
   stage-1 heuristics graph-score candidate files for free; the stage-2 ranker classifies the
   moment; memory recalls prior decisions; the retrieval team builds a context package; a
   design-review runs at a breakpoint. All of it is injected as a `<middle-management …>` block.
2. **`PreToolUse`** → Middle-Management. The filter classifies the tool call (allow / ask /
   **deny**); the injector intercepts file reads and adds graph-neighborhood context.
3. **`PostToolUse`** → Housekeeping. The verifier fans out the active MOLAR-EDIT tenets and can
   **block** a violating edit; the write is recorded to the git trace branch.
4. **`Stop`** → Housekeeping. The compactor slides the window, writes a tiered digest, consolidates
   the session into memory, promotes trace → clean, and documents the touched code.
5. **`SessionStart` / `SessionEnd`** → toolbox re-gating; agent-seam cleanup.

Nothing CorpoCode learns leaves the machine unless telemetry is explicitly enabled, and even then
only whitelisted aggregates.

---

*Continue to [chapter 01 — the hook engine](01-hook-engine.md), or jump to
[chapter 05 — the cockpit](05-upper-management.md) and [chapter 08 — the orchestrator](08-orchestrator.md)
for the primary mode.*
