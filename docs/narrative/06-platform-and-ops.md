# Chapter 06 — Platform & Operations

*How CorpoCode gets itself into a coding-agent platform and stays operable: it installs the hook
plumbing per platform, ships as one self-contained bundle through two distribution channels, exposes
operator commands, discovers third-party plugin contributions, and generates its own reference docs.*

---

## One package, two channels

CorpoCode is simultaneously a **global npm CLI** (`corpocode`) and a **Claude Code plugin**. Both
channels run the *same artifact*: `bin/corpocode.js`.

**The committed esbuild bundle.** `build.mjs` bundles the entire CLI (`src/index.ts` → `bin/corpocode.js`,
CJS, `node20`, with a `#!/usr/bin/env node` banner) into one file, so a hook invocation pays only Node
startup — **no `node_modules` resolution at runtime**. The version is inlined at build time
(`define: { __CORPOCODE_VERSION__ }`), so the runtime needs no `package.json` on disk. Crucially, **the
bundle is committed to git**, because the plugin channel runs it directly from the cloned repo — there
is no `npm install` in the plugin path. The standing consequence: *the bundle must be rebuilt and
committed on every `src/` change*, or the plugin runs stale code.

**The HTTPS `url` source.** The marketplace manifest declares the plugin source as an explicit
`{ "source": "url", "url": "https://…/corpocode.git" }`. This is deliberate: a `github`/`npm` source can
resolve to an SSH clone, which fails on a machine with no SSH key — so distribution is pinned to an
HTTPS clone.

**Version-gating of `/plugin update`.** `.claude-plugin/plugin.json` carries a `version` field; that
single number is what `/plugin update` reads to decide a new build is available. `sync-plugin-version.mjs`
keeps it in lockstep with `package.json` — idempotent and quiet when already in sync.

**The release pipeline** (`.releaserc.json`): `branches: ["main"]`, `tagFormat: "alpha-${version}"`; only
`feat` and `perf` commits bump (both → patch); `@semantic-release/npm` runs with **`npmPublish: false`**
(semantic-release manages the version but does *not* publish to npm — distribution is git/plugin-centric);
an `exec` step runs `sync-plugin-version.mjs && build.mjs` to sync the plugin version and **rebuild the
bundle** with the new version baked in; and a `git` step commits `package.json`, `plugin.json`, and the
freshly-built `bin/corpocode.js` back to main with `[skip ci]`. Every release therefore ships a rebuilt
bundle.

## Installing the hooks, per platform

**The seam.** `install/platform.ts` defines the one abstraction that absorbs platform differences, the
`PlatformAdapter`:

```ts
interface PlatformAdapter {
  readonly id: PlatformId;
  detect(env): boolean;           // is this platform installed?
  hookEvents(): HookEvent[];      // the subset of OUR events it can fire
  paths(env): PlatformPaths;      // home, settingsFile, shimDir
  register(settings, ctx): Record<…>;
  unregister(settings): Record<…>;
  responseEnvelope(out): string;
  assets(): { agents: string[]; skills: string[] };
}
```

Adapters are data-driven (`makeAdapter(cfg)`); the five differ *only* in config, and a registry maps
`PlatformId → adapter`. Adding a platform is one adapter file plus one registry entry — no central change.

**Thin shims.** `installPlatform` writes one shim per supported event into the platform's shim dir; the
shim just pipes `stdin → corpocode hook <event> --platform <id> → stdout`. On Windows it writes a `.ps1`
and registers a `powershell -NoProfile -ExecutionPolicy Bypass -File …` command; on POSIX a `.sh` with
`exec`, chmod 0755 (best-effort).

**settings.json — parse, never text-edit.** Registration reads the JSON, filters out any prior corpocode
group (identified by a `corpocode` marker in the command), then appends the fresh group. This makes
install **idempotent** — re-running *replaces* rather than duplicates. (A BOM is stripped on read.)

**Graceful degradation.** Each adapter declares only the events its platform can fire, and the installer
wires exactly that subset:

| Platform | Events wired | Effect |
| --- | --- | --- |
| **claude-code** | full set | everything |
| **codex** | UserPromptSubmit, PreToolUse `*`, PostToolUse `Write\|Edit`, Stop | full caretaker set |
| **opencode** | same four | full caretaker set |
| **cursor** | UserPromptSubmit + PostToolUse `Write\|Edit` | categorizer + post-write verifier only |
| **gemini-cli** | UserPromptSubmit + Stop | categorizer + compactor only |

A narrower platform gets a *coherent* install, never a failure. All four non-Claude adapters carry
`CONFIRM AT INTEGRATION` markers — their home dirs, settings filenames, and envelope field names are
documented best-effort and must be verified against each platform's live hook docs.

**Claude Code's two paths.** Claude has a canonical npm installer *and* a `PlatformAdapter` wrapper; a
router sends Claude through the npm installer and every other platform through the generic one, so
`--all` treats them uniformly. The npm installer registers a broader event list — most events have no
handler and exist purely for **flow-log observability** — and copies the helper agent and the
`corpocode-router`/`corpocode-setup` skills. The **plugin channel** is even thinner: a committed
`hooks/hooks.json` registers every event as `node "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js" hook <event>`,
with no shims and no settings rewrite.

**Where state lives.** Two cleanly separated locations: Claude Code's own config under `~/.claude` (where
hooks/agents/skills land), and CorpoCode's own state under `~/.corpocode` (global config + secrets) and
project-local `./.corpocode` (logs, memory, sessions). Separating them is exactly what makes reinstalling
or updating never disturb a user's config, logs, or memory.

> **On `--dry-run` / `--repair`.** `--dry-run` records the change plan without touching disk. `--repair`
> is parsed but never branched on — because registration is rewrite-not-duplicate, *re-running install is
> the repair operation*, so `--repair` is effectively a documented alias for "run it again."

## Operating it

- **`corpocode doctor`** runs ordered, each-injectable health checks (`{ name, status, detail, repair? }`):
  config validates; a telemetry banner (warns *loudly* when on, so it is never silently on); secrets
  readable; **provider reachable** (a genuine 1-token `ping`); **hook wiring + channel detection** — the
  critical operability check that warns if *both* npm and plugin channels are active ("every hook fires
  twice"); **backend health conditional on config** — native backends report "in-process; builds on first
  use" with *no* Python/daemon checks, and only an explicitly selected graphify/OpenViking triggers the
  Python and `:1933` daemon probes; memory dir writable; and a plugins list for transparency. A failure
  sets exit code 1 and prints a `↳ repair:` hint.
- **`corpocode stats`** reads the project-local NDJSON log and reports cost per component and per
  provider, total cost, an **estimated savings vs an all-expensive baseline** (cheap tier ≈ 14× cheaper,
  so each cheap dollar stands in for ~$14 saved), error rate, and latency percentiles. `--json` and
  `--days N` window it.
- **`corpocode init`** is the plugin-only self-provision path (runs via the bundle, no npm CLI). It
  scaffolds a default config and a `secrets` file with **placeholders** (never real keys), 0600
  best-effort, and **never overwrites** an existing config/secrets without `--force` — so a real key is
  always safe. With the keyless `anthropic-cli` default it writes guidance rather than placeholders. It
  also gates the toolbox unless `--no-gate`.
- **`corpocode provision`** runs *only* for opt-in Python backends; a default native install provisions
  nothing. It is factored out of `install` so provisioning is a *deliberate act, not a silent side
  effect*.
- **`corpocode uninstall`** removes the shims, unregisters the hooks (parse → filter → rewrite, leaving
  an unparseable file untouched), restores gated skills/agents, and with `--purge` deletes `~/.corpocode`.

## Plugin contributions

Discovery is convention-based — the same naming-discovery ESLint and Babel use. A regex
(`/^corpocode-(?:template|tenet)-…/`) matches packages in the project's `node_modules` (plus `NODE_PATH`
dirs); each match is loaded, validated, and registered. The contract:

```ts
interface CorpoPlugin {
  readonly apiVersion: 1;            // an incompatible generation declines cleanly
  readonly name: string;
  templates?: RetrievalTemplate[];  // from corpocode-template-* packages
  tenets?: TenetCheck[];            // from corpocode-tenet-* packages
}
```

Plugins contribute **definitions, never imperative behavior** — they extend the *data* CorpoCode reasons
over (the retrieval planner's templates and the MOLAR-EDIT engine's tenet checks) without being handed
free rein in the user's environment. Two safety rules: a plugin whose `apiVersion !== 1` is rejected, and
**every load is fail-open** — a plugin that throws or has an invalid shape is skipped with a log line,
never fatal. Contributions are flattened once and carried on the `HookContext`, so a hook reads them
without re-scanning, and `doctor` surfaces them for transparency.

## Telemetry: opt-in, whitelist-only, aggregate

The privacy posture is a **whitelist, not a blacklist**: only the aggregate, non-identifying fields
enumerated in `TELEMETRY_FIELDS` are *ever constructed* — a field that isn't constructed can't leak. The
payload carries counts, distributions, and percentiles (hook-invocation counts, model/effort
distributions, total cost, estimated savings, error rate, backend names, latency percentiles) and
**never copies a string the log carries** — no prompts, code, paths, decisions, or memory. Two transport
guarantees: **off means off** — when disabled (the default), the send returns before constructing any
request, so a normal turn makes zero egress; and it is **fail-open** — a failed send is swallowed, never
thrown. The send is deliberately not wired into any per-turn hook path. The user controls are
inspectable: `on` prints exactly what is and isn't collected before flipping the switch, `preview` prints
the exact payload that would be sent, and `doctor` shows a prominent banner whenever it is on.

## Generated docs can't drift

The reference docs under `docs-site/` are *derived from source* — the config reference from
`configSchema.parse({})`, the command reference from the single `COMMANDS` array that also drives
`--help`. Because both come from the source of truth, they cannot drift from the schema or the CLI.

## Why it is shaped this way

- **Self-contained committed bundle** so each hook pays only Node startup and the plugin channel runs
  with no `npm install` — at the cost that the bundle is source-of-truth in git and must be rebuilt and
  committed on every change (the release pipeline automates it; manual edits must not forget).
- **State outside the plugin cache** so reinstalling never disturbs config, logs, or memory.
- **Fail-open everywhere** — plugin load failures skip rather than crash, chmod failures are swallowed,
  unparseable settings are left untouched, telemetry send failures are swallowed.
- **"The user disposes"** — telemetry is opt-in with an inspectable payload, backends are opt-in (native
  default provisions nothing), `init` never clobbers real keys, `doctor` *suggests* repairs.
- **Parse, don't text-edit** settings.json, with a marker for idempotent replace, so unrelated user
  settings are protected.

## Invariants a contributor must not break

- **Never fire hooks twice.** npm and plugin channels both register Claude Code hooks; if both are
  active, every hook double-fires. `doctor` detects and warns this; the fix is `corpocode uninstall` (npm)
  *or* `/plugin uninstall corpocode`.
- **Rebuild + commit `bin/corpocode.js` on every `src/` change** — the plugin runs the committed bundle
  directly; a stale bundle is stale behavior.
- **Never commit secrets** — `init` writes only placeholders (0600, never overwriting real keys without
  `--force`); secrets live in `~/.corpocode/secrets`, referenced by name.
- **`plugin.json.version` stays in lockstep with `package.json`** — it is the only number `/plugin update`
  reads.
- **`npmPublish: false`** — distribution is git/plugin via the HTTPS `url` source, not `npm i -g`.
- **Non-Claude adapters are unconfirmed** — every codex/opencode/cursor/gemini-cli adapter carries
  `CONFIRM AT INTEGRATION` markers; verify the home dir, settings filename, and envelope field against
  live platform docs before trusting them.

---

*This is the last chapter. Back to [the overview](00-overview.md).*
