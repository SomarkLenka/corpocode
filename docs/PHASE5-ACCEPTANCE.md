# Phase 5 — Definition of Done → evidence

Maps every Phase 5 acceptance criterion (from `phase5.md`) to the code and tests that satisfy it.
`npm run verify` (build → `tsc --noEmit` → `vitest`) is green: **313 tests / 54 files**
(up from Phase 4's 296/52).

Phase 5 is the finale: it replaces the two Python-backed knowledge abstractions with native TypeScript
implementations behind the **identical interfaces**, makes them the default, and drops the toolchain —
without changing a single consumer. The whole five-phase bet on building against interfaces, not
implementations, is repaid here: the swap is invisible from above.

| # | Criterion (phase5.md) | Evidence |
| --- | --- | --- |
| 1 | Native knowledge graph is a true drop-in: builds a correct multi-language graph, scores files deterministically and sensibly, refreshes incrementally on changed files, degrades on unsupported languages, and passes the **identical** conformance behaviors graphify passed | `src/backends/graph/native.ts` + `native/{extract,build}.ts` (dependency-free extractor behind an injectable `parse` seam — web-tree-sitter is the production drop-in; inbound-weighted centrality; lazy build + persist; `refreshFiles` re-parses only changed via a parse-cache); `tests/backends/graph/native.test.ts` (10 — deterministic centrality-ordered scoring that surfaces a related file, getNode/null, getNeighbors + edge-kind filter, findPath/null, query budget/truncated, ping, ensureBuilt build/skip, **opaque-node degrade**, **incremental refresh**) |
| 2 | Native context store is a true drop-in: stores in an embedded store, produces L0/L1/L2 tiers and embeddings through the configured Provider, backs `grep` with full text, and passes the **identical** conformance behaviors OpenViking passed | `src/backends/context/native.ts` (file-backed store behind a `ContextStorage` seam — SQLite/LMDB drop in; `Summarizer` + `embed` seams, Provider-backed in production, local defaults offline; `start`/`health` trivially up); `tests/backends/context/native.test.ts` (6 — write→find at L0, tier escalation monotonic, tree abstracts without bodies, grep full-text, health/ping/start, semantic ranking) |
| 3 | Defaults flipped and toolchain gone: default selects native, a full turn runs with **no** Python/daemon, a fresh install provisions neither, `doctor` runs Python/daemon checks only when a Python backend is explicitly selected, the adapters stay selectable, and an upgrade rebuilds native with no migration | `src/config/schema.ts` (backends default `native`); `src/install/provision.ts` (provisions a Python backend only if the config selects it → native install provisions nothing); `src/commands/doctor.ts` (graphify/openviking/python checks gated on selection, native checks otherwise); graphify/openviking adapters retained + registry-selectable; `tests/config/schema.test.ts`, `tests/commands/doctor.test.ts` (native default = 9 checks, no python; python-config path runs them), `tests/install/provision.test.ts`; **binary smoke**: a native `UserPromptSubmit` exits 0, builds the graph from source in-process, emits a recommendation, with no Python/daemon spawn |
| 4 | The native engine performs: heavy parsing/tiering stay at build/background time, the per-turn path stays within the Phase 4 budgets, and `doctor`/`stats` report correctly | Lazy build + persist confines the full parse to first use (`ensureBuilt`); the compactor's `write` tiers context at `Stop` in the background; the per-turn `scoreFiles` is in-memory + the Phase 4 score cache, now version-aware of the native graph path (`src/perf/graph-cache.ts`); `doctor` reports native backend health; `stats` is unchanged (same provider calls, same NDJSON log) |

## The swap is invisible from above

The factories `buildKnowledgeGraph` / `buildContextStore` select the native implementations by the one
config word; **no** consumer changed — the categorizer, retrieval team, context injector, and compactor
call the same interface methods they always did. The native conformance suites assert the same
behaviors as the adapter suites, so a consumer cannot tell which implementation it is talking to. That
is the thesis the whole plan was built to demonstrate.

## No one is stranded

The graphify and OpenViking adapters remain in the tree as fully selectable alternatives — they are
just two more implementations behind the same interfaces. A user who sets `knowledgeGraph: "graphify"`
keeps that behavior, and `doctor` runs the Python/daemon checks for them precisely because their config
asks for it. What changed is only that the install no longer provisions those tools automatically.
Migration is a non-event: the repository is the source of truth for the graph and the
repository/transcripts for the context, so both native backends rebuild from scratch with nothing
precious to migrate.

## Environment-limited verifications

Faithful in shape and proven by the conformance suites, with two production substitutions deferred
behind seams that make them mechanical drop-ins:

- **web-tree-sitter** is the intended graph parser; its WASM grammars need an npm/WASM toolchain not
  present here, and a single-file esbuild bin can't inline per-language `.wasm`. The native graph
  therefore ships a dependency-free heuristic extractor behind an injectable `parse` seam — it passes
  the conformance suite today, and swapping in tree-sitter changes no caller (only the `parse` function).
- **SQLite/LMDB** is the intended context storage; the native store ships a file-backed `ContextStorage`
  behind a seam so an embedded DB drops in without touching the store logic. The Provider-driven tiering
  and embeddings default to the same dependency-free local implementations the native memory store has
  used since Phase 1; pointing them at a cloud Provider is a config change.

## Closing the series

Five phases, one idea. Phase 1 built the senses behind interfaces and forbade action until the plumbing
earned trust. Phase 2 gave it hands and a memory. Phase 3 gave it reach across platforms and the
craftsmanship to leave durable artifacts. Phase 4 made it a public, inert, extensible, documented
product. Phase 5 removed the last scaffolding — the borrowed Python tools — leaving a system whose only
hard dependency is the cheap models behind the `Provider` abstraction that has powered it from the first
hook. All three knowledge abstractions are now native TypeScript; the install is a single npm package
with no external runtime. The discipline of building against interfaces, not implementations, is what
let Phase 1 ship fast on borrowed tools and Phase 5 swap the entire knowledge substrate without
disturbing one consumer. That is the plan, end to end.
