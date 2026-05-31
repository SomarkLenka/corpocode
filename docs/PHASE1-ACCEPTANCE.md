# Phase 1 — Definition of Done → evidence

Maps every Phase 1 acceptance criterion (from `phase1.md`) to the code and tests that satisfy it.
`npm run verify` (build + `tsc --noEmit` + `vitest`) is green: **190 tests / 31 files**.

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Builds into a single runnable binary; installs a `corpocode` command | `build.mjs` → `bin/corpocode.js`; `package.json` `bin`; smoke: `node bin/corpocode.js --version` |
| 2 | Config loads, validates, rejects bad input clearly, honors env overrides, secrets are 0600 | `src/config/*`; `tests/config/*` (21 tests) |
| 3 | Logger writes well-formed NDJSON, never throws; cost tracker sums correctly | `src/log/ndjson.ts`, `src/cost/tracker.ts`; `tests/log`, `tests/cost` (9 tests) |
| 4 | All providers pass one shared conformance suite (text, json, timeout, auth, cost) | `src/providers/*`; `tests/providers/conformance.test.ts` runs 6 adapters × 7 scenarios (42); + pricing/errors/parsers/registry |
| 5 | graphify structural conformance; native memory recall / supersession / corrupt-store | `tests/backends/graph/conformance.test.ts` (8); `tests/backends/memory/conformance.test.ts` (9) |
| 6 | Session reader keeps earlier intent across a terse prompt; flat per-hook cost | `src/session/reader.ts`; `tests/session/reader.test.ts` (6, incl. slice-only feeding + cross-process offset) |
| 7 | Hooks route correctly; malformed payload and thrown handler exit clean | `src/hooks/*`; `tests/hooks/*` (17, incl. timeout backstop); smoke: malformed stdin → `{}` |
| 8 | Categorizer free trivial early-exit; validated stage-2 decision; graph candidate not in prompt; preload ⊆ candidates; recommendation injected | `src/router/*`; `tests/router/*` (13); smoke: real binary emits a `<middle-management recommendation>` |
| 9 | Filter and verifier log advisory judgments, change nothing | `src/filter/*`, `src/verifier/*`; `tests/filter`, `tests/verifier` (12) — handlers return `{}` |
| 10 | Single package is both CLI and a valid Claude Code plugin wiring 4 hooks to the dispatcher | static payload `.claude-plugin/plugin.json`, `hooks/hooks.json`, `agents/`, `skills/`; `tests/install/plugin.test.ts`; hooks.json invokes the same dispatcher smoke-tested in #8 |
| 11 | Both install channels idempotent + dry-run + provision; marketplace catalog valid; local add-and-install | `src/install/*`, `src/commands/install.ts`; `tests/install/*` (17); smoke: real `install` writes shims + settings + agent + skills |
| 12 | doctor reports ordered checks with repair hints + channel detection + both-active warning; stats honest figures | `src/commands/doctor.ts`, `stats.ts`; `tests/commands/*` (8); smoke: `doctor` (8 ordered checks, exit 1 on fails), `stats --json` |

## Environment-limited verifications

`claude plugin validate .` was run and **passes** on this machine. The remaining external halves
need credentials/daemons not present in this box, so they are exercised with injected fakes and the
real probe is wired behind the same seam:

- Real provider reachability, real graphify/OpenViking provisioning — the orchestration logic is
  unit-tested with injected fakes (`tests/install/provision.test.ts`); the live calls run when the
  host has keys + Python. `corpocode doctor` reports each honestly (red + repair hint when absent).

Nothing above is a code gap; each path is exercised with a fake and the real probe is wired behind
the same seam.
