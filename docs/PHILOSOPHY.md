# What CorpoCode is

CorpoCode is a layer of **cheap-model caretakers** that run inside another coding agent's loop (Claude
Code first) so the expensive main model can spend its budget on the one thing only it does well:
writing code. The caretakers read context, recommend, retrieve, verify, remember, and tidy up — each
as a small, single-purpose agent running on a cheap model, wired in through the host's hook system.

A coding agent that trusts a tool to inject context and reshape its file reads is trusting a great
deal, so CorpoCode is explained, not hidden. Two principles govern everything:

- **Fail open.** CorpoCode runs inside someone else's turn. Any error, hang, or missing dependency
  degrades to *doing nothing* — an empty response and a clean exit — never to disrupting the turn.
- **The user disposes.** CorpoCode proposes; durable, consequential changes stay under human control.
  Git promotions default to *suggest*; the review loop proposes config diffs it never applies; a skill
  candidate becomes a real skill only on an explicit `skillify --promote`; telemetry is opt-in and
  aggregate-only; delegation defaults to a recommendation.

## The three caretakers

- **Middle-Management** opens each turn: it reads the transcript's line of thought, categorizes the
  moment, scores the codebase, recalls prior decisions, retrieves precise context, and reviews the
  design at a breakpoint — injecting all of it as the model's opening context.
- **Housekeeping** runs during and after the work: the verifier checks each edit against the
  MOLAR-EDIT tenets, the git manager keeps an atomic trace history and a curated clean one, the
  compactor writes the session's lessons back into memory, and the doc generator documents finished
  code from the real call graph.
- **Upper-Management** is reserved for a later build.

## The four abstractions

Everything the caretakers do is built on four interfaces, so an implementation can be swapped without
touching a single consumer:

- **`Provider`** — the cheap-LLM boundary every model call passes through.
- **`KnowledgeGraph`** — the structural index (reference adapter: graphify).
- **`ContextStore`** — tiered reference material (reference adapter: OpenViking).
- **`MemoryStore`** — the experiential layer: decisions, mistakes, rules, approaches (native).

## MOLAR-EDIT

The verifier and the design-review team check work against nine tenets — **M**aintainability,
**O**bservability, **L**ogging, **A**tomicity, **R**esponsiveness, **E**xtensibility,
**D**ocumentation, **I**n-flight, **T**esting. Each tenet is one single-purpose check, fanned out in
parallel and aggregated deterministically; a community `corpocode-tenet-*` package can add more.
