---
name: corpocode-setup
description: Verify CorpoCode is active after installing, and (only if you opted into the Python backends or the npm CLI) provision and health-check. With the default native backends there is nothing to provision. Use once after installing, or when something seems off.
---

# CorpoCode Setup

With the **default native backends**, there is **nothing to provision** — no Python toolchain, no
daemon. Installing the plugin already registered CorpoCode's hooks, so it is active immediately. This
skill is mostly a verification pass.

## Verify it's working (no commands needed)

CorpoCode runs as hooks, so you confirm it by seeing it work, not by running a binary:

1. At the start of a turn you should see an injected `<middle-management recommendation>` block
   (moment type, graph-scored files). That is the `UserPromptSubmit` hook firing.
2. Every hook also appends a line to a project-local log: **`.corpocode/logs/corpocode.ndjson`** in the
   directory you launched the host from. `cat` the last few lines to see `router`, `verifier`, etc.

If you see those, CorpoCode is set up. The one input it needs is an **API key for the cheap model**,
which it reads from your environment — set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GEMINI_API_KEY` /
`OPENROUTER_API_KEY`) and you're done. (Or use the `anthropic-cli` provider, which uses your existing
`claude` login and needs no key, or `ollama` for fully local.)

## Configure config + key without npm (self-contained)

The plugin ships the `corpocode` binary, so you can run any command without a global install. From the
directory you launched the host in:

```shell
node "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js" init      # scaffold ~/.corpocode/config.json + a secrets template
node "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js" doctor     # health-check
```

`init` writes a default config and a `~/.corpocode/secrets` file with a **placeholder** key. Open that
file and replace `REPLACE_WITH_YOUR_ANTHROPIC_API_KEY` with your real key (or set the env var instead —
an env var takes precedence over the file). `init` never overwrites an existing secrets file unless you
pass `--force`, so a real key is always safe.

If `${CLAUDE_PLUGIN_ROOT}` isn't set in your shell, the bundled binary lives under Claude Code's plugin
cache at `~/.claude/plugins/cache/<marketplace>/corpocode/bin/corpocode.js`.

## Health check / provisioning — only for some setups

The `corpocode` CLI is **only on your PATH if you installed the npm package** (`npm install -g
corpocode`). A plugin-only install runs the bundled binary from the plugin directory and does **not**
put `corpocode` on PATH — so do **not** run a bare `corpocode …` command after a plugin install; it
will be "command not found".

- **Installed the npm CLI?** Run `corpocode doctor` for a full health check. Under native backends it
  reports the in-process graph and store; there are no Python/daemon checks to satisfy.
- **Deliberately selected the Python backends** (`backends.knowledgeGraph: "graphify"` or
  `backends.contextStore: "openviking"` in `~/.corpocode/config.json`)? Those are not provisioned
  automatically. Run `corpocode provision` (npm CLI required) to install graphify, build the initial
  graph, generate OpenViking's config, and start the daemon. Then `corpocode doctor` to verify.

Until a Python graph is built (if you chose one), graph-backed file scoring falls back to a
string-overlap heuristic — fail-open by design. The native graph needs none of this: it builds
in-process on first use.
