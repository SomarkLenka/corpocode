# CorpoCode — Phase 1 Implementation Specification

This document expands Phase 1 of the master specification into a complete, self-contained build plan. It is written to be handed to a coding agent, but it explains the reasoning behind each decision so that whoever implements it understands not just *what* to build but *why* it is shaped this way. Where the master spec stated a requirement in a single line, this document gives the full picture: the file involved, the types, the behavior step by step, the failure modes to handle, and how to know the piece is finished.

## What Phase 1 is, and what it is deliberately not

It helps to start with the shape of the whole system so that Phase 1's boundaries make sense. CorpoCode eventually does many things — it injects context, it intercepts file reads, it verifies code against a design philosophy, it manages git, it writes documentation, it compacts transcripts, and it maintains a memory of decisions and mistakes. If you tried to build all of that at once, you would have no way to tell which part was responsible when something went wrong, and you would be layering risky behavior (anything that can change what the host coding agent does) on top of an untested foundation.

Phase 1 therefore builds the *foundation and the nervous system*, but almost none of the behavior that can alter the host's actions. By the end of Phase 1 you will have CorpoCode installable into Claude Code through two parallel channels — an npm package and a native Claude Code plugin — which, on every user turn, reads the session transcript, understands what the model is trying to do, scores the codebase for relevant files, recalls any prior decisions, and injects a single advisory recommendation block — and that is all. It will not block a command, it will not rewrite a file read, it will not commit anything, and it will not stop a turn. The filter and the verifier exist, but they run in "recommend only" mode: they observe and they log, and nothing more.

The reason for this restraint is trust. A tool that sits inside another agent's loop can do real damage if it misfires, so Phase 1's job is to prove that the plumbing is correct, the provider layer is reliable, the configuration is sound, and the observability is honest — before Phase 2 gives any component the power to act. Think of Phase 1 as wiring up a building's electrical panel, outlets, and circuit breakers and confirming every circuit is sound, while leaving the appliances for later phases.

Concretely, Phase 1 delivers: the package scaffold and build pipeline; the cross-platform configuration system; the logging and cost-tracking layer; the full `Provider` abstraction with all five providers and a conformance test suite; the declarations of all three knowledge-abstraction interfaces, with the graphify adapter and the native memory store actually implemented; the session reader that distills the transcript; the hook envelope schemas and the dispatcher that routes hook calls; the two-stage moment categorizer with dynamic model and effort selection; the filter and verifier in log-only mode; two parallel ways to install CorpoCode into Claude Code — the `corpocode install` command for the npm channel, and CorpoCode packaged as a native Claude Code plugin distributed through its own plugin marketplace — both with backend provisioning; and the `doctor` and `stats` commands. Everything else — retrieval fan-out, file-read interception, the design-review team, the compactor, the git manager, the doc generator, the skill generator, and memory writes from live hooks — waits for Phase 2 and beyond.

A note on how to read the build order below: the sections are arranged in dependency order, so that each piece only relies on pieces already described. If you implement them top to bottom, you will never reference something that does not yet exist.

## 1. Project scaffolding and the build pipeline

The first task is to create the npm package and the toolchain that turns TypeScript source into a single runnable binary. The end state is a package that a user can install globally and invoke as `corpocode`, where every hook the coding agent fires ends up calling `corpocode hook <name>`.

The package targets Node 20 or newer. Use TypeScript for all source, but do not ship TypeScript or even a `node_modules` tree to end users. Instead, bundle everything with `esbuild` into one self-contained file, `bin/corpocode.js`, with a `#!/usr/bin/env node` shebang at the top. The reason for bundling is speed and simplicity at the point of use: every hook invocation pays a fresh Node process startup, so the runtime artifact should be a single file with no dependency resolution to do. Type-checking is a separate concern handled by `tsc --noEmit` (the compiler only verifies types; esbuild does the actual emitting, because it is far faster and handles bundling).

The `package.json` must declare the binary and the Node floor. The relevant fields look like this:

```jsonc
{
  "name": "corpocode",
  "bin": { "corpocode": "./bin/corpocode.js" },   // installs a `corpocode` command on PATH
  "engines": { "node": ">=20" },                    // fail early on older Node
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --outfile=bin/corpocode.js --banner:js='#!/usr/bin/env node'",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Testing uses `vitest`, chosen because it shares esbuild's transform path and so runs TypeScript tests with no extra configuration. Releases are automated with `semantic-release` so that version bumps and changelog entries happen from commit messages on merge to the main branch; you do not need to wire this up fully in Phase 1, but leave a `.releaserc` in place so the convention is established from the start.

The entry point, `src/index.ts`, does almost nothing itself: it hands off immediately to `src/cli.ts`, which parses `process.argv` and routes to a command handler. Keep this dispatch trivial and free of logic, because the meaningful work lives in the command and hook handlers described later. The acceptance bar for this section is simple: after `npm run build`, running `node bin/corpocode.js --version` prints the version, and `corpocode` is available on PATH after a global install.

## 2. Configuration: paths, schema, loading, and secrets

Nearly every other component reads configuration, so it must exist before them. CorpoCode keeps all of its state under a single user-level directory, `~/.corpocode/`, but the exact location of that directory differs by operating system, and `src/config/paths.ts` is responsible for hiding that difference. On Linux it honors `XDG_CONFIG_HOME`; on macOS it uses `~/Library/Application Support`; on Windows it uses `%APPDATA%`. Centralizing this logic in one module means no other file ever has to think about platform differences — they simply ask `paths.ts` where the config, the log, the memory store, or the secrets file lives.

Four locations matter in Phase 1. The configuration itself lives at `~/.corpocode/config.json`. Secrets — API keys — live separately at `~/.corpocode/secrets`, which must be created with `chmod 600` so only the owning user can read it; the configuration references a secret by name rather than embedding it, which lets a user commit a sanitized `config.json` to a dotfiles repository without leaking credentials. The append-only log lives at `~/.corpocode/logs/corpocode.ndjson`. The memory store lives at `~/.corpocode/memory/<project>.json`.

The configuration's shape is defined and enforced by a Zod schema in `src/config/schema.ts`. Zod is doing real work here: it is the single point where a malformed or partial configuration is caught, with a clear error, before any component tries to use it. The schema covers more blocks than Phase 1 strictly exercises, because defining the whole shape now means later phases do not have to migrate the file format. The authoritative shape, with the defaults a fresh install should write, is the following:

```jsonc
{
  // Named provider configurations. Each entry names a model and the provider kind that serves it.
  "providers": {
    "default":     { "kind": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "cheap_local": { "kind": "ollama", "model": "qwen2.5-coder:7b", "host": "http://localhost:11434" }
  },
  // Which named provider each component uses. This is what lets the categorizer run on one
  // model while a later compactor runs on a free local one — the user tunes cost per role.
  "components": { "router":"default","retrieval":"default","compactor":"cheap_local","filter":"default","verifier":"default" },
  "compaction":     { "backend": "openviking" },                 // Phase 2 concern; declared now
  "sliding_window": { "preserved_turns": 6, "preserved_tool_outputs": 4 },
  "router":         { "heuristic_candidate_limit_files": 10, "trivial_early_exit": true },
  "retrieval":      { "max_checklist_items": 6, "per_item_timeout_ms": 15000, "max_parallel_instances": 6, "package_token_budget": 1500, "coherence_pass": false },
  "molar_edit":     { "active_tenets": ["M","O","L","A","R","E","D","I","T"], "strictness": { "A": "strict", "R": "off_for_non_ui" }, "verify_on_edit": true, "review_on_breakpoint": true },
  "effort":         { "difficulty_to_model": { "trivial": { "component":"router","effort":"minimal" }, "medium": { "component":"router","effort":"medium" }, "hard": { "model":"claude-opus-4","effort":"high" } } },
  "git":            { "enabled": true, "mode": "suggest", "branch_management": true, "trace_branch": "corpocode/trace", "clean_branch": "corpocode/clean", "commit_per_write": true, "promote_on": ["verifier_clean","unit_boundary"] },
  "backends":       { "knowledgeGraph": "graphify", "contextStore": "openviking", "memoryStore": "native" },
  "telemetry":      { "enabled": false }
}
```

Loading is handled by `src/config/load.ts`, which reads the file, validates it against the schema, and then applies environment-variable overrides. The override convention is a flat uppercase namespace: `CORPOCODE_PROVIDERS_DEFAULT_MODEL` overrides `providers.default.model`, and so on. This matters for continuous-integration environments, where writing a config file is awkward but setting an environment variable is easy. One discipline to enforce from the beginning: components never call `load.ts` themselves. The dispatcher loads the configuration once per process and passes each component only the slice it needs. This keeps the components pure and testable, because their behavior is a function of the config object handed to them rather than of hidden global state.

This section is done when a valid config round-trips through the loader into a typed object, an invalid config produces a clear validation error rather than a downstream crash, an environment variable demonstrably overrides a file value, and the secrets file is created with the correct restrictive permissions.

## 3. Logging and cost tracking

Observability comes before behavior, because you cannot trust what you cannot see, and because Phase 1's entire value is being able to watch the system run and confirm it is doing the right thing cheaply. Two small modules provide this.

`src/log/ndjson.ts` is an append-only writer that emits exactly one JSON object per line to `~/.corpocode/logs/corpocode.ndjson`. The format is NDJSON — newline-delimited JSON — because it is trivial to append to without parsing the whole file, and trivial to process line by line afterward. The single most important property of this writer is that it must never throw into its caller: if the disk is full or the path is unwritable, the logger swallows the error silently rather than breaking the hook that called it. Logging is a side effect, and a failed side effect must never take down the primary work. A configuration knob can disable logging entirely, in which case the write call collapses to a no-op, which is useful in tightly sandboxed environments.

Every log line shares a common envelope of fields — a timestamp, the event name, the session id, the component that emitted it, and, where a provider call happened, the cost in US dollars, the latency in milliseconds, the provider, and the model. Individual event types add their own fields on top. In Phase 1 the events you will actually emit are `router` (with whether stage two ran, the candidate set it produced, and its decision), `session` (carrying the distilled line of thought), and advisory `filter` and `verifier` lines. Later phases add retrieval, review, compaction, and git events to the same log.

`src/cost/tracker.ts` accumulates the `costUsd` values that every provider call reports, normalizing them into a per-component, per-provider, per-day total. This is what makes the central promise of the whole project measurable: that the cheap models cost less than the expensive-model time they save. Because each provider computes its own cost locally (described in the next section), the tracker can compare spend across providers on equal terms.

This section is done when a hook invocation produces a well-formed NDJSON line, a forced write error does not propagate, and the cost tracker correctly sums known per-call costs into per-component daily figures.

## 4. The Provider abstraction and all five providers

This is the structural centerpiece of Phase 1. Every time CorpoCode needs a cheap language-model call — to rank candidates, to distill a transcript, to run a check — it goes through a single interface called `Provider`. The point of the interface is that the rest of the system never knows or cares which model vendor is behind it; you can run the categorizer on Anthropic's Haiku, Google's Gemini Flash, OpenAI's small tier, anything reachable through OpenRouter, or a local Ollama model, and not one line of the architectural code changes. Getting this boundary right in Phase 1 is what makes the project genuinely multi-provider rather than Anthropic-specific with a vendor swap bolted on later.

The interface is deliberately narrow, because the entire surface the system ever needs is a system prompt, a short list of messages, an optional request for structured JSON output, and a few knobs. There is no streaming and no image input, because no component needs them. The interface and its supporting types live in `src/providers/types.ts`:

```typescript
export type ProviderKind = "anthropic" | "anthropic-cli" | "google" | "openai" | "openrouter" | "ollama";

export interface Message { role: "user" | "assistant"; content: string; }

export interface ChatInput {
  system: string;
  messages: Message[];
  maxTokens?: number;
  responseFormat?: "text" | "json";   // when "json", the returned text must parse as JSON
  jsonSchema?: object;                 // used when the provider supports schema-constrained output
  temperature?: number;               // default 0, because classification should be deterministic
  timeoutMs?: number;                 // default 30000
}

export interface ChatOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;                     // computed locally from pricing.ts, never trusted from the vendor
  latencyMs: number;
  providerId: ProviderKind;
  model: string;
  finishReason: "stop" | "length" | "timeout" | "error";
}

export type ProviderErrorKind = "auth" | "rate_limit" | "timeout" | "invalid_response" | "network" | "model_unavailable";

// A single normalized error type so every component handles failure the same way,
// regardless of which vendor SDK actually threw.
export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    public providerId: ProviderKind,
    message: string,
    public retryable: boolean,
    public cause?: unknown,
  ) { super(message); }
}

export interface Provider {
  readonly id: ProviderKind;
  readonly model: string;
  readonly modelTier: "fast" | "balanced";
  chat(input: ChatInput): Promise<ChatOutput>;
  ping(): Promise<boolean>;            // cheap liveness probe used by `doctor`
}
```

Two design choices in here deserve explanation. First, every implementation computes `costUsd` itself, from a local pricing table in `src/providers/pricing.ts`, rather than trusting whatever the vendor's response claims. This is what lets `stats` compare a Gemini call against an Ollama call against a Haiku call on the same footing, and it means a vendor that omits cost information does not blind the tracker. Second, every implementation funnels all of its failure modes into the single `ProviderError` shape with a correct `kind` and a `retryable` flag. Downstream code should never have to know that the OpenAI SDK throws one error type and the Anthropic SDK throws another; it sees one normalized error and decides whether to retry based on the flag. The shared retry policy lives in `src/types/common.ts` and defaults to three attempts with jittered exponential backoff for the `rate_limit`, `timeout`, `network`, and `daemon_restart` kinds.

Five implementations ship in Phase 1, one file each. The `anthropic` provider wraps `@anthropic-ai/sdk`, defaults to the `claude-haiku-4-5-20251001` model, gets structured output through tool-use or response prefilling, and reads its key from `ANTHROPIC_API_KEY`. The `anthropic-cli` variant is a small but valuable twist: instead of using an API key, it shells out to the user's installed `claude` binary with `--print --output-format json` and parses the result, which serves people who already pay for a Claude subscription and do not want to manage a separate key. The `google` provider wraps `@google/generative-ai`, defaults to `gemini-2.5-flash`, and uses JSON mode for structured output. The `openai` provider wraps the `openai` SDK, defaults to `gpt-5-nano` with `gpt-4o-mini` as a fallback, and supports both JSON mode and schema-constrained output. The `openrouter` provider is written as a thin extension of the OpenAI one — same client, different base URL and model defaults — which roughly halves the maintenance burden, since OpenRouter speaks an OpenAI-compatible protocol. The `ollama` provider wraps the `ollama` package, talks to a local loopback host, needs no authentication, and reports a cost of zero.

A registry in `src/providers/registry.ts` ties these together. The function `buildRegistry(config)` reads the `providers` and `components` blocks and exposes `forComponent(name)`, which resolves the provider a given component should use, and `all()`, which returns every distinct provider in use so that `doctor` can probe each one for reachability.

```typescript
export type ComponentName = "router" | "retrieval" | "compactor" | "filter" | "verifier";
export interface ProviderRegistry {
  forComponent(name: ComponentName): Provider;   // config.components[name] → config.providers[key] → instance
  all(): Provider[];
}
export function buildRegistry(config: CorpoConfig): ProviderRegistry;
```

The most important deliverable of this section is the conformance test suite in `tests/providers/`. The idea behind a conformance suite is that you write the contract tests once and run them against every implementation, so that adding a sixth provider later is a matter of passing the existing tests rather than writing new ones. The suite asserts that a fixed prompt returns non-empty text; that a request with `responseFormat: "json"` returns something that parses as JSON; that a deliberately tiny `timeoutMs` of one millisecond produces a `ProviderError` with `kind: "timeout"` and `retryable: true`; that an invalid key produces a `ProviderError` with `kind: "auth"` and `retryable: false`; that `costUsd` matches what the pricing table computes for a known token count; and that `ping` returns true against a healthy endpoint. This section is done when all five providers pass that one shared suite.

## 5. The knowledge-abstraction interfaces, the graphify adapter, and the native memory store

CorpoCode draws on three kinds of knowledge, each behind its own interface, and Phase 1 declares all three even though it only implements two of them. The interfaces are `KnowledgeGraph`, which answers "how is the code structured right now"; `ContextStore`, which answers "what reference material is relevant, and at what depth"; and `MemoryStore`, which answers "what have we learned and decided." Declaring all three now fixes the boundaries so that later phases slot implementations into a stable shape. Of the three, Phase 1 implements `KnowledgeGraph` (through an adapter over the external graphify tool) because the categorizer's file-scoring depends on it, and it implements `MemoryStore` natively because the categorizer's decision-recall depends on it. The `ContextStore` interface is declared but its OpenViking adapter is deferred to Phase 2; Phase 1 still provisions and health-checks the OpenViking daemon so the rest of the operational story is whole.

### The KnowledgeGraph interface and the graphify adapter

The interface lives in `src/backends/graph/types.ts`. It exposes a small set of operations the system actually needs: `scoreFiles`, which ranks files by structural relevance to a prompt and is the one the Phase 1 categorizer calls; and `getNode`, `getNeighbors`, `findPath`, and `query`, which the Phase 2 retrieval team will call. The adapter implements all of them in Phase 1 so the conformance suite covers the full surface, even though only `scoreFiles` is wired into a live hook yet.

```typescript
export type Confidence = "extracted" | "inferred" | "ambiguous";
export type NodeKind = "file" | "function" | "class" | "method" | "variable" | "module" | "concept" | "doc" | "table" | "endpoint";
export interface GraphNode { id: string; name: string; kind: NodeKind; path?: string; span?: { startLine: number; endLine: number }; summary?: string; centrality?: number; metadata?: Record<string, unknown>; }
export type EdgeKind = "calls" | "imports" | "defines" | "references" | "inherits" | "implements" | "reads" | "writes" | "relates_to";
export interface GraphEdge { from: string; to: string; kind: EdgeKind; confidence: Confidence; weight?: number; }
export interface ScoredFile { path: string; score: number; nodeId: string; reason?: string; }
export interface Neighborhood { center: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; depth: number; }
export interface GraphPath { from: string; to: string; nodes: GraphNode[]; edges: GraphEdge[]; length: number; }
export interface Subgraph { nodes: GraphNode[]; edges: GraphEdge[]; query: string; budgetTokens: number; truncated: boolean; }

export interface KnowledgeGraph {
  readonly id: string;                                                    // "graphify" in Phase 1
  scoreFiles(prompt: string, opts: { limit: number }): Promise<ScoredFile[]>;
  getNode(name: string): Promise<GraphNode | null>;
  getNeighbors(nodeId: string, opts?: { depth?: number; edgeKinds?: EdgeKind[] }): Promise<Neighborhood>;
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;
  query(query: string, opts: { budget: number }): Promise<Subgraph>;
  ensureBuilt(repoRoot: string): Promise<void>;                           // build the graph if absent
  refresh(repoRoot: string): Promise<void>;                               // rebuild after large changes
  ping(): Promise<boolean>;
}
export function buildKnowledgeGraph(config: CorpoConfig): KnowledgeGraph;  // selects impl by config.backends.knowledgeGraph
```

The adapter in `src/backends/graph/graphify-adapter.ts` works by spawning graphify's server as a child process — `python -m graphify.serve graphify-out/graph.json` — and speaking to it over the Model Context Protocol on standard input and output, caching the process per repository root so it is not respawned on every call. The method-to-tool mapping is direct: `scoreFiles` issues graphify's `query_graph` against the prompt, keeps the nodes of kind file, ranks them by their graph centrality (a more-connected file is more likely to be structurally central to the change), and truncates to the requested limit; `getNode` calls graphify's `get_node`; `getNeighbors` calls `get_neighbors`; `findPath` calls `shortest_path`; and `query` calls `query_graph` with a budget, setting the `truncated` flag if results were cut. The lifecycle methods shell out to the graphify CLI: `ensureBuilt` runs `graphify .` when `graphify-out/graph.json` is missing, and `refresh` runs it again. The adapter ignores graphify capabilities the system does not use, such as its pull-request triage tools.

### The MemoryStore interface and the native store

Memory is the one knowledge abstraction with no external dependency. It is implemented natively from the start, which means there is no vendor adapter to phase out later and nothing added to the install footprint. The interface lives in `src/backends/memory/types.ts`:

```typescript
export type MemoryKind = "decision" | "mistake" | "rule" | "approach";
export interface Scope { project: string; workspaceCascade: boolean; }
export interface Memory { id: string; kind: MemoryKind; text: string; files?: string[]; createdAt: number; supersededBy?: string; outcomes?: { passed: boolean; at: number }[]; }
export interface ScoredMemory extends Memory { score: number; }
export interface MemoryInput { kind: MemoryKind; text: string; files?: string[]; sessionId: string; }
export interface ConsolidationResult { captured: number; superseded: number; }

export interface MemoryStore {
  readonly id: string;             // "native"
  recall(opts: { query?: string; file?: string; kinds?: MemoryKind[]; scope: Scope; limit: number }): Promise<ScoredMemory[]>;
  capture(m: MemoryInput): Promise<void>;
  consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult>;
  recordOutcome(o: { recalledIds: string[]; passed: boolean; sessionId: string }): Promise<void>;
  ping(): Promise<boolean>;
}
export function buildMemoryStore(config: CorpoConfig): MemoryStore;
```

Here Phase 1 makes a careful scoping decision worth stating plainly. The native store in `src/backends/memory/native.ts` keeps its records as flat per-project JSON at `~/.corpocode/memory/<project>.json`, with a small sibling file holding the embeddings, which are produced by calling the configured `Provider` (so an OpenAI user gets OpenAI vectors and an Ollama user gets local ones, with no separate embedding service to configure). In Phase 1 you fully implement two methods. The first is `recall`, because the categorizer needs it: it embeds the query, scores stored memories by a blend of semantic similarity and recency, filters by the requested kinds or file anchor, excludes any record that already carries a `supersededBy` pointer, and returns the top results. The second is `capture`, implemented as a straightforward append of a new typed memory. The remaining two methods, `consolidate` and `recordOutcome`, are present and type-correct but minimal in Phase 1 — `consolidate` may extract and append memories without yet doing the contradiction-and-supersession resolution, and `recordOutcome` may append to the outcome log without yet feeding the recall ranking. The full continuity machinery, where `consolidate` marks reversed decisions as superseded and `recordOutcome` re-weights recall, arrives in Phase 2 along with the verifier and compactor that actually call those methods. One robustness rule applies even in Phase 1: a missing or corrupt store file must cause `recall` to return an empty array rather than throw, so a damaged memory file can never break a turn.

### Declaring ContextStore

For completeness the `ContextStore` interface is declared in `src/backends/context/types.ts` exactly as it appears in the master spec — `find`, `load`, `write`, `tree`, `grep`, plus `start` and `health` — and `buildContextStore(config)` exists, but in Phase 1 the OpenViking adapter behind it is a stub that is not yet wired into any hook. This is deliberate: the categorizer in Phase 1 uses the graph and memory, not tiered document retrieval, and the retrieval team that consumes `ContextStore` is a Phase 2 deliverable. Declaring the interface now is what lets Phase 2 add the adapter without disturbing anything.

This whole section is done when the graphify adapter passes a structural conformance suite against a fixture repository (scoring is deterministic, node and neighbor and path and query shapes are well-formed, and `ping` reflects whether the server is alive), and when the native memory store round-trips a captured memory through a relevant `recall`, correctly excludes a record bearing a `supersededBy` pointer, and degrades to an empty result on a corrupt file.

## 6. The session reader

The session reader is the piece that lets CorpoCode reason *with* the main model rather than guessing alongside it. Claude Code, like the other supported platforms, hands every hook a path to the running session transcript. That transcript is a record of the model's own reasoning — what it said it intended to do, the approach it chose, the questions it is working through — and the session reader's job is to read it and distill that reasoning into a compact structure the rest of CorpoCode can use. The payoff is that the cheap agents do not have to re-derive the situation from the bare prompt, and the expensive model does not have to stop and re-explain itself.

The reader and its types live in `src/session/`. The central type is the "line of thought," and the interface exposes three reads built on it:

```typescript
export interface ThoughtState {
  intent: string;            // what the model is currently trying to accomplish
  approach?: string;         // the approach it has settled on, if it has stated one
  openQuestions: string[];   // questions it is actively working through
  recentDecisions: string[]; // decisions visible in the transcript this session
  entities: string[];        // symbols, files, and concepts in active play; these seed retrieval
}
export interface RetrievalCues { query: string; files: string[]; kinds?: MemoryKind[]; }
export interface SessionReader {
  lineOfThought(sessionId: string, transcriptPath: string): Promise<ThoughtState>;
  filePurpose(sessionId: string, file: string): Promise<string | null>;   // null means: ask the user
  retrievalCues(sessionId: string): Promise<RetrievalCues>;
}
```

In Phase 1 you implement `lineOfThought` fully, because the categorizer depends on it, and you implement the other two methods as well since they derive cheaply from the same transcript parse — but only `lineOfThought` is wired to a live hook in Phase 1; `filePurpose` is consumed by the Phase 2 context injector and `retrievalCues` by the Phase 2 retrieval team.

There is one performance property that is not optional, and it shapes the implementation. The reader runs on every hook, and a session transcript only grows over time, so a naive implementation that re-reads and re-summarizes the entire transcript on each call would get steadily more expensive as a session goes on — exactly the wrong cost curve. The reader must therefore be *incremental*: it caches the distilled `ThoughtState` per session id, and on each call it updates that state from only the new transcript content since the last read. The result is that the reader's per-call cost and latency stay roughly flat no matter how long the session runs, which is one of the things the acceptance criteria check. The distillation itself is a single cheap-model call through the configured provider, given the new transcript slice and the prior state, asked to return an updated `ThoughtState` as JSON.

This section is done when, over a multi-turn session, the reader's `intent` reflects an earlier stated goal even when the current prompt is terse, and when its per-hook cost and latency do not climb as the transcript grows.

## 7. Hook envelopes, the dispatcher, and the response builder

With the providers, knowledge, and session reader in place, you can build the plumbing that connects CorpoCode to the host coding agent. The mechanism is straightforward: the host fires a hook at a particular moment, the hook is a thin shim that runs `corpocode hook <name>`, that process reads a JSON payload from standard input, does its work, and writes a JSON response to standard output. Three files implement this.

`src/hooks/envelope.ts` defines a Zod schema for each hook payload the system handles: `UserPromptSubmit`, fired before a user turn; `PreToolUse`, fired before a tool call; `PostToolUse`, fired after one; `Stop`, fired when the model finishes; and `SubagentStart`. Every payload carries at least a session id and a transcript path, which is how the session reader gets its input. Validating the payload with Zod before any handler runs means a malformed envelope produces a clean, controlled exit rather than an exception inside a handler.

`src/hooks/dispatch.ts` is the heart of the plumbing, and it has one behavior that matters more than any other. Its normal flow reads the hook name from `argv[2]`, reads standard input to completion, parses and validates it against the matching envelope schema, loads the configuration once, calls the appropriate handler with its config slice, and writes the handler's result to standard output using the response builder. But the entire flow is wrapped in a top-level try/catch, and on *any* unhandled error it exits with status zero and an empty response. The reason is the single most important safety property of the whole system: CorpoCode lives inside another agent's loop, and a crash or a non-zero exit from a hook could break the host's turn. A buggy or failing CorpoCode must degrade to doing nothing, never to disrupting the model it is supposed to help. It is the software equivalent of a circuit breaker that fails open.

```typescript
// src/hooks/dispatch.ts — the safety wrapper is the point of this file
export async function dispatch(): Promise<void> {
  try {
    const hookName = process.argv[2];
    const raw = await readStdin();
    const envelope = validate(hookName, JSON.parse(raw)); // throws on malformed input
    const config = loadConfig();
    const result = await runHandler(hookName, envelope, config);
    process.stdout.write(buildResponse(result));
  } catch (err) {
    logSafely(err);             // record it, but never surface it to the host
    process.stdout.write("{}"); // empty hookSpecificOutput → host turn proceeds untouched
    process.exit(0);            // exit clean no matter what went wrong
  }
}
```

`src/hooks/response.ts` builds the output envelope the host expects, whose key field is `additionalContext` — the channel through which CorpoCode injects anything into the model's context. In Phase 1 the only content injected is the categorizer's recommendation, wrapped in a `<middle-management recommendation>` tag, together with any recalled decisions. The convention of tagging injected content by its source is established here and reused throughout later phases.

This section is done when a valid hook payload routes to its handler and produces a well-formed response, a malformed payload exits zero with an empty response, and a handler that throws also exits zero with an empty response — verified by deliberately breaking a handler and confirming the host turn would proceed.

## 8. The two-stage moment categorizer and dynamic model/effort selection

This is the first component that does something visible. On every user turn, the categorizer decides what the moment needs and produces the recommendation the model sees. It is built in two stages for a reason that is worth understanding: the first stage is free and fast and handles the easy cases without spending anything, and only the harder cases reach the second stage, which costs a fraction of a cent. This two-stage shape keeps the average cost per turn very low, because most turns never need the paid stage.

Before either stage runs, the categorizer asks the session reader for the current line of thought, so that everything downstream reasons from what the model is actually trying to do rather than from the literal prompt alone.

Stage one lives in `src/router/heuristics.ts`. It begins with the cheapest possible checks: it tokenizes the prompt, and if the prompt is trivial and the `trivial_early_exit` setting is on, it exits immediately, logging a `router` line with `stage2_invoked` false and a cost of zero. A prompt like "what is 2+2" should never cost anything. For non-trivial prompts, the primary work of stage one is to produce a candidate set of relevant files, and it does this through the `KnowledgeGraph` — it calls `scoreFiles` with the prompt and the line of thought folded together, limited by `heuristic_candidate_limit_files`. Because the graph understands structure, this surfaces the files that are structurally central to the request even when the prompt never names them, which is the whole advantage of a graph-backed prefilter over keyword matching. A thin string-overlap fallback remains in the code only for the brief window after a repository is initialized but before its graph has been built for the first time.

Stage two lives in `src/router/ranker.ts`. It takes the candidate set from stage one, plus the line of thought, and makes a single structured call through the provider configured for the `router` component. It asks the model to rank the candidates and to classify the moment, and it parses the result against a strict schema in `src/router/output-schema.ts`. The output carries the moment's type, its complexity, whether it is a design breakpoint, whether the work can be delegated, whether retrieval should be dispatched, and the model and effort the work warrants. A validation step rejects any suggested file, skill, or agent that was not in the candidate set, which prevents the ranker from inventing references. The categorizer also, at the start of the turn, asks the memory store to recall any relevant prior decisions and approaches, so that the model opens the turn already aware of what was settled before and does not re-derive it.

```typescript
// src/router/output-schema.ts — the shape stage two must return, validated with Zod
export interface RouterDecision {
  type: "code-edit" | "code-gen" | "exploration" | "docs" | "config" | "other";
  complexity: "trivial" | "medium" | "hard";
  breakpoint: boolean;            // is this a design breakpoint? (acted on in Phase 2)
  delegate_to?: string;           // a subagent that could absorb this (acted on in Phase 3)
  dispatch_retrieval: boolean;    // should the retrieval team run? (the team itself is Phase 2)
  model?: string;                 // from selectModelEffort
  effort: "minimal" | "medium" | "high";
  context_files_to_preload: string[];   // must be a subset of the stage-one candidates
}
```

Dynamic model and effort selection lives in `src/router/effort.ts`. The function `selectModelEffort` maps the classified difficulty to a concrete model and effort level by reading the `effort` block of the configuration, so a trivial moment routes to the cheapest fast model at minimal effort while a hard one routes to a stronger model at high effort. In Phase 1 this choice is emitted on the categorizer's output and recorded; the parts of the system that *act* on it — spawning a subagent with the chosen model — arrive in Phase 3, but the selection itself is computed and surfaced now.

It is worth being explicit about a Phase 1 boundary here. The categorizer emits `dispatch_retrieval` and a candidate set, but the retrieval team that would fan out across all three knowledge abstractions does not exist until Phase 2. So in Phase 1 the recommendation block contains the categorizer's classification, the graph-scored candidate files, and the recalled decisions — and that is what reaches the model. The flag is set for Phase 2 to consume; it does nothing on its own yet.

This section is done when a trivial prompt early-exits for free, a non-trivial prompt produces a stage-two decision whose candidate files include a structurally related file the prompt did not name and whose preload set is a subset of the candidates, the line of thought visibly shapes the candidates across a terse follow-up prompt, and the recommendation block appears in the model's context.

## 9. The filter and verifier in recommend-only mode

Phase 1 builds the filter and the verifier, but neither is allowed to act. They observe and they log, and they leave every decision to the host and the model. Building them now in this passive mode does two useful things: it exercises their plumbing and their provider calls so that Phase 2 only has to add the consequences, and it lets you watch what they *would* do, accumulating evidence that their judgments are sound before you let them block anything.

The filter lives in `src/filter/classify.ts` and runs on the `PreToolUse` hook. Its eventual job is to decide whether a tool call should be allowed, denied, or sent to the user, but in Phase 1 it only classifies the call and logs an advisory line; it never sets a permission decision, so every tool call proceeds exactly as it would without CorpoCode. The implementation pattern is lifted from the precedent of a command classifier — generalized to work over any tool name and any provider — so that Phase 2 can add the deny and allow lists and the actual permission output on top of a classifier that already works.

The verifier lives in `src/verifier/worker.ts` and runs on the `PostToolUse` hook. Its eventual job is to check changed code against the MOLAR-EDIT design philosophy by running one family of checks per active tenet in parallel, but in Phase 1 it runs a single check, or a small fixed set, through one provider call, and logs what it finds as advisory text without ever stopping a turn. The one piece of structure that matters to get right now is the function signature, because Phase 2's parallel fan-out is built on it: the verifier exports `runChecks(checks: TenetCheck[])` from the very first day, even when only one check is registered, so that adding the full nine-tenet set later is purely additive.

This section is done when a tool call produces an advisory filter log line and proceeds untouched, and a file write produces an advisory verifier log line and proceeds untouched — that is, when you can see the filter and verifier thinking out loud without either of them changing anything the host does.

## 10. Installation: the npm package and the Claude Code plugin

For any of this to run, CorpoCode has to get its hooks in front of Claude Code, and there is a point of vocabulary to settle before anything else, because the word "plugin" is about to mean two different things in this project. In this section, "plugin" means *CorpoCode packaged as a Claude Code plugin* — CorpoCode itself, installed through Claude Code's own extension system. That is a separate idea from the `corpocode-template-*` and `corpocode-tenet-*` packages introduced in Phase 4, which are *CorpoCode's own* plugin ecosystem for extending its retrieval templates and design tenets. The first is how CorpoCode gets *into* Claude Code; the second is how others extend CorpoCode's behavior. They live at different layers and should never be conflated, and this section is concerned only with the first.

Phase 1 ships two parallel, independent ways to install CorpoCode into Claude Code, and a user picks exactly one of them. The first is the **npm channel**, the imperative path, which is also the only path that will work on the other platforms in Phase 3. The second is the **plugin channel**, the declarative, Claude-Code-native path, and the recommended one for Claude Code. The thing to hold onto is that both channels route every hook event to the very same `corpocode hook <name>` entry point and the same TypeScript logic built in the sections above; they differ only in *how the hooks get registered* and *how CorpoCode is distributed*, not in what runs once a hook fires.

The **npm channel** works the way installation has worked up to this point in the document. A user installs the package globally and then runs `corpocode install --platform claude-code`, implemented in `src/install/claude-code.ts`. That command writes one small shim script per hook event into Claude Code's hooks directory — a shell script on macOS and Linux, a PowerShell script on Windows — where each shim does nothing but `exec corpocode hook <name>`, and it registers those shims under the appropriate events in Claude Code's `settings.json` by parsing, modifying, and rewriting the JSON rather than editing text, so it cannot corrupt unrelated settings. It also writes the `haiku-helper` subagent and the `corpocode-router` skill into Claude Code's directories.

The **plugin channel** packages that same material as a Claude Code plugin, so that Claude Code wires the hooks itself from a manifest and CorpoCode never has to touch the user's settings. A Claude Code plugin is, concretely, just a directory with a manifest at `.claude-plugin/plugin.json` and its components sitting at the directory root, and the elegant part is that CorpoCode's published npm package can *be* that directory — one artifact serving as both the command-line tool and the plugin. Alongside the bundled binary the package already ships at `bin/corpocode.js`, the package gains four things at its root: the manifest, a `hooks/hooks.json` that declares the hooks, an `agents/` directory holding the `haiku-helper` subagent, and a `skills/` directory holding the `corpocode-router` skill. The package's `files` allowlist is extended to ship these, so the single published artifact is simultaneously installable as a global CLI and loadable as a plugin.

The manifest itself is small. It names the plugin — which also becomes the namespace for any skills it ships, so the router skill appears as `/corpocode:...` — describes it, and carries a version that governs when users receive updates:

```json
// .claude-plugin/plugin.json — identifies the plugin; bump `version` to ship an update
{
  "name": "corpocode",
  "description": "Cheap-model caretakers that read context, recommend, verify, and remember — offloading the main model.",
  "version": "1.0.0",
  "author": { "name": "CorpoCode" }
}
```

The hooks file is where the plugin meets the dispatcher, and the reason the two channels can share all their handler code is that this file's format is identical to the `hooks` object a user would otherwise write into `settings.json`. Each entry runs a command that receives the hook payload as JSON on standard input — precisely what the Phase 1 dispatcher already reads. The one detail that must be right is the `${CLAUDE_PLUGIN_ROOT}` variable: because Claude Code copies an installed plugin into a cache directory, a hook command has to reference the bundled binary through that variable rather than by a relative path, which would not resolve from the cache.

```json
// hooks/hooks.json — declares the four Phase 1 hooks, each invoking the same dispatcher.
// ${CLAUDE_PLUGIN_ROOT} resolves to the plugin's cached install directory, so the path is always valid.
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js hook UserPromptSubmit" }] }],
    "PreToolUse":  [{ "matcher": "*",          "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js hook PreToolUse" }] }],
    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js hook PostToolUse" }] }],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/bin/corpocode.js hook Stop" }] }]
  }
}
```

Because a plugin's `bin/` directory is automatically added to the Bash tool's PATH whenever the plugin is enabled, the `corpocode` binary is also directly callable inside the session, which the backend-provisioning step below relies on. There is one tempting mistake to resist here: do *not* declare graphify or OpenViking as plugin MCP servers in a `.mcp.json`. CorpoCode drives those backends privately through its own adapters, and exposing them as MCP servers would put their tools in front of the main model — the opposite of what CorpoCode is for, since the whole point is to keep that machinery off the expensive model's plate.

Backend provisioning is the one piece that does not come for free in the plugin channel, and the reason is a principle worth stating outright: installation should be *inert*, and provisioning — which installs a Python toolchain and starts daemons — should be a deliberate act rather than a silent side effect of installing. The npm channel already honors this, because `corpocode install` is something the user runs on purpose. So the provisioning logic is factored into its own command, `corpocode provision`, built over the code in `src/install/backends/`, and `corpocode install` simply calls it as its second half. The graphify provisioner checks for a usable Python toolchain, installs graphify, registers graphify's own git hook in the repository so the graph stays fresh on every commit at no cost, and builds the initial graph if none exists. The OpenViking provisioner installs the daemon, generates its configuration from CorpoCode's own provider configuration so the user authenticates once and OpenViking inherits the same model and key rather than being configured separately, starts the daemon, and waits for its health check to pass. (Recall that Phase 1 provisions OpenViking even though the adapter that uses it is a Phase 2 deliverable; provisioning it now completes the operational picture and lets `doctor` verify it.) In the plugin channel, the user runs `corpocode provision` once after installing the plugin, or runs the `/corpocode:setup` skill that the plugin ships, which invokes provisioning and then runs `doctor`. Until provisioning happens, CorpoCode is useful but degraded rather than broken: its graph-backed file scoring simply falls back to the string-overlap path described in the categorizer section, in keeping with the fail-open principle that governs the whole system.

Two channels brings one rule with it: use one, not both, on the same platform, because two registrations would fire every hook twice. The plugin channel is the recommended one for Claude Code, since it gives clean, versioned updates and a clean uninstall and never touches the user's `settings.json`; the npm channel remains for users who want the standalone CLI, and it is the foundation the other platforms build on in Phase 3. The `doctor` command, described next, detects which channel is active and warns if both are. A reassuring consequence of CorpoCode's existing path design falls out here for free: all of CorpoCode's durable state — its configuration, its logs, its memory — lives under `~/.corpocode/`, which sits outside Claude Code's plugin cache, so reinstalling or updating the plugin never disturbs a user's configuration or their accumulated memory.

The qualities required of installation carry over from before and extend to the new command. Both `corpocode install` and `corpocode provision` must be idempotent, so running either twice changes nothing rather than duplicating work; both honor a `--dry-run` flag that prints everything they would do without touching anything; `corpocode install --skip-backends` registers hooks without provisioning, for users who manage the tools themselves; and `--repair` regenerates derived files such as the OpenViking configuration. The plugin itself must pass `claude plugin validate`, Claude Code's own validator, which checks the manifest together with the hook, agent, and skill definitions.

This section is done when the published package works as a global CLI and, unchanged, also validates and loads as a Claude Code plugin; when the npm channel — a clean `corpocode install --platform claude-code` on Node 20 and again on Node 22 across macOS, Linux, and Windows — produces working shims and registered hooks, is idempotent, and respects `--dry-run`; when the plugin channel, loaded with `claude --plugin-dir ./corpocode`, wires all four hooks to the dispatcher so a reference prompt produces a recommendation block; when `corpocode provision`, or equivalently the `/corpocode:setup` skill, provisions and health-checks both backends in either channel; and when an unprovisioned install degrades to the string-overlap fallback rather than failing.

## 11. The plugin marketplace

Loading a plugin from a local directory with `--plugin-dir` is fine for development, but real distribution in Claude Code happens through a *marketplace*: a small catalog that lists plugins and says where each one is fetched from, which a user adds once and then installs plugins from by name. Phase 1 provides CorpoCode's marketplace so that adopting CorpoCode in Claude Code is a two-line affair rather than a manual setup.

A marketplace is itself just a git repository containing a single catalog file at `.claude-plugin/marketplace.json`. CorpoCode's marketplace is a thin, dedicated repository whose only job is to hold that catalog; the actual plugin payload stays in the npm package. The catalog names the marketplace, names its owner, and lists the plugins it offers, and for each plugin it gives a `source` telling Claude Code where to fetch it. Because the CorpoCode plugin *is* the npm package, the cleanest source is the `npm` source type, which points Claude Code straight at the published package:

```json
// .claude-plugin/marketplace.json — the catalog; the plugin payload is the npm package itself
{
  "name": "corpocode",
  "owner": { "name": "CorpoCode" },
  "plugins": [
    {
      "name": "corpocode",
      "source": { "source": "npm", "package": "corpocode" },
      "description": "Cheap-model caretakers that read context, recommend, verify, and remember.",
      "category": "productivity"
    }
  ]
}
```

With that catalog hosted, a Claude Code user adopts CorpoCode in two steps — adding the marketplace, then installing the plugin from it:

```shell
/plugin marketplace add corpocode/corpocode      # the marketplace's git repo, in owner/repo shorthand
/plugin install corpocode@corpocode               # install the `corpocode` plugin from the `corpocode` marketplace
```

Choosing the `npm` source has a quiet benefit worth appreciating, because it is what keeps the two channels from drifting apart. It unifies them onto a single published artifact with a single version number: there is no separate plugin build to keep in sync with the package, because the package is the plugin. Cutting one npm release simultaneously updates the CLI and the plugin, and a user's `/plugin update` simply pulls the newer package version. For users or organizations that prefer git over npm, the same catalog could instead point at the package's git repository with a `github` or `git-subdir` source, but the `npm` source is the recommended default precisely because of that single-artifact, single-version property.

The marketplace is a Phase 1 deliverable in the sense that its structure is built and made testable now, even though publishing it publicly rides along with the npm release in Phase 4. Locally, the whole thing is verifiable without publishing anything: `claude plugin validate .` checks the catalog, `/plugin marketplace add ./<local-marketplace>` adds it from a local path, and `/plugin install corpocode@corpocode` installs from it — the same loop a user will later run against the hosted version. When the time comes to distribute publicly, the catalog is hosted on a git host such as GitHub, and beyond CorpoCode's own marketplace the plugin can also be submitted to Anthropic's public community marketplace for broader discovery; the marketplace `name` is deliberately chosen to avoid the names reserved for Anthropic's official marketplaces.

Looking ahead, this same marketplace is where CorpoCode's *other* sense of plugin might eventually surface for discovery — but keep the two layers distinct, as the previous section warned. The `corpocode-template-*` and `corpocode-tenet-*` extensions from Phase 4 extend CorpoCode itself and are discovered by CorpoCode at startup as npm packages; they are not Claude Code plugins, and they reach the system through CorpoCode's own plugin API rather than through Claude Code's. CorpoCode's marketplace distributes CorpoCode-the-Claude-Code-plugin. The two ecosystems are complementary and entirely separate.

This section is done when the catalog validates with `claude plugin validate`; when adding it from a local path and running `/plugin install corpocode@corpocode` installs a working CorpoCode whose hooks reach the dispatcher; and when a `/plugin update` against a bumped package version updates the installed plugin.

## 12. The doctor and stats commands

The last two pieces of Phase 1 are the operational commands that make the system diagnosable and measurable, which closes the loop on the "observability before behavior" principle.

`corpocode doctor` runs a sequence of health checks in a fixed order and reports each one, and when a check fails it prints the exact `corpocode install --repair` invocation that would fix it, so a user is never left guessing. The checks, in order, are: that the configuration validates against the schema; that the secrets file is readable; that the default provider is reachable, confirmed by a genuine one-token test call; that the hooks are wired — which now means detecting which installation channel is active, the plugin or the npm shims, confirming that channel's hooks reach the dispatcher, and warning if both channels are active at once, since that would fire every hook twice; that graphify is available, meaning its CLI is on the path, its graph file exists in the current directory, and its server responds; that OpenViking is available, meaning its daemon answers on its port and its configuration is valid; that the Python toolchain is a compatible version; and that the memory directory is writable. Because graphify and OpenViking are required rather than optional, their absence is a red check, not a warning.

`corpocode stats` reads the NDJSON log and reports the numbers that matter: cost attributed per component and per provider, an estimate of savings against a no-CorpoCode baseline, and error rates over a window. It prints plain text by default, accepts a `--json` flag for scripting, and accepts a `--days N` flag to bound the window.

This section is done when `doctor` runs every check in order and a missing backend yields a red check with a repair hint, and when `stats` produces correct per-component and per-provider figures from a known log.

## Definition of done for Phase 1

Phase 1 is complete when the following are all true, which together constitute the acceptance criteria for the phase.

The package builds into a single runnable binary and installs a `corpocode` command. Configuration loads and validates, rejects malformed input with a clear error, honors environment overrides, and stores secrets with restrictive permissions. The logger writes well-formed NDJSON, never throws into its caller, and the cost tracker sums per-call costs correctly. All five providers pass the single shared conformance suite, including the timeout, authentication, cost-computation, and structured-output assertions. The graphify adapter passes its structural conformance suite against a fixture repository, and the native memory store round-trips a captured memory through recall, excludes superseded records, and survives a corrupt store file. The session reader keeps the model's earlier intent in view across a terse later prompt and holds its per-hook cost flat as the transcript grows. Hook payloads route correctly, and both a malformed payload and a thrown handler exit cleanly with an empty response so the host turn is never disrupted. The categorizer early-exits for free on trivial prompts, produces a validated stage-two decision with graph-scored candidates and recalled decisions on non-trivial ones, and injects a recommendation block. The filter and verifier log advisory judgments without changing anything the host does. The single published package serves as both the global CLI and a valid Claude Code plugin — it passes `claude plugin validate`, and loaded as a plugin it wires all four hooks to the dispatcher so a reference prompt produces a recommendation. CorpoCode installs into Claude Code through either channel — the npm `corpocode install` or the plugin installed from CorpoCode's marketplace — both idempotent, both supporting a dry run, and both able to provision and health-check the backends through `corpocode provision`; the marketplace catalog validates and a local add-and-install yields a working CorpoCode. And `doctor` reports all of its checks with repair hints — including which install channel is active and a warning if both are — while `stats` reports honest cost and savings figures.

When all of that holds, you have the trustworthy foundation Phase 2 builds on: a multi-provider, fully observable system that sees everything and injects a useful recommendation, but that cannot yet alter what the host does. Phase 2 is where the filter and verifier grow teeth, the retrieval team fans out across all three knowledge abstractions, the context injector begins intercepting file reads, and memory begins to be written as well as read.
