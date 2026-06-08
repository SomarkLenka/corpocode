# CorpoCode

**A firm of cheap-model caretakers for your expensive coding agent.** The main model inside a coding
agent (Claude Code first) is a brilliant, costly developer who should be doing exactly one thing:
**writing code**. Deciding *what* to write, working out *how* to approach it, and cleaning up
*afterward* should not burn its time. CorpoCode hires a set of **three (extensible) caretakers** —
teams of small, cheap-model agents — to do all of that surrounding work, so the expensive model stays
on the keyboard.

All logic lives in TypeScript behind `corpocode hook <name>`; installed hooks are thin shims that pipe
`stdin → corpocode hook → stdout`. The main model never calls CorpoCode — it simply finds better
context, a cleaner repo, and fewer mistakes already in front of it. Everything CorpoCode produces
reaches the model through one channel: a hook's `additionalContext`.

The governing idea is **not a prompt *router* but a prompt *engine***. On each hook, a caretaker
**categorizes the moment it was invoked in, instantiates a team of independent, single-purpose
cheap-model agents to address whatever the main model might need, and aggregates their findings into
one tight injection** before the expensive model ever sees it. Extensive low-scope parallel passes,
merged — never one monolithic prompt. CorpoCode is **fail-open** throughout: any error, hang, or
missing dependency degrades to *doing nothing* — an empty response and a clean exit — never to
disrupting the host's turn. And it **proposes, the user disposes**: durable changes (git promotions,
config diffs, skill candidates, telemetry) stay under human control.

## The three caretakers

### Middle-Management — guides the developer

Opens every turn. It reads the transcript to understand intent, classifies the moment, and dispatches
a team of cheap agents to handle everything *except* the coding:

- **Review the current task** and decide each branch independently — what relevant skills to load, when
  to delegate work to a subagent, when a moment is a design **breakpoint**, exactly what to inject into
  context, and (designed) when to call an MCP on the side and sideload its output.
- **Find the relevant code, files, and docs** the prompt never named — scoring the codebase by
  structure, recalling prior decisions from memory, retrieving precise reference material — and inject
  them. It intercepts **file reads** to add focus and surface this file's past mistakes before the model
  touches it.
- At a design breakpoint, **instantiate MOLAR-EDIT** (the design philosophy) by spawning one low-cost
  reviewer per tenet — the set is configurable — and aggregate only the concerns.
- **Dynamic model and effort selection** — classify the difficulty of the task at hand and switch the
  model and effort to match, so an easy turn stays cheap and a hard one gets headroom.

The expensive model arrives already oriented.

### Housekeeping — cleans up after the developer

Runs during and after the work, in parallel, so cleanup never costs the main model a token:

- **Real-time documentation** straight from the real call graph — what each unit *touches*, its
  *impacts*, *risks*, and future considerations, and its *input → transformation → output* (structure,
  mutability, purpose). Documentation should be obvious, so Housekeeping makes it so.
- **Full git management** — atomic per-write commits to a bisectable *trace* branch, plus a curated,
  readable *clean* branch — taking version control off the valuable model's hands entirely.
- **Independent verification of functionality** — it periodically reviews functions and files against
  the MOLAR-EDIT tenets (In-flight, Logging, and Observability foremost) and can halt a violating edit.
- **Mining problems into memory and skills** — the mistakes the model hit become file-anchored warnings
  for next time, and recurring solutions become reusable skill candidates.

### Upper-Management — designs the whole application *(designed; no code yet)*

The executive tier: expensive models commanding a peon army of cheap ones to design *entire
applications*. It interrogates the user for complete technical, API, and architectural specs —
expansion of current capabilities, future features, task parallelization, service compartmentalization,
the path to scaling in production, and reusable systems built once — and records major architectural
flaws to memory. Fully specified; scheduled after the agent substrate proves out.

> The caretaker set is itself **extensible** — labels over a fan-out engine, not hardwired processes —
> so a fourth caretaker is an additive seam, not a rewrite.

## Install

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

### npm channel (standalone CLI; also the basis for other platforms)

```shell
npm install -g corpocode
corpocode install --platform claude-code    # register hooks + install agent/skill
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

Each component can run on a different provider (`config.components`), so you can run Middle-Management's
categorizer on Haiku and Housekeeping's compactor on a free local Ollama model.

## Debug

- **Logs.** Every hook appends one structured JSON line to a project-local `.corpocode/logs/corpocode.ndjson`
  in the directory the host runs in (gitignored). Inspect with `corpocode stats` (run from the same
  directory) or read the file directly. Logging never throws into a hook and can be disabled via
  `config.logging.enabled`.
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

Each caretaker is a **fan-out of low-scope cheap-model agents whose findings aggregate into one
injection** — the retrieval team plans a checklist and runs it concurrently; the design-review and
verifier teams run one agent per MOLAR-EDIT tenet; the compactor distills the session. That shared
shape rests on four modular abstractions behind interfaces; consumers call the interface, never the
adapter, so implementations swap without touching a consumer:

| Interface | Default implementation | Answers |
| --- | --- | --- |
| `Provider` | anthropic, anthropic-cli, google, openai, openrouter, ollama | "run a cheap model call" |
| `KnowledgeGraph` | native (TypeScript; graphify adapter optional) | "how is the code structured?" |
| `ContextStore` | native (embedded store + Provider tiering; OpenViking adapter optional) | "what reference material is relevant, at what depth?" |
| `MemoryStore` | native (no vendor) | "what have we learned and decided?" |

All three knowledge backends are native TypeScript, so the only hard dependency is the cheap models
behind `Provider`.

The flow per turn, by caretaker: on **`UserPromptSubmit`**, Middle-Management distills the line of
thought, graph-scores candidate files for free, classifies the moment with a single paid call, recalls
prior decisions, fans out the retrieval team, and runs a design-review at a breakpoint — injecting a
`<middle-management recommendation>` block plus its retrieved context. On **`PreToolUse`** it gives the
filter and injector teeth (deny a dangerous command, focus a file read). On **`PostToolUse`**,
Housekeeping's verifier fans out the active tenet checks and can halt a violating edit, recording each
write to the trace branch. On **`Stop`**, Housekeeping compacts the session into memory, promotes the
trace branch into the clean one, and documents the touched code. Everything reaches the model only as
hook `additionalContext`.

The **IntelligentRouter** is the agent substrate that upgrades these fan-outs from cheap *model calls*
to true *investigating agents* — agents that open files, call MCPs, and judge each other's output, so
the model receives a **conclusion** ("the bug is at `auth/session.ts:140`") rather than a reading list.
It is built infrastructure-first and **ships dark** (off by default) until each behavior is proven.

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
