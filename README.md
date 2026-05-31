# CorpoCode

Cheap-model **caretakers** for coding agents. CorpoCode installs hooks into a coding-agent platform
(Claude Code first) and runs cheap-LLM agents to read context, recommend, verify, and remember — so
the platform's main (expensive) model spends its time writing code, not re-deriving context.

All logic lives in TypeScript behind `corpocode hook <name>`; installed hooks are thin shims that
pipe `stdin → corpocode hook → stdout`.

On every turn CorpoCode reads the session transcript, scores the codebase for relevant files, recalls
prior decisions, and injects context; it verifies edits against the MOLAR-EDIT tenets, can deny a
dangerous command, keeps an atomic git **trace** branch plus a curated **clean** one, documents finished
code from the real call graph, and mines reusable skills — all while **failing open**: a buggy or
failing CorpoCode degrades to doing nothing, never to disrupting the host turn. All three knowledge
backends are native TypeScript, so the only hard dependency is the cheap models behind `Provider`.

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

Each component can run on a different provider (`config.components`), so you can run the categorizer
on Haiku and a future compactor on a free local Ollama model.

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

Four modular abstractions sit behind interfaces; consumers call the interface, never the adapter, so
implementations swap without touching a consumer:

| Interface | Default implementation | Answers |
| --- | --- | --- |
| `Provider` | anthropic, anthropic-cli, google, openai, openrouter, ollama | "run a cheap model call" |
| `KnowledgeGraph` | native (TypeScript; graphify adapter optional) | "how is the code structured?" |
| `ContextStore` | native (embedded store + Provider tiering; OpenViking adapter optional) | "what reference material is relevant, at what depth?" |
| `MemoryStore` | native (no vendor) | "what have we learned and decided?" |

The flow per turn: `UserPromptSubmit` → session reader distills the line of thought → stage-1
heuristics (free) graph-score candidate files → stage-2 ranker classifies the moment → recall prior
decisions → inject a `<middle-management recommendation>` block, plus retrieved context and a
design-review at a breakpoint. `PreToolUse`/`PostToolUse` give the filter and verifier teeth (deny a
dangerous command, halt a tenet-violating edit) and record each write to the trace branch. `Stop`
compacts the session into memory, promotes to the clean branch, and documents the touched code.
Everything reaches the model only as hook `additionalContext`.

See `docs/` for the design spec, the phase plans, and the architecture decision records.

## Develop

```shell
npm run build        # esbuild → bin/corpocode.js (single self-contained file)
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest
npm run verify       # build + typecheck + test (run before "done")
```
