Use sequential thinking and superpowers continuously. Use typescript-lsp
# CorpoCode — Technical Implementation Specification

Target: a coding agent. Imperative requirements only. No rationale.

---

## 1. Summary

Build `corpocode`: a TypeScript npm package (CLI binary `corpocode`) that installs hooks into coding-agent platforms (Claude Code first) and runs cheap-LLM agents to read/inject context, verify code, manage git, and maintain memory, so the platform's main model only writes code.

- All logic lives in TypeScript behind `corpocode hook <name>`; installed hooks are thin shims that pipe stdin→`corpocode hook`→stdout.
- Components are grouped into **caretakers** (labels only): **Middle-Management** (session reader, categorizer, retrieval team, context injector, design-review team, model/effort selector), **Housekeeping** (verifier, doc generator, git manager, compactor, skill generator). **Upper-Management is out of scope for implementation** (no code this build).
- Four modular abstractions behind interfaces: `Provider`, `KnowledgeGraph`, `ContextStore`, `MemoryStore`. Consumers call interfaces only, never adapters.

---

## 2. Tech stack & build

- Node ≥ 20. TypeScript with `tsc --noEmit` for typecheck (no emit).
- Bundle with `esbuild` to a single `bin/corpocode.js` with a `#!/usr/bin/env node` shebang (no `node_modules` required at runtime).
- `package.json`: `"bin": { "corpocode": "./bin/corpocode.js" }`, `"engines": { "node": ">=20" }`.
- Tests: `vitest`. Releases: `semantic-release` on merge to main.
- npm deps: `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`, `ollama`, `zod`. graphify and OpenViking are external processes (not npm deps), provisioned by `corpocode install`.

---

## 3. Repository layout

```
src/
  index.ts
  cli.ts                         # arg parsing → command handlers
  hooks/
    envelope.ts                  # Zod schemas for hook stdin payloads
    dispatch.ts                  # hook name → handler; stdin→stdout
    response.ts                  # hookSpecificOutput / additionalContext builder
  session/
    reader.ts                    # SessionReader impl (transcript → line of thought)
    types.ts
  router/
    heuristics.ts                # stage-1 prefilter
    ranker.ts                    # stage-2 LLM ranker
    output-schema.ts             # Zod schema for ranker output
    effort.ts                    # selectModelEffort
  retrieval/
    worker.ts                    # dispatch: plan → fanout → aggregate
    planner.ts                   # build checklist from template + cues
    fanout.ts                    # Promise.all over items
    item-handler.ts              # one item → one abstraction call
    aggregator.ts                # deterministic merge
    templates/                   # one file per task type
      code-edit.ts code-gen.ts exploration.ts docs.ts config.ts
  filter/
    classify.ts                  # pre-tool classifier (deny/allow/ask)
    policies.ts                  # deny/allow/soft lists
    inject.ts                    # file-read interception + slice injection
  verifier/
    worker.ts                    # fan-out tenet checks
    aggregator.ts
    tenets/                      # one module per MOLAR-EDIT tenet
      maintainability.ts observability.ts logging.ts atomicity.ts
      responsiveness.ts extensibility.ts documentation.ts in-flight.ts testing.ts
  review/
    team.ts                      # design-review: one subagent per tenet
    aggregator.ts
  docs/
    generator.ts                 # DocGenerator impl
    types.ts
  git/
    manager.ts                   # GitManager orchestration
    trace.ts                     # per-write atomic commits
    promote.ts                   # squash trace → clean branch
    types.ts
  compactor/
    worker.ts                    # Stop-hook handler
    sliding-window.ts            # compute compactable region
    openviking.ts                # ContextStore write path at Stop
    memdir.ts                    # defensive fallback writer
  providers/
    types.ts                     # Provider + supporting types
    registry.ts                  # buildRegistry, forComponent
    pricing.ts                   # cost tables
    anthropic.ts google.ts openai.ts openrouter.ts ollama.ts
  backends/
    graph/
      types.ts registry.ts graphify-adapter.ts native.ts(stub)
    context/
      types.ts registry.ts openviking-adapter.ts native.ts(stub)
    memory/
      types.ts registry.ts native.ts
  config/
    schema.ts                    # Zod config schema
    load.ts                      # read+validate+env override
    paths.ts                     # cross-platform dirs
  log/
    ndjson.ts                    # append-only writer
  cost/
    tracker.ts                   # aggregate ChatOutput.costUsd
  install/
    claude-code.ts codex.ts opencode.ts cursor.ts gemini-cli.ts
    backends/
      graphify.ts openviking.ts
  loops/
    skillgen.ts
tests/
  providers/ backends/graph/ backends/context/ backends/memory/ ...
bin/corpocode.js                 # esbuild output
```

---

## 4. Configuration

### Paths
- Config: `~/.corpocode/config.json`. Resolve cross-platform in `config/paths.ts`: `XDG_CONFIG_HOME` (Linux), `~/Library/Application Support` (macOS), `%APPDATA%` (Windows).
- Secrets: `~/.corpocode/secrets` (chmod 600). `config.json` references keys by name; never inline secrets.
- Logs: `~/.corpocode/logs/corpocode.ndjson`.
- Memory: `~/.corpocode/memory/<project>.json` (+ sibling embeddings file).
- Env override: any field via flat `CORPOCODE_*` (e.g. `CORPOCODE_PROVIDERS_DEFAULT_MODEL`).

### Loading
`config/load.ts` reads, validates against `config/schema.ts` (Zod), applies env overrides, returns typed object. Components receive their config slice from the dispatcher; they never call `load.ts` directly.

Use sequential thinking and superpowers continuously.
Use typescript-lsp