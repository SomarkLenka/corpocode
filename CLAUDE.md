Use sequential thinking and superpowers continuously. Use typescript-lsp
# CorpoCode — Standing Build Instruction

Target: a coding agent. Imperative requirements only. Rationale lives in `docs/PHILOSOPHY.md`
(the canonical mission) and `docs/narrative/` (the guided tour). If this file and those docs
disagree, this file is stale — fix it in the same change.

---

## 1. Mission and build posture

*A swarm of cheap authors, one expensive judge, and a human in the cockpit.*

`corpocode` **simulates an expensive frontier coding model** with massive fan-outs of granular,
well-scoped cheap-model agents. The swarm does **all** the work — requirements, technical specs,
design, codebase navigation, bug hunting, and **the implementation itself: cheap agents write the
code**. The expensive model never authors anything; it **verifies only** — one arbiter role that
reads a great deal and emits tiny verdicts. Economics: input tokens are cheap, output tokens are
expensive (speculative decoding, scaled to agents). Coding platforms — Claude Code, Codex,
OpenCode — are **interchangeable hands** (headless engine sessions behind `AgentBackend`).
Authorship — every *what* and *why* — stays with the human, concentrated at spec time in the
Upper-Management cockpit. Full statement: `docs/PHILOSOPHY.md` (MISSION block).

Build posture (current):

- **Two modes, orchestrator first.** The primary product is the standalone orchestrator:
  `corpocode start "<task>"` drives cockpit interrogation → spec → cheap implementation swarm →
  arbiter verification → housekeeping promotion. The original **hook mode** (thin shims piping
  stdin→`corpocode hook <name>`→stdout, output only via `additionalContext`) is the secondary
  assist channel: frozen-but-supported, must never regress. `agents.enabled` stays default-false
  for the hook channel only; orchestrator commands construct the agent registry unconditionally.
- **Upper-Management is built FIRST and is the front door.** UM is the cockpit
  (`docs/narrative/05-upper-management.md`): poll-every-fork spec interrogation with
  pre-analyzed trade-offs (one cheap agent per option×consequence-axis), teach-before-build, a
  per-concept mastery model. Human decisions concentrate at spec time; the swarm executes
  autonomously afterward. Middle-Management owns the implementation phase; Housekeeping cleans
  up artifacts. The superpowers plugin's brainstorming/writing-plans content is **harvested as
  UM v0** (vendored, version-pinned prompt text; never a runtime plugin dependency), absorbed by
  a native spine later.
- **Verification cadence is a config knob** (`orchestrator.verify.cadence`: per-task | per-wave |
  final; mode: gate | verify-rescue), experimentally tuned — never hardcoded.
- **Release gate:** all orchestrator functionality is gated behind `corpocode init` onboarding
  (arbiter model, poll granularity, budget). Local testing bypass: `CORPOCODE_DEV=1` or `--dev`
  (defaults: arbiter `claude-fable-5`, granularity `every-fork`, budget uncapped).

Hard prohibitions (never re-litigate; recorded in the reframe decision):

- No strong-model "executive": a **cheap** interrogator agent + human answers author the spec.
  The **arbiter is the only strong-model component** in the entire system.
- The arbiter never authors code or tests (cheap agents author tests from the arbiter's prose
  description). No `allow_direct_patch` knob, in any form.
- Landing on the user's branch is always an explicit human poll — never automatic.
- Caretakers stay labels over the fan-out engine, never processes.

## 2. Principles, rescoped

- **Fail open at the host boundary.** In hook mode CorpoCode runs inside someone else's turn:
  any error, hang, or missing dependency degrades to `{}` + exit 0, never a broken turn.
- **Gates may block inside the airframe.** In orchestrator mode CorpoCode IS the host: its
  verification gates and budget guards may block its own worker engines. Fail-open still binds
  wherever CorpoCode touches anything it does not own (the user's checkout, the user's branch).
- **The user disposes — concentrated at spec time.** The cockpit polls every fork (granularity
  dialable); after spec approval the swarm runs autonomously. Durable consequences (landing,
  skill promotion, config diffs) remain explicit human polls.
- **Interfaces, never adapters.** Consumers call `Provider`, `KnowledgeGraph`, `ContextStore`,
  `MemoryStore`, `AgentBackend` — never a concrete implementation.
- **No test invokes a real model.** Every model boundary is faked through the AgentBackend /
  Provider seams (ADR-0001).

## 3. Tech stack & build

- Node ≥ 20. TypeScript with `tsc --noEmit` for typecheck (no emit).
- Bundle with `esbuild` to a single `bin/corpocode.js` with a `#!/usr/bin/env node` shebang (no
  `node_modules` required at runtime).
- `package.json`: `"bin": { "corpocode": "./bin/corpocode.js" }`, `"engines": { "node": ">=20" }`.
- Tests: `vitest`. Releases: `semantic-release` on merge to main.
- npm deps: `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`, `ollama`, `zod`. graphify and
  OpenViking are optional external processes (not npm deps), provisioned by `corpocode provision`;
  the native TypeScript backends are the defaults and need no provisioning.
- `npm run verify` = build + typecheck + tests; run before declaring anything done. It includes
  the mission-drift lint (`scripts/check-mission.mjs`), the hook-mode parity suite, and the
  hooks→orchestrator import-ban test once those land.

## 4. Repository layout

```
src/
  index.ts  cli.ts  cli-commands.ts   # COMMANDS array = single source for help + docs
  commands/                           # one module per CLI command (pure core + thin IO wrapper)
  hooks/                              # hook-mode dispatch/envelope/response/context (assist channel)
  agents/                             # AgentBackend seam + anthropic-cli / agent-engine backends,
                                      #   disk-backed agent sessions, registry
  intelligence/                       # gather / engine.run (bounded fan-out + judge) / synthesize /
                                      #   router-router — the agent substrate both modes share
  um/                (planned)        # the cockpit: interrogator state machine, loop, consequence
                                      #   fan-out, poll-synth, spec-schema, mastery, harvest/*
  interact/          (planned)        # Interactor seam: terminal / scripted / web (first
                                      #   interactive surface in the codebase)
  orchestrator/      (Phase 2 built)  # run, budget, context, decompose, waves, workspace (worktrees),
                                      #   swarm (leases + caps), verify-mechanical, depgate, sanitize,
                                      #   critic, land (merge-train), report — `corpocode build` entry.
                                      #   verify (arbiter) still Phase 3. NEVER src/cockpit/
  session/  router/  retrieval/  filter/  verifier/  review/  molar/   # hook-mode caretaker teams
  docs/  git/  compactor/  loops/  toolbox/                            # housekeeping components
  providers/                          # Provider impls: anthropic, anthropic-cli (keyless),
                                      #   google, openai, openrouter, ollama; effort, pricing
  backends/                           # graph/ context/ memory/ (native defaults + optional adapters)
  config/                             # schema.ts (Zod; every block .default()), load.ts, paths.ts
                                      #   (single source of ALL on-disk locations), secrets, env
  prompts/                            # BUILTIN_PROMPTS + local→global→built-in resolver
  log/  cost/  perf/  monitor/  telemetry/  docs-site/  plugins/  install/  types/
tests/                                # mirrors src/; fake backends, conformance suites
bin/corpocode.js                      # esbuild output
docs/                                 # PHILOSOPHY (mission), narrative/00-08, adr/, phase plans
.corpocode/ (project-local state)     # logs, memory, sessions/<id>/, agent-sessions/,
                                      #   runs/<runId>/ (planned: spec.json, tasks.json, journal)
```

## 5. Configuration

### Paths
- Config: `~/.corpocode/config.json`. Global state (config + secrets) lives in a `.corpocode`
  dotfolder in the user's home directory on every OS (e.g. `C:\Users\you\.corpocode` on Windows),
  resolved in `config/paths.ts`; `CORPOCODE_HOME` overrides it. Project-local state (logs,
  memory, sessions, runs) lives in `./.corpocode`.
- Secrets: `~/.corpocode/secrets` (chmod 600). `config.json` references keys by name; never
  inline secrets.
- Logs: project-local `.corpocode/logs/corpocode.ndjson` (+ flow log), written through the
  Logger seam (`src/log/ndjson.ts`) so `corpocode why`/`monitor` narrate everything for free.
- Memory: `~/.corpocode/memory/<project>.json` (+ sibling embeddings file). Mastery-kind records
  are global (CORPOCODE_HOME-scoped), not per-project.
- Env override: any field via flat `CORPOCODE_*` (e.g. `CORPOCODE_PROVIDERS_DEFAULT_MODEL`).

### Loading
`config/load.ts` reads, validates against `config/schema.ts` (Zod), applies env overrides,
returns typed object. `configSchema.parse({})` must always yield a complete valid config (every
block carries `.default()`). Components receive their config slice from their entry point; they
never call `load.ts` directly.

Use sequential thinking and superpowers continuously.
Use typescript-lsp
