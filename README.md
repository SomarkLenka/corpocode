# CorpoCode

Cheap-model **caretakers** for coding agents. CorpoCode installs hooks into a coding-agent platform
(Claude Code first) and runs cheap-LLM agents to read context, recommend, verify, and remember — so
the platform's main (expensive) model spends its time writing code, not re-deriving context.

All logic lives in TypeScript behind `corpocode hook <name>`; installed hooks are thin shims that
pipe `stdin → corpocode hook → stdout`.

> **Phase 1 scope.** This build is the foundation and the nervous system: on every turn CorpoCode
> reads the session transcript, scores the codebase for relevant files, recalls prior decisions, and
> injects a single **advisory** recommendation block — and nothing more. The filter and verifier run
> in log-only mode. Nothing CorpoCode does can alter what the host model does yet; that arrives in
> Phase 2. The guiding property is **fail-open**: a buggy or failing CorpoCode degrades to doing
> nothing, never to disrupting the host turn.

## Install

> **Status: unpublished.** CorpoCode is not yet on npm or in a hosted Claude Code marketplace, so
> install **from this checkout** (below). The published one-liners that follow only work once the
> release pipeline has run — which needs the real repository URL and npm/GitHub tokens (see
> `docs/PHASE4-ACCEPTANCE.md`). Until then, `/plugin marketplace add corpocode/corpocode` and
> `npm install -g corpocode` will fail, because neither target exists yet.

CorpoCode is a single npm package that is **both** a global CLI and a Claude Code plugin. Pick **one**
channel — using both on the same platform fires every hook twice (`corpocode doctor` warns if it
detects both).

### From source — works today

```shell
npm install                                 # dev dependencies
npm run build                               # esbuild → bin/corpocode.js (single self-contained file)
npm install -g .                            # put `corpocode` on your PATH (or `npm link` for active dev)
corpocode install --platform claude-code    # register hooks + install agent/skill
corpocode doctor                            # verify the install
```

This is the **npm channel**: it registers hooks in Claude Code's `settings.json`. With the default
native backends there is nothing external to provision. `install` is idempotent and supports
`--dry-run` (print the plan, change nothing), `--skip-backends` (register hooks only), and `--repair`
(regenerate derived files).

### Published channels — after release

```shell
# npm CLI
npm install -g corpocode
corpocode install --platform claude-code

# …or the Claude Code plugin. Use an HTTPS URL or a local path: the `owner/repo` shorthand can
# resolve to SSH and fail with a publickey error.
/plugin marketplace add https://github.com/<owner>/corpocode
/plugin install corpocode@corpocode
/corpocode:setup                            # provision + health-check
```

The marketplace entry (`.claude-plugin/marketplace.json`) declares the plugin with an `npm` source, so
`/plugin install` fetches the published `corpocode` package — it resolves only **after** `npm publish`.
For local testing before then, use the **From source** path above (the npm CLI channel).

All of CorpoCode's durable state — config, logs, memory — lives under `~/.corpocode/` (resolved
per-platform), which sits outside Claude Code's plugin cache, so reinstalling never disturbs it.

## Operate

```shell
corpocode doctor          # ordered health checks; every red check prints its repair command
corpocode stats           # cost per component/provider, estimated savings, error rate
corpocode stats --json --days 7
corpocode provision       # (re)install + start the backends (graphify, OpenViking)
corpocode uninstall       # remove shims + unregister hooks (--purge also removes ~/.corpocode)
```

Configuration lives at `~/.corpocode/config.json` and is validated against a Zod schema on load.
Secrets live separately at `~/.corpocode/secrets` (chmod 600); the config references keys by name.
Any field can be overridden by a flat `CORPOCODE_*` environment variable, e.g.
`CORPOCODE_PROVIDERS_DEFAULT_MODEL=claude-haiku-4-5`.

Each component can run on a different provider (`config.components`), so you can run the categorizer
on Haiku and a future compactor on a free local Ollama model.

## Debug

- **Logs.** Every hook appends one structured JSON line to `~/.corpocode/logs/corpocode.ndjson`.
  Inspect with `corpocode stats` or read the file directly. Logging never throws into a hook and can
  be disabled via `config.logging.enabled`.
- **Trace a failing hook.** Set `CORPOCODE_DEBUG=1`; on any fail-open path the dispatcher writes the
  error (with stack) to stderr. stderr on a 0-exit hook is shown by the host but does not break the
  turn.
- **Degraded mode.** Before the graph is built (or if graphify is down), file scoring falls back to a
  string-overlap heuristic — by design. `corpocode doctor` tells you what is and isn't healthy.

## Rollback

- npm channel: `corpocode uninstall` removes the shims and unregisters the hooks (your other
  settings are preserved). Add `--purge` to also delete `~/.corpocode`.
- plugin channel: `/plugin uninstall corpocode@corpocode`.

Because state lives under `~/.corpocode/`, uninstalling or downgrading never loses your config or
accumulated memory.

## Architecture (one screen)

Four modular abstractions sit behind interfaces; consumers call the interface, never the adapter, so
the planned native implementations are a mechanical swap:

| Interface | Phase 1 implementation | Answers |
| --- | --- | --- |
| `Provider` | anthropic, anthropic-cli, google, openai, openrouter, ollama | "run a cheap model call" |
| `KnowledgeGraph` | graphify adapter (MCP over stdio) | "how is the code structured?" |
| `ContextStore` | OpenViking adapter (declared; data path is Phase 2) | "what reference material is relevant, at what depth?" |
| `MemoryStore` | native (no vendor) | "what have we learned and decided?" |

The flow per turn: `UserPromptSubmit` → session reader distills the line of thought → stage-1
heuristics (free) graph-score candidate files → stage-2 ranker classifies the moment → recall prior
decisions → inject a `<middle-management recommendation>` block. `PreToolUse`/`PostToolUse` run the
filter/verifier in log-only mode. Everything reaches the model only as hook `additionalContext`.

See `docs/` for the design spec, the phase plans, and the architecture decision records.

## Develop

```shell
npm run build        # esbuild → bin/corpocode.js (single self-contained file)
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest
npm run verify       # build + typecheck + test (run before "done")
```
