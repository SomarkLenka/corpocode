# Chapter 02 — The Four Abstractions

*The swappable infrastructure layer: four narrow interfaces — `Provider`, `KnowledgeGraph`,
`ContextStore`, `MemoryStore` — each with a dependency-free native default and an optional external
adapter, wrapped in the cross-cutting concerns (timeout/retry/cost, a concurrency ceiling,
version-scoped caching) that the caretakers above never have to think about.*

> This is the spine of the project. If you read only one chapter to understand *why* CorpoCode is
> shaped the way it is, read this one.

---

## The thesis: call the interface, never the implementation

The central architectural move is small and absolute: **consumers call a factory, never a
constructor.** Every abstraction has a `build*` function that takes the `CorpoConfig` and returns the
*interface* type; which concrete implementation comes back is a single config word.

```
buildRegistry(config).forComponent("router")  → a Provider
buildKnowledgeGraph(config, { repoRoot })      → a KnowledgeGraph   (native | graphify)
buildContextStore(config)                      → a ContextStore     (native | openviking)
buildMemoryStore(config, { project })          → a MemoryStore      (native)
```

Each factory's `switch` on the config kind ends with an exhaustiveness check
(`const unreachable: never = …`), so *adding a backend kind to the schema fails the typecheck until the
registry handles it.* The memory factory has only one implementation today, yet the factory exists
anyway — kept symmetric on purpose so every call site looks identical across all three knowledge
abstractions.

Why this matters is not abstract neatness. It is what let CorpoCode ship its first phases fast on
borrowed tools (graphify, OpenViking — both external Python processes) and later replace the entire
knowledge substrate with native TypeScript **as a config edit plus a new file**, with a conformance
suite proving the new implementation behaves identically. Consumers — the categorizer, the retrieval
team, the context injector, the verifier — never changed a line. The discipline is the product.

---

## Provider — "which cheap model answers this call, and what did it cost?"

The LLM boundary, deliberately minimal: a system prompt, a short message list, optional JSON output, a
few knobs. No streaming, no images.

```ts
interface Provider extends Pingable {
  readonly id: ProviderKind;
  readonly model: string;
  readonly modelTier: "fast" | "balanced";
  chat(input: ChatInput): Promise<ChatOutput>;
}
```

`ChatInput` carries `system`, `messages`, optional `maxTokens`, `responseFormat?: "text" | "json"`
(when `"json"`, the returned text is *guaranteed to parse as JSON*), `jsonSchema?`, `temperature?`
(default 0 — classification must be deterministic), and `timeoutMs?` (default 30s). `ChatOutput`
returns the text, token counts, `latencyMs`, `finishReason`, and a `costUsd` that is **computed
locally from `pricing.ts`, never trusted from the vendor response.**

### The runner is where the discipline lives

The vendor adapters are deliberately thin — each supplies only a `RawChat = (input, signal) =>
Promise<RawResult>` seam. Everything that must behave *identically* across vendors lives in one place,
`runChat` (`providers/runner.ts`):

- **Timeout**, via an `AbortController` that races the raw call against a timer. A subtle invariant: the
  timer *rejects before it aborts*, because aborting can synchronously settle the raw call and
  `Promise.race` adopts the first settlement — so the timeout must win the race.
- **Bounded, jittered retry**: an error is retried only if it is *both* `retryable` *and* its kind is in
  the configured `retryableKinds`; backoff is exponential with jitter.
- **JSON-contract enforcement**: when `responseFormat === "json"`, `extractJson` strips markdown fences
  and isolates the first balanced object/array; if nothing parses, it throws a *non-retryable*
  `invalid_response` — because retrying a model that can't format won't help.
- **Local cost** via `computeCostUsd`, and **error normalization**: every vendor failure funnels through
  `mapVendorError` into one `ProviderError { kind, providerId, message, retryable, cause }`, so a 429
  becomes a retryable `rate_limit`, a 401 a non-retryable `auth`, a 5xx a retryable `network`, and so on
  — uniformly, regardless of vendor.

The narrow interface intentionally has **no provider-specific reasoning knob**. The portable way to
"spend more" on a hard moment is therefore the *token budget*: `applyEffort` scales `maxTokens` by
`{ minimal: 0.6, medium: 1, high: 1.6 }` with a 64-token floor. Effort is money, not a dial only one
vendor has.

Six adapters implement the seam: `anthropic` (default Haiku), `anthropic-cli` (shells out to the user's
installed `claude` — no API key, for subscription users), `google`, `openai`, `openrouter`, and
`ollama`. `makeProvider` assembles the runner and supplies a default `ping` — a single-attempt, 1-token,
5s reachability probe that `corpocode doctor` uses as a genuine liveness test.

### Cost, computed locally

`pricing.ts` is the single place spend math lives: a `PRICES` table in USD-per-million-tokens keyed
`"kind:model"`, a conservative default for unpriced models, and `computeCostUsd` that returns **0 for
ollama** (local loopback is free). Because every call self-computes cost, `corpocode stats` compares a
Gemini, an Ollama, and a Haiku call on equal footing — a vendor that omits cost data can't blind the
tracker. `cost/tracker.ts` folds per-call events into totals bucketed by component, provider, and day;
the same fold runs over the NDJSON log for `stats`.

---

## KnowledgeGraph — "which files and symbols does this prompt touch, and how are they connected?"

```ts
interface KnowledgeGraph extends Pingable {
  readonly id: string;
  scoreFiles(prompt: string, opts: { limit: number }): Promise<ScoredFile[]>;
  getNode(name: string): Promise<GraphNode | null>;
  getNeighbors(nodeId: string, opts?: { depth?: number; edgeKinds?: EdgeKind[] }): Promise<Neighborhood>;
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;
  query(query: string, opts: { budget: number }): Promise<Subgraph>;
  ensureBuilt(repoRoot: string): Promise<void>;
  refresh(repoRoot: string): Promise<void>;
}
```

The interface exposes only what its consumers actually need — `scoreFiles` for the categorizer;
`getNode`/`getNeighbors`/`findPath`/`query` for the retrieval team and the injector — never graphify's
full surface. That narrowing is what made the native swap possible.

The **native default** builds the graph in-process from source, persists it under the CorpoCode home
dir, and traverses in memory — no Python, no daemon, no cross-process hop. The expensive full parse
happens once in `ensureBuilt`; `refresh` re-parses only changed files via a content-hash parse cache, so
the per-turn path is fast memory reads. `scoreFiles` scores a file as `centrality + 0.5·promptOverlap` —
so it surfaces structurally-central files the prompt never names. The optional **graphify adapter** maps
the same interface onto graphify's MCP tools over a spawned transport, with tolerant parsing that clamps
unknown shapes.

---

## ContextStore — "where is the relevant material, and at what zoom level?"

The tiered-context abstraction: L0 (~100-token abstract), L1 (~2k overview), L2 (full original).

```ts
interface ContextStore extends Pingable {
  readonly id: string;
  find(query, opts: { tier: Tier; limit: number; root?: string }): Promise<FindResult>;
  load(uri: string, tier: Tier): Promise<string>;
  write(uri: string, content: string, opts?: { kind?: ResourceKind }): Promise<void>;
  tree(uri: string, opts?: { depth?: number }): Promise<TreeEntry[]>;
  grep(pattern: string, opts?: { root?: string }): Promise<Resource[]>;
  start(): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
}
```

The **native default** is a single JSON file the process opens — no daemon, no port. The clever part is
that it achieves OpenViking's defining feature (tiering into L0/L1/L2) *through the same seams the rest
of CorpoCode already uses*: a Provider-backed `Summarizer` produces the tiers and the Provider-backed
embedder powers semantic `find` — both defaulting to dependency-free local implementations (a truncating
summarizer and a local hash embedder), so it works offline and a turn never blocks on a remote model.
`write` stores L2 (full), L1 (summary), L0 (one line), plus an embedding of L1; `find` ranks by cosine
similarity. The optional **OpenViking adapter** is an HTTP client to a daemon on `localhost:1933` with
Zod-validated, tolerant response parsing.

---

## MemoryStore — "what did we learn and decide on past sessions for this project?"

The experiential layer — and the one abstraction that was **native from day one**, with no vendor
adapter and no later swap.

```ts
interface MemoryStore extends Pingable {
  readonly id: string;
  recall(opts: RecallOptions): Promise<ScoredMemory[]>;
  capture(m: MemoryInput): Promise<void>;
  consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult>;
  recordOutcome(o: { recalledIds: string[]; passed: boolean; sessionId: string }): Promise<void>;
}
```

Memories are typed — `decision`, `mistake`, `rule`, `approach` — stored as flat per-project JSON with
embeddings in a sibling file. The design has two ideas worth internalizing:

- **Recall is a product of three signals**: `semantic × recencyWeight × outcomeWeight`. Semantic is
  cosine similarity to the query. Recency is a half-life decay — but **only for `decision` and
  `approach`**; `mistake` and `rule` *never* decay, so they stay protective forever. Outcome weight
  (0.5–1.5) reflects whether recalling this memory has historically preceded passing or failing work.
- **Supersession, not deletion.** When `consolidate` mines a new decision that reverses a live same-kind
  one, it sets the old memory's `supersededBy` pointer rather than deleting it — so recall returns
  current truth while history stays auditable. A reversal still needs minimal topical overlap to bind, so
  a flagged reversal can't retire an unrelated memory.

The default memory miner is keyless and regex-based (it harvests decision-cue lines from assistant
turns); a Provider-backed miner can be injected later without changing the contract. The default
embedder uses the hashing trick — tokens hashed into a 256-dimension normalized vector — making recall
deterministic, reproducible in tests, offline, and non-blocking.

---

## The cross-cutting machinery

Three small modules wrap the abstractions and are worth knowing because they enforce system-wide
properties.

- **`perf/limiter.ts` — the global concurrency ceiling.** The retrieval and verifier fan-outs each cap
  their *own* parallelism, but nothing stops several live fan-outs in one turn from summing into a
  model-call swarm that blows rate limits and cost. `globalProviderLimiter` (cap 12) is the
  process-global backstop every provider-call site acquires from; the effective concurrency is always the
  lower of the local cap and the global one. It can only ever *lower* concurrency.
- **`perf/graph-cache.ts` — version-scoped score caching.** Stage-1 file scoring is the latency that
  sits directly between the user pressing enter and the model's first token, and the same prompt against
  the same graph is deterministic — so it is the single highest-value thing to cache. Invalidation is
  *structural*: the cache version is derived from the graph file's size and mtime, so a graph rebuild
  drops the cache wholesale. A hit is therefore always against the current graph — there is no per-entry
  expiry to get wrong. The store is fail-open: a missing or corrupt read is treated as empty, a write
  failure is swallowed.
- **`Pingable` health on every interface.** `corpocode doctor` and hot-path guards get a cheap liveness
  probe; the provider registry adds a *synchronous* `availableFor(name)` check (does the key resolve / is
  the ollama endpoint set / is the cli model set) so a caller can degrade *before* attempting a call that
  would fail — which is exactly how the filter disables its deny path when no model is loaded.

---

## How it connects to consumers

`ProviderRegistry.forComponent` is the universal LLM entry point — the router, toolbox, retrieval team,
verifier, filter, and compactor each pull *their* configured (cheap) provider through it, so a user can
run the categorizer on Haiku and the compactor on a free local Ollama model. The hook context
([chapter 01](01-hook-engine.md)) wires the three knowledge backends *once* per dispatch — and applies
the score-files cache decorator at exactly that seam, transparently to every downstream consumer.
`RetrievedRef.source` is literally `"graph" | "context" | "memory"` — the three abstractions, normalized
so the retrieval team can rank a single merged result set.

## Invariants a contributor must not break

- **The timeout must win the race** in `withTimeout` — reject before abort.
- **`responseFormat: "json"` is a hard contract** — unparseable text throws a *non-retryable*
  `invalid_response`.
- **`retryable` is two-gated** — the error must be `retryable` *and* its kind in `retryableKinds`.
- **Cache hits are never stale by construction** — don't break the size+mtime version derivation.
- **Memory decay is deliberately asymmetric** — only `decision`/`approach` decay and can be superseded;
  `mistake`/`rule` are permanent.
- **Ollama cost is always 0** — use token counts, not cost, to see local-model volume.
- **Cost is computed locally, never from the vendor** — preserve that, or heterogeneous providers stop
  being comparable.

---

*Continue to [chapter 03 — Middle-Management](03-middle-management.md).*
