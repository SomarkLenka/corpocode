# CorpoCode

**A swarm of cheap authors, one expensive judge, and a human in the cockpit.**

<!-- copied from docs/PHILOSOPHY.md (MISSION block) — edit there, then mirror here -->
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

## Two modes

- **Orchestrator (primary — landing now, cockpit first).** `corpocode start "<task>"` drives a
  whole engagement: the cockpit interrogates intent into a complete spec, a swarm of cheap
  write-capable agents implements it through headless engine sessions on CorpoCode-owned
  branches, a single expensive **arbiter** verifies (tiny verdicts, never code), and Housekeeping
  promotes a clean branch. Landing on *your* branch is always an explicit poll. On release
  builds, `corpocode start` is gated behind `corpocode init` onboarding (arbiter model, poll
  granularity, budget).
- **Assist channel (hook mode — shipped, supported, secondary).** CorpoCode installs hooks into a
  coding-agent platform and its caretakers guide/clean up whatever model the host runs, reaching
  it only through a hook's `additionalContext`. This mode stays **fail-open**: any error degrades
  to doing nothing, never to a broken turn — and its behavior is byte-identical whether or not
  the orchestrator exists (enforced by tests).

The governing mechanism in both modes is the same: **a prompt *engine*, not a prompt *router***.
Categorize the moment, instantiate a team of independent, single-purpose cheap-model agents, and
aggregate their findings deterministically — extensive low-scope parallel passes, merged; never
one monolithic prompt, and never one big model call.

## The three caretakers, on the project lifecycle

### Upper-Management — the cockpit, the front door *(built first)*

Every engagement begins here. A cheap interrogator agent drives a directed conversation over the
seven spec areas (API/entities, capability expansion grounded in the code graph, future seams,
parallelization, compartmentalization, scale path, reusable systems); every decision fork is
**pre-analyzed by a fan-out of consequence agents** (one per option × axis — performance,
maintainability, extensibility, failure modes, idiom) so the human picks from a computed tree
instead of answering open questions. It teaches before it builds, adapts its question set to the
pilot via a per-concept mastery model, and never silently guesses — every fork is answered,
delegated (recorded), or defaulted (recorded). Deliverables: `spec.json` (+ derived `spec.md`),
a decisions ledger, and a `tasks.json` executable with superpowers-equipped Claude Code today.
There is **no strong-model executive** — the arbiter is the only expensive component in the
entire system. superpowers' brainstorming/writing-plans content is harvested as the v0 prompts
(vendored and version-pinned), to be absorbed by a native spine.

### Middle-Management — owns the implementation

In orchestrator mode it decomposes the approved spec into granular tasks — each with a
deterministic `verifyCommand` by construction — and fans out write-capable cheap agents through
interchangeable engines, in isolated worktrees on `corpocode/run/<id>/*` branches. In the assist
channel it remains the per-turn guide: it reads the transcript's line of thought, classifies the
moment, retrieves the relevant code and prior decisions, design-reviews at a breakpoint, and
selects model/effort to match difficulty.

### Housekeeping — cleans up after the swarm

Git hygiene (atomic per-write trace commits, promotion to a curated clean branch), real-time
documentation from the actual call graph, memory consolidation (mistakes become file-anchored
warnings; recurring solutions become skill candidates), and run/worktree cleanup. Many cheap
hands make many small messes — cleanup matters more here, not less.

> The caretaker set is itself **extensible** — labels over a fan-out engine, not hardwired
> processes — so a fourth caretaker is an additive seam, not a rewrite.

## Install (assist channel)

[`corpocode`](https://www.npmjs.com/package/corpocode) is a single npm package that is **both** a global
CLI and a Claude Code plugin. Pick **one** channel — using both on the same platform fires every hook
twice (`corpocode doctor` warns if it detects both).

### Plugin channel (recommended for Claude Code)

```shell
/plugin marketplace add https://github.com/SomarkLenka/corpocode   # add the marketplace
/plugin install corpocode@corpocode                                # install the plugin
/corpocode:corpocode-setup                                         # verify it's active (native backends need no provisioning)
```

Use the HTTPS URL above — the `owner/repo` shorthand can resolve to SSH and fail with a publickey
error. Versioned updates come via `/plugin update`, it uninstalls cleanly, and it never touches your
`settings.json`.

### npm channel (standalone CLI; also the basis for other platforms and the orchestrator)

```shell
npm install -g corpocode
corpocode install --platform claude-code    # register hooks + install agent/skill (assist channel)
corpocode doctor                            # verify
```

`install` is idempotent and supports `--dry-run` (print the plan, change nothing), `--skip-backends`
(register hooks only), and `--repair` (regenerate derived files). All of CorpoCode's durable state —
config, logs, memory — lives under `~/.corpocode/` (resolved per-platform), outside Claude Code's
plugin cache, so reinstalling never disturbs it.

### From source (contributors)

```shell
npm install && npm run build && npm install -g .   # or `npm link` for active development
```

## Operate

```shell
corpocode start "<task>"  # the orchestrator: cockpit → spec (swarm execution lands next)
corpocode doctor          # ordered health checks; every red check prints its repair command
corpocode stats           # cost per component/provider, estimated savings, error rate
corpocode stats --json --days 7
corpocode provision       # only if you opt into the Python backends (graphify, OpenViking); native needs none
corpocode uninstall       # remove shims + unregister hooks (--purge also removes ~/.corpocode)
```

Configuration lives at `~/.corpocode/config.json` and is validated against a Zod schema on load.
Secrets live separately at `~/.corpocode/secrets` (chmod 600); the config references keys by name.
Any field can be overridden by a flat `CORPOCODE_*` environment variable, e.g.
`CORPOCODE_PROVIDERS_DEFAULT_MODEL=claude-haiku-4-5`.

Each component can run on a different provider (`config.components`), so you can run the cockpit's
interrogator on Haiku, the compactor on a free local Ollama model — and the **arbiter** (the one
deliberately expensive component) on a frontier model.

## Debug

- **Logs.** Every hook appends one structured JSON line to a project-local `.corpocode/logs/corpocode.ndjson`
  in the directory the host runs in (gitignored); orchestrator runs journal into
  `.corpocode/runs/<runId>/` through the same seam. Inspect with `corpocode stats` / `corpocode why`
  (run from the same directory) or read the file directly. Logging never throws into a hook and can
  be disabled via `config.logging.enabled`.
- **Trace a failing hook.** Set `CORPOCODE_DEBUG=1`; on any fail-open path the dispatcher writes the
  error (with stack) to stderr. stderr on a 0-exit hook is shown by the host but does not break the
  turn.
- **Degraded mode.** Before the native graph is built (it builds in-process on first use), file scoring
  falls back to a string-overlap heuristic — by design. `corpocode doctor` tells you what is and isn't
  healthy.

## Rollback

- npm channel: `corpocode uninstall` removes the shims and unregisters the hooks (your other
  settings are preserved). Add `--purge` to also delete `~/.corpocode`.
- plugin channel: `/plugin uninstall corpocode@corpocode`.

Because state lives under `~/.corpocode/`, uninstalling or downgrading never loses your config or
accumulated memory.

## Architecture (one screen)

Each caretaker is a **fan-out of low-scope cheap-model agents whose findings aggregate
deterministically** — the cockpit runs one consequence agent per option×axis; the retrieval team
plans a checklist and runs it concurrently; the design-review and verifier teams run one agent per
MOLAR-EDIT tenet; the compactor distills the session. That shared shape rests on five modular
abstractions behind interfaces; consumers call the interface, never the adapter, so implementations
swap without touching a consumer:

| Interface | Default implementation | Answers |
| --- | --- | --- |
| `Provider` | anthropic, anthropic-cli, google, openai, openrouter, ollama | "run a cheap model call" |
| `AgentBackend` | anthropic-cli (headless `claude`); agent-engine adapter for Codex/OpenCode | "run a cheap *agent* — the interchangeable hands" |
| `KnowledgeGraph` | native (TypeScript; graphify adapter optional) | "how is the code structured?" |
| `ContextStore` | native (embedded store + Provider tiering; OpenViking adapter optional) | "what reference material is relevant, at what depth?" |
| `MemoryStore` | native (no vendor) | "what have we learned and decided?" |

All three knowledge backends are native TypeScript, so the only hard dependency is the cheap models
behind `Provider`/`AgentBackend`.

**The orchestrator run** (`docs/narrative/08`): cockpit interrogation → frozen `spec.json` +
`tasks.json` → implementation waves in isolated worktrees → tiered verification (deterministic
`verifyCommand` → cheap tenet screen → arbiter verdict) → promotion to a clean branch → the human
lands it. **The assist-channel turn** (`docs/narrative/00`): on `UserPromptSubmit`
Middle-Management distills the line of thought, classifies the moment, recalls prior decisions,
fans out the retrieval team, and injects one `<middle-management recommendation>` block; on
`PreToolUse` the filter and injector act; on `PostToolUse` the verifier checks each edit; on `Stop`
the compactor writes the session's lessons into memory.

The **IntelligentRouter** is the agent substrate both modes fan out through — agents that open
files, call MCPs, and judge each other's output, so the *verifier* receives evidence and the swarm
receives direction rather than a reading list. It runs **live in orchestrator mode** (it is the
execution substrate) and stays **dark in hook mode** (off by default, byte-identical with the flag
off) until each hook-channel behavior is proven.

For the full guided tour — the architecture, the per-turn flow, and the rationale subsystem by
subsystem — read the narrative documentation in [`docs/narrative/`](docs/narrative/00-overview.md). See
the rest of `docs/` for the design spec, the phase plans, and the architecture decision records.

## Develop

```shell
npm run build        # esbuild → bin/corpocode.js (single self-contained file)
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest
npm run verify       # build + typecheck + test (run before "done")
```
