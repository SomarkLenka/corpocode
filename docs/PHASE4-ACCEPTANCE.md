# Phase 4 — Definition of Done → evidence

Maps every Phase 4 acceptance criterion (from `phase4.md`) to the code and tests that satisfy it.
`npm run verify` (build → `tsc --noEmit` → `vitest`) is green: **296 tests / 52 files**
(up from Phase 3's 269/46).

Phase 4 turns a capable private tool into a public product. Its governing idea sharpens Phase 3's
control principle: *the user's data and trust are protected as the product goes public.* That is why a
fresh install is inert, telemetry is opt-in and aggregate-only, and the plugin surface is declarative.

| # | Criterion (phase4.md) | Evidence |
| --- | --- | --- |
| 1 | Public release is automated and trustworthy: a merge to main triggers a semver bump + changelog + npm publish, gated by the full suite across Node 20/22 × mac/linux/win; a fresh `npm install` is **inert** — no hooks, no daemons, no config, no network — until `corpocode install` | `.github/workflows/ci.yml` (matrix gate), `.github/workflows/release.yml` (semantic-release + provenance), `.releaserc.json`, `package.json` (`publishConfig.provenance`, `files` allowlist, **no** install scripts), schema `version` + tolerance (`src/config/schema.ts`); `tests/release/packaging.test.ts` (3 — no install lifecycle scripts, allowlist excludes src/tests, provenance/public), `tests/config/migration.test.ts` (3 — defaults, old config fills new blocks, unknown legacy key stripped not fatal) |
| 2 | Telemetry protects by construction: default config → **zero** egress across a turn; enabling transmits only the documented whitelist of aggregate fields; `telemetry preview` makes the payload inspectable; `doctor` shows a banner when on; a transport failure never affects a turn | `src/telemetry/whitelist.ts` (whitelist payload — counts/distributions/percentiles only), `src/telemetry/transport.ts` (off→returns before any request; failure swallowed), `src/commands/telemetry.ts` (on/off/preview), doctor banner (`src/commands/doctor.ts`); **no hook handler imports the transport** (verified by grep), so a turn cannot transmit; `tests/telemetry/telemetry.test.ts` (7 — whitelist-only keys, no identifying strings leak, off=no calls, exact payload sent, failure swallowed, banner on/off) |
| 3 | Plugin API opens the two seams: a `corpocode-template-*` and a `corpocode-tenet-*` package auto-register at startup and appear in `doctor`; their contributions are exercised by the planner and the verifier; a broken plugin is skipped, not fatal | `src/plugins/{types,discover,registry}.ts` (convention discovery, apiVersion gate, fail-open skip); wired into the planner (`src/retrieval/planner.ts`, built-ins win), the MOLAR-EDIT engine (`src/molar/engine.ts` + `checksForTenets` extra), the `HookContext`, and `doctor` (transparency list); `tests/plugins/plugins.test.ts` (7 — discover/aggregate, decline incompatible apiVersion, skip thrower, template selectable, plugin tenet runs only when its tenet is active) |
| 4 | Performance is disciplined: caching reduces repeated cost/latency **without** ever serving a stale result; concurrency is globally bounded; a budget overrun degrades rather than blocks; latency is measured at the tail | `src/perf/cache.ts` (version-scoped, no-stale), `src/perf/graph-cache.ts` (stage-1 scoring memoized, invalidated by the graph file's version — wired in `buildContext`), `src/perf/limiter.ts` (global ceiling, wired into the retrieval fan-out), `src/commands/stats.ts` (p50/p90/p99); budget-overrun-degrades is the Phase 2 per-item/per-check timeout→neutral path; `tests/perf/perf.test.ts` (4 — hit/version-invalidation, concurrency bound, score memoization re-runs after a version change, percentiles) |
| 5 | Docs make the system legible: installation, configuration, commands, philosophy, and the plugin API are documented, the privacy posture is disclosed plainly, and the config + command references are **generated from source** | `src/cli-commands.ts` (one registry the CLI help and the docs both render from), `src/docs-site/{config-reference,command-reference}.ts` (derived from the Zod schema and the registry), `src/commands/docs.ts` (`corpocode docs [--out]`); prose docs `docs/{PHILOSOPHY,PLUGINS,PRIVACY}.md`; `tests/docs-site/reference.test.ts` (3 — schema-derived fields/defaults appear, every registry command appears, drift guard) |

## Wiring

`HookContext` now carries `plugins` (discovered contributions, fail-open) and a score-memoized graph.
The categorizer's retrieval dispatch passes plugin templates to the planner; the verifier passes plugin
tenets to the engine; `doctor` lists discovered plugins and surfaces the telemetry banner. The CLI gains
`telemetry` and `docs`, and its `--help` is rendered from the same `COMMANDS` registry the docs use.

## The trust posture, made concrete

- **Inert install** — `package.json` has no `preinstall`/`install`/`postinstall`; the `files` allowlist
  ships only the bundled bin + assets; activation is the user's explicit `corpocode install`.
- **Off means off** — the hook handlers do not import `src/telemetry/transport`, so a normal turn makes
  zero egress regardless of config; the transport itself returns before any request when disabled.
- **Whitelist, not blacklist** — the payload is *built* only from enumerated aggregate fields, so there
  is nothing identifying to leak; `telemetry preview` prints it verbatim.
- **Declarative plugins** — a plugin contributes template/check *definitions*, never imperative code,
  and is skipped on load failure or apiVersion mismatch.

## Environment-limited verifications

These are correct in shape and exercised by the suite, but a few steps depend on infrastructure absent
from this environment and are confirmed at integration time:

- **Live release** — the npm publish, multi-OS CI execution, and provenance attestation require a GitHub
  remote and npm/GitHub tokens. The repo has no remote here; `package.json`'s `repository.url` is a
  marked placeholder (`github.com/OWNER/corpocode`) that must be set to the real repo before the first
  publish. The workflows and `.releaserc.json` are complete and standard.
- **Non–Claude-Code platform envelopes** carry the Phase 3 honesty caveat (confirmed per platform).
- **A hosted docs site** — the generators, the prose, and the privacy disclosure are delivered; standing
  up a static-site host is deployment, not code, and is intentionally out of scope.
- **A CI latency budget gate** — latency is now measured (stats percentiles, telemetry); wiring a hard
  median/tail threshold into CI is a per-environment tuning step.

Deferred Phase 5 (native graph + native context backends, dropping the Python toolchain) is
intentionally absent.
