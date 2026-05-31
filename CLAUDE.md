Use sequential thinking and superpowers continuously. Use typescript-lsp
# CorpoCode — Technical Implementation Specification

Target: a coding agent. Imperative requirements only. No rationale.

---

## 1. Summary

Build `corpocode`: a TypeScript npm package (CLI binary `corpocode`) that installs hooks into coding-agent platforms (Claude Code first) and runs cheap-LLM agents to read/inject context, verify code, manage git, and maintain memory, so the platform's main model only writes code.

- All logic lives in TypeScript behind `corpocode hook <name>`; installed hooks are thin shims that pipe stdin→`corpocode hook`→stdout.
- Components are grouped into **caretakers** (labels only): **Middle-Management** (session reader, categorizer, retrieval team, context injector, design-review team, model/effort selector), **Housekeeping** (verifier, doc generator, git manager, compactor, skill generator). **Upper-Management is out of scope for implementation** (no code this build).
- Four modular abstractions behind interfaces: `Provider`, `KnowledgeGraph`, `ContextStore`, `MemoryStore`. Consumers call interfaces only, never adapters.

---

## 2. Tech stack & build

- Node ≥ 20. TypeScript with `tsc --noEmit` for typecheck (no emit).
- Bundle with `esbuild` to a single `bin/corpocode.js` with a `#!/usr/bin/env node` shebang (no `node_modules` required at runtime).
- `package.json`: `"bin": { "corpocode": "./bin/corpocode.js" }`, `"engines": { "node": ">=20" }`.
- Tests: `vitest`. Releases: `semantic-release` on merge to main.
- npm deps: `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`, `ollama`, `zod`. graphify and OpenViking are external processes (not npm deps), provisioned by `corpocode install`.

---

## 3. Repository layout

```
src/
  index.ts
  cli.ts                         # arg parsing → command handlers
  hooks/
    envelope.ts                  # Zod schemas for hook stdin payloads
    dispatch.ts                  # hook name → handler; stdin→stdout
    response.ts                  # hookSpecificOutput / additionalContext builder
  session/
    reader.ts                    # SessionReader impl (transcript → line of thought)
    types.ts
  router/
    heuristics.ts                # stage-1 prefilter
    ranker.ts                    # stage-2 LLM ranker
    output-schema.ts             # Zod schema for ranker output
    effort.ts                    # selectModelEffort
  retrieval/
    worker.ts                    # dispatch: plan → fanout → aggregate
    planner.ts                   # build checklist from template + cues
    fanout.ts                    # Promise.all over items
    item-handler.ts              # one item → one abstraction call
    aggregator.ts                # deterministic merge
    templates/                   # one file per task type
      code-edit.ts code-gen.ts exploration.ts docs.ts config.ts
  filter/
    classify.ts                  # pre-tool classifier (deny/allow/ask)
    policies.ts                  # deny/allow/soft lists
    inject.ts                    # file-read interception + slice injection
  verifier/
    worker.ts                    # fan-out tenet checks
    aggregator.ts
    tenets/                      # one module per MOLAR-EDIT tenet
      maintainability.ts observability.ts logging.ts atomicity.ts
      responsiveness.ts extensibility.ts documentation.ts in-flight.ts testing.ts
  review/
    team.ts                      # design-review: one subagent per tenet
    aggregator.ts
  docs/
    generator.ts                 # DocGenerator impl
    types.ts
  git/
    manager.ts                   # GitManager orchestration
    trace.ts                     # per-write atomic commits
    promote.ts                   # squash trace → clean branch
    types.ts
  compactor/
    worker.ts                    # Stop-hook handler
    sliding-window.ts            # compute compactable region
    openviking.ts                # ContextStore write path at Stop
    memdir.ts                    # defensive fallback writer
  providers/
    types.ts                     # Provider + supporting types
    registry.ts                  # buildRegistry, forComponent
    pricing.ts                   # cost tables
    anthropic.ts google.ts openai.ts openrouter.ts ollama.ts
  backends/
    graph/
      types.ts registry.ts graphify-adapter.ts native.ts(stub)
    context/
      types.ts registry.ts openviking-adapter.ts native.ts(stub)
    memory/
      types.ts registry.ts native.ts
  config/
    schema.ts                    # Zod config schema
    load.ts                      # read+validate+env override
    paths.ts                     # cross-platform dirs
  log/
    ndjson.ts                    # append-only writer
  cost/
    tracker.ts                   # aggregate ChatOutput.costUsd
  install/
    claude-code.ts codex.ts opencode.ts cursor.ts gemini-cli.ts
    backends/
      graphify.ts openviking.ts
  loops/
    skillgen.ts
tests/
  providers/ backends/graph/ backends/context/ backends/memory/ ...
bin/corpocode.js                 # esbuild output
```

---

## 4. Configuration

### Paths
- Config: `~/.corpocode/config.json`. Resolve cross-platform in `config/paths.ts`: `XDG_CONFIG_HOME` (Linux), `~/Library/Application Support` (macOS), `%APPDATA%` (Windows).
- Secrets: `~/.corpocode/secrets` (chmod 600). `config.json` references keys by name; never inline secrets.
- Logs: `~/.corpocode/logs/corpocode.ndjson`.
- Memory: `~/.corpocode/memory/<project>.json` (+ sibling embeddings file).
- Env override: any field via flat `CORPOCODE_*` (e.g. `CORPOCODE_PROVIDERS_DEFAULT_MODEL`).

### Loading
`config/load.ts` reads, validates against `config/schema.ts` (Zod), applies env overrides, returns typed object. Components receive their config slice from the dispatcher; they never call `load.ts` directly.

### Schema (authoritative shape)
```jsonc
{
  "providers": {
    "default":     { "kind": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "cheap_local": { "kind": "ollama", "model": "qwen2.5-coder:7b", "host": "http://localhost:11434" }
  },
  "components": { "router":"default","retrieval":"default","compactor":"cheap_local","filter":"default","verifier":"default" },
  "compaction": { "backend": "openviking" },               // "openviking" | "memdir"
  "sliding_window": { "preserved_turns": 6, "preserved_tool_outputs": 4 },
  "router": { "heuristic_candidate_limit_files": 10, "trivial_early_exit": true },
  "retrieval": { "max_checklist_items": 6, "per_item_timeout_ms": 15000, "max_parallel_instances": 6, "package_token_budget": 1500, "coherence_pass": false },
  "molar_edit": {
    "active_tenets": ["M","O","L","A","R","E","D","I","T"],
    "strictness": { "A": "strict", "R": "off_for_non_ui" },
    "verify_on_edit": true,
    "review_on_breakpoint": true
  },
  "effort": { "difficulty_to_model": {
    "trivial": { "component": "router", "effort": "minimal" },
    "medium":  { "component": "router", "effort": "medium" },
    "hard":    { "model": "claude-opus-4", "effort": "high" }
  }},
  "git": { "enabled": true, "mode": "suggest", "branch_management": true,
           "trace_branch": "corpocode/trace", "clean_branch": "corpocode/clean",
           "commit_per_write": true, "promote_on": ["verifier_clean","unit_boundary"] },
  "backends": { "knowledgeGraph": "graphify", "contextStore": "openviking", "memoryStore": "native" },
  "telemetry": { "enabled": false }
}
```

---

## 5. Modular abstractions

### 5.0 Shared (`src/types/common.ts`)
```typescript
export type Millis = number;
export interface Pingable { ping(): Promise<boolean>; }
export interface RetryPolicy { maxAttempts: number; baseDelayMs: Millis; maxDelayMs: Millis; jitter: boolean; retryableKinds: string[]; }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000, jitter: true, retryableKinds: ["rate_limit","timeout","network","daemon_restart"] };
```

### 5.1 Provider (`src/providers/types.ts`)
```typescript
export type ProviderKind = "anthropic" | "anthropic-cli" | "google" | "openai" | "openrouter" | "ollama";
export interface Message { role: "user" | "assistant"; content: string; }
export interface ChatInput { system: string; messages: Message[]; maxTokens?: number; responseFormat?: "text" | "json"; jsonSchema?: object; temperature?: number; timeoutMs?: Millis; }
export interface ChatOutput { text: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: Millis; providerId: ProviderKind; model: string; finishReason: "stop" | "length" | "timeout" | "error"; }
export type ProviderErrorKind = "auth" | "rate_limit" | "timeout" | "invalid_response" | "network" | "model_unavailable";
export class ProviderError extends Error {
  constructor(public kind: ProviderErrorKind, public providerId: ProviderKind, message: string, public retryable: boolean, public cause?: unknown) { super(message); }
}
export interface Provider extends Pingable {
  readonly id: ProviderKind; readonly model: string; readonly modelTier: "fast" | "balanced";
  chat(input: ChatInput): Promise<ChatOutput>;
}
export type ComponentName = "router" | "retrieval" | "compactor" | "filter" | "verifier";
export interface ProviderRegistry { forComponent(name: ComponentName): Provider; all(): Provider[]; }
export function buildRegistry(config: CorpoConfig): ProviderRegistry;
```

Requirements: each adapter wraps its SDK, normalizes all failures into `ProviderError` with correct `kind`/`retryable`, honors `DEFAULT_RETRY`, and computes `costUsd` locally from `pricing.ts` (do not trust provider-reported cost). `temperature` default 0. `timeoutMs` default 30000. `responseFormat:"json"` must return parseable JSON.

Provider matrix:
| id | default model | SDK / transport | structured output | auth | cost |
|---|---|---|---|---|---|
| anthropic | claude-haiku-4-5-20251001 | @anthropic-ai/sdk | tool-use / prefill | ANTHROPIC_API_KEY | pricing.ts |
| anthropic-cli | claude-haiku-4-5 | spawn `claude --print --output-format json` | parse stdout JSON | user CLI session | pricing.ts |
| google | gemini-2.5-flash | @google/generative-ai | JSON mode | GEMINI_API_KEY | pricing.ts |
| openai | gpt-5-nano (fallback gpt-4o-mini) | openai | JSON mode + schema | OPENAI_API_KEY | pricing.ts |
| openrouter | user-set | openai (baseURL override) | model-dependent | OPENROUTER_API_KEY | pricing.ts/headers |
| ollama | user-set | ollama | JSON where supported | none (loopback) | 0 |

OpenRouter impl = thin extension of openai impl (same client, different baseURL/defaults).

### 5.2 KnowledgeGraph (`src/backends/graph/types.ts`)
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
export interface KnowledgeGraph extends Pingable {
  readonly id: string;
  scoreFiles(prompt: string, opts: { limit: number }): Promise<ScoredFile[]>;
  getNode(name: string): Promise<GraphNode | null>;
  getNeighbors(nodeId: string, opts?: { depth?: number; edgeKinds?: EdgeKind[] }): Promise<Neighborhood>;
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;
  query(query: string, opts: { budget: number }): Promise<Subgraph>;
  ensureBuilt(repoRoot: string): Promise<void>;
  refresh(repoRoot: string): Promise<void>;
}
export function buildKnowledgeGraph(config: CorpoConfig): KnowledgeGraph;   // selects by config.backends.knowledgeGraph
```

### 5.3 ContextStore (`src/backends/context/types.ts`)
```typescript
export type Tier = "L0" | "L1" | "L2";
export type ResourceKind = "memory" | "resource" | "skill";
export interface Resource { uri: string; kind: ResourceKind; tier: Tier; content: string; tokens: number; score?: number; children?: string[]; }
export interface TreeEntry { uri: string; kind: ResourceKind | "directory"; abstract?: string; childCount?: number; }
export interface FindResult { query: string; tier: Tier; resources: Resource[]; trajectory?: string[]; }
export interface ContextStore extends Pingable {
  readonly id: string;
  find(query: string, opts: { tier: Tier; limit: number; root?: string }): Promise<FindResult>;
  load(uri: string, tier: Tier): Promise<string>;
  write(uri: string, content: string, opts?: { kind?: ResourceKind }): Promise<void>;
  tree(uri: string, opts?: { depth?: number }): Promise<TreeEntry[]>;
  grep(pattern: string, opts?: { root?: string }): Promise<Resource[]>;
  start(): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
}
export function buildContextStore(config: CorpoConfig): ContextStore;       // selects by config.backends.contextStore
```

### 5.4 MemoryStore (`src/backends/memory/types.ts`) — native only
```typescript
export type MemoryKind = "decision" | "mistake" | "rule" | "approach";
export interface Scope { project: string; workspaceCascade: boolean; }
export interface Memory { id: string; kind: MemoryKind; text: string; files?: string[]; createdAt: number; supersededBy?: string; outcomes?: { passed: boolean; at: number }[]; }
export interface ScoredMemory extends Memory { score: number; }
export interface MemoryInput { kind: MemoryKind; text: string; files?: string[]; sessionId: string; }
export interface ConsolidationResult { captured: number; superseded: number; }
export interface MemoryStore extends Pingable {
  readonly id: string;            // "native"
  recall(opts: { query?: string; file?: string; kinds?: MemoryKind[]; scope: Scope; limit: number }): Promise<ScoredMemory[]>;
  capture(m: MemoryInput): Promise<void>;
  consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult>;
  recordOutcome(o: { recalledIds: string[]; passed: boolean; sessionId: string }): Promise<void>;
}
export function buildMemoryStore(config: CorpoConfig): MemoryStore;
```

Native impl (`backends/memory/native.ts`):
- Store: flat JSON at `~/.corpocode/memory/<project>.json`; embeddings in a sibling file; embeddings produced via `Provider` (component `retrieval`).
- `recall` score = semantic relevance × recency decay × outcome weight; filter by `kinds`/`file`; exclude any record with `supersededBy` set; honor `workspaceCascade`.
- `consolidate`: extract typed memories from transcript; for each, if it reverses an existing memory, set the existing one's `supersededBy` to the new id (do not delete). Return counts.
- Decay/expiry: `mistake` and `rule` never expire; `decision` and `approach` decay by recency.
- `recordOutcome`: append `{passed, at}` to each recalled memory's `outcomes`; update recall weighting.
- Robustness: corrupt/missing store → `recall` returns `[]` without throwing.

---

## 6. Caretaker-agent interfaces

### 6.1 SessionReader (`src/session/types.ts`)
```typescript
export interface ThoughtState { intent: string; approach?: string; openQuestions: string[]; recentDecisions: string[]; entities: string[]; }
export interface RetrievalCues { query: string; files: string[]; kinds?: MemoryKind[]; }
export interface SessionReader {
  lineOfThought(sessionId: string, transcriptPath: string): Promise<ThoughtState>;   // cached per session, updated incrementally
  filePurpose(sessionId: string, file: string): Promise<string | null>;              // null ⇒ caller asks user
  retrievalCues(sessionId: string): Promise<RetrievalCues>;
}
```
Read-only over the transcript. One cheap-model pass per update; cache by `sessionId`; cost/latency must stay roughly flat as transcript grows (incremental, not full re-read).

### 6.2 MolarEditEngine (`src/molar/types.ts`) — used by verifier and design-review
```typescript
export type Tenet = "M" | "O" | "L" | "A" | "R" | "E" | "D" | "I" | "T";
export interface TenetCheck { tenet: Tenet; name: string; appliesTo(file: { path: string }): boolean; prompt: string; }
export interface TenetFinding { tenet: Tenet; ok: boolean; severity: "info" | "warn" | "block"; message: string; confidence: number; }
export interface MolarEditEngine {
  activeTenets(): Tenet[];                                  // from config.molar_edit.active_tenets
  verify(files: string[]): Promise<TenetFinding[]>;         // fan-out 1 check family / active tenet (parallel) then merge
  review(designContext: string): Promise<TenetFinding[]>;   // fan-out 1 subagent / active tenet at breakpoint
}
```
`corpocode-tenet-*` plugin packages register additional `TenetCheck`s.

### 6.3 GitManager (`src/git/types.ts`)
```typescript
export type GitMode = "suggest" | "auto";
export type PromoteSignal = "verifier_clean" | "unit_boundary" | "tests_passed";
export interface CommitSet { files: string[]; message: string; rationale: string; }
export interface BranchPair { trace: string; clean: string; }
export interface GitManager {
  ensureBranches(name: string): Promise<BranchPair>;
  commitWrite(file: string, opts: { sessionId: string; mode: GitMode }): Promise<void>;   // TRACE: 1 commit / PostToolUse write
  planPromotion(repoRoot: string, since: string): Promise<CommitSet[]>;                    // group trace range → logical sets
  promote(sets: CommitSet[], mode: GitMode): Promise<void>;                                // CLEAN: squash sets onto clean branch
  conflicts(repoRoot: string): Promise<string[]>;                                          // surface only
}
```
Forbidden everywhere: force-push, history rewrite, hard reset. `planPromotion` grouping is checklist-decomposed (1 pass/file → logical bucket; deterministic aggregate). Promotion messages generated from section diff + `ThoughtState`.

### 6.4 DocGenerator (`src/docs/types.ts`)
```typescript
export interface WhatCodeDoes {
  impacts: string[]; touches: string[]; risks: string[]; futureConsiderations: string[];
  input: { params: string; structure: string; mutabilityIfChanged: string };
  transformation: { how: string; purpose: string };
  output: { structure: string; considerations: string };
}
export interface DocGenerator {
  inlineDocs(file: string, symbol: string): Promise<string>;
  whatCodeDoes(file: string, symbol: string): Promise<WhatCodeDoes>;   // 1 cheap pass per facet
  refresh(changedFiles: string[]): Promise<void>;                      // re-generate records staled by a change
}
```
`touches` resolved via `KnowledgeGraph`, not guessed.

### 6.5 selectModelEffort (`src/router/effort.ts`)
```typescript
export type Difficulty = "trivial" | "medium" | "hard";
export type Effort = "minimal" | "medium" | "high";
export interface ModelEffortChoice { difficulty: Difficulty; providerComponent?: ComponentName; model?: string; effort: Effort; }
export function selectModelEffort(difficulty: Difficulty, config: CorpoConfig): ModelEffortChoice;   // reads config.effort
```

---

## 7. Hook layer

### Envelopes (`hooks/envelope.ts`)
Zod schemas for: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`. Each payload includes `session_id` and `transcript_path`. Validate stdin before any handler runs; on validation failure, exit 0 with empty output.

### Dispatch (`hooks/dispatch.ts`)
1. Read `argv[2]` (hook name from `corpocode hook <name>`).
2. Read stdin to completion; parse JSON; validate against the matching envelope schema.
3. Call the handler (router/filter/verifier/compactor/etc.).
4. Write `hookSpecificOutput` JSON to stdout via `hooks/response.ts`.
5. Wrap everything in a top-level try/catch: any unhandled error → exit 0 with empty `additionalContext` (never break a host turn).

### Injection tags (in `additionalContext`)
- `<middle-management recommendation>…</middle-management recommendation>` — categorizer output.
- `<middle-management retrieved-context>…</middle-management retrieved-context>` — aggregated KnowledgeGraph + ContextStore + MemoryStore results.
- File-read slice + memory warnings injected at `PreToolUse` as `additionalContext`.

### Shims (per platform, written by install)
One shim per hook event under the platform's hook dir; `.sh` (mac/linux) or `.ps1` (windows); body = `exec corpocode hook <name>`. Register in the platform's settings (e.g. `~/.claude/settings.json`).

---

## 8. Component behavior (imperative)

### session/reader.ts (UserPromptSubmit + every hook)
Read transcript at `transcript_path`; produce/refresh `ThoughtState` for `session_id`; expose `filePurpose` and `retrievalCues`. Cache and update incrementally.

### router (UserPromptSubmit)
- `heuristics.ts` (stage 1, free): tokenize prompt; if trivial and `router.trivial_early_exit`, early-exit (`stage2_invoked=false`, `cost_usd=0`). Else primary scoring via `graph.scoreFiles(prompt+lineOfThought, { limit: router.heuristic_candidate_limit_files })`. Keep a string-overlap fallback for the window before first graph build.
- `ranker.ts` (stage 2): system prompt = candidate set + `ThoughtState`; `registry.forComponent("router").chat()`; parse with `output-schema.ts`; validate every suggested skill/agent/file ∈ candidate set. Output fields: `type`, `complexity`, `breakpoint:boolean`, `delegate_to?`, `dispatch_retrieval:boolean`, plus `model`/`effort` from `selectModelEffort`.
- Also at turn start: `memory.recall({ query, kinds:["decision","approach"], scope, limit })`.
- Emit `<middle-management recommendation>` + recalled decisions via `response.ts`.

### retrieval (UserPromptSubmit, if `dispatch_retrieval`)
- `planner.ts`: select template by `type` from `templates/`; build checklist; fold `retrievalCues` into each item's query. If no template matches, make ONE constrained selection call from a fixed menu of item kinds.
- `fanout.ts`: run items in parallel (`Promise.all`), cap `max_parallel_instances`, per-item timeout `per_item_timeout_ms`, fresh provider call each.
- `item-handler.ts`: map item kind → one abstraction call: `get_node|get_neighbors|find_path|query_graph` → KnowledgeGraph; `ov_find` → ContextStore.find/load; `mem_recall` → MemoryStore.recall.
- `aggregator.ts`: dedupe file refs; rank by item confidence × priority; truncate to `package_token_budget`. Optional coherence pass only if `coherence_pass`.
- Emit `<middle-management retrieved-context>`.

### filter + inject (PreToolUse)
- `policies.ts`: deny-list (e.g. `rm -rf ~`, writes to `/etc`), always-allow (read-only cmds, common test runners), soft (classifier decides).
- `classify.ts`: return `deny | allow | ask`; dispatcher sets `hookSpecificOutput.permissionDecision`. (Phase 1: log/advisory only; teeth in Phase 2.)
- `inject.ts` (Read/Glob/Grep): get purpose via `session.filePurpose` (if `null`, emit a brief clarifying question instead of guessing); run a relevance pass bounded by `KnowledgeGraph` neighborhood + purpose; inject focused slice + `memory.recall({ file, kinds:["mistake","rule"] })` warnings. If relevance pass is low-confidence, inject nothing and let the full read proceed. Categorizer classification decides whether interception applies (targeted edit = slice; exploration = whole).

### verifier (PostToolUse)
- `worker.ts`: for each active tenet, run its `TenetCheck`(s) whose `appliesTo(file)` is true, in parallel, fresh provider call each, per-check timeout 8000ms.
- `aggregator.ts`: any `{ok:false}` → `TenetFinding`; list by tenet; a single high-confidence `block` → `continue:false, stopReason:"CorpoCode verifier: MOLAR-EDIT violation"`. On failure also `memory.capture({kind:"mistake", files:[file]})` and `memory.recall` to flag repeats.
- Emit one `verifier_check` log line per check (tenet, verdict, confidence, latency).

### review/team.ts (UserPromptSubmit, if `breakpoint`)
`MolarEditEngine.review(designContext)` → one subagent per active tenet → aggregate → inject design feedback before the model commits.

### git (PostToolUse + Stop)
- PostToolUse write → `commitWrite(file)` (TRACE branch), honoring `git.mode`/`commit_per_write`.
- Stop, if `promote_on` signals satisfied (verifier clean and/or unit boundary and/or tests passed) → `planPromotion` + `promote` (CLEAN branch).
- `ensureBranches(name)` creates the trace/clean pair named from categorizer classification.

### compactor (Stop)
- `sliding-window.ts`: compute compactable region from `sliding_window`; never include preserved turns.
- Primary: `context.write("viking://agent/memories/<session>/<turn>.md", digest, {kind:"memory"})` (`compaction.backend:"openviking"`).
- Also: `memory.consolidate(transcript, scope)` + `memory.recordOutcome(...)`.
- Defensive: on OpenViking failure, `memdir.ts` writes digest to `~/.claude/memdir/session-summaries/`. `memdir` is opt-in primary only via config.

### docs/generator.ts (Stop / parallel)
On touched units: `inlineDocs` + `whatCodeDoes` record written beside code; `refresh` staled records in the same change.

### loops/skillgen.ts (Stop / `corpocode skillify`)
Read `mistake`/`approach` memories; write candidate-skill memos to `~/.claude/memdir/corpocode-candidates/`; `corpocode skillify` promotes to `~/.claude/skills/`.

---

## 9. Backends — adapters

### graphify (`backends/graph/graphify-adapter.ts`)
Spawn `python -m graphify.serve graphify-out/graph.json` as a child process; speak MCP over stdio; cache process per repo root.
| interface method | graphify call |
|---|---|
| scoreFiles | MCP `query_graph(prompt)` → filter `kind==="file"` → rank by `centrality` → cap `limit` |
| getNode | MCP `get_node(name)` (null on miss) |
| getNeighbors | MCP `get_neighbors(id, depth)` (filter `edgeKinds` client-side) |
| findPath | MCP `shortest_path(from,to)` (null if disconnected) |
| query | MCP `query_graph(q)` with budget; set `truncated` |
| ping | MCP initialize / trivial `query_graph` |
| ensureBuilt | CLI `graphify .` if `graphify-out/graph.json` absent |
| refresh | CLI `graphify .` |
Unused: `triage_prs`, `get_pr_impact`.

### openviking (`backends/context/openviking-adapter.ts`)
HTTP client to `localhost:1933`; one restart-on-connection-refused retry (`daemon_restart`) before erroring.
| interface method | OpenViking call |
|---|---|
| find | `ov find` / `POST /find` (tier, limit); set `trajectory` |
| load | `GET` URI at tier |
| write | `ov add-resource` / write into `viking://agent/memories/...` |
| tree | `ov tree` / `GET /tree` (`abstract` from L0) |
| grep | `ov grep` |
| health/ping | `ov status` / `GET /health` |
| start | spawn `openviking-server` |
`ov.conf` generated from `config.json` (provider key/model → OpenViking litellm embedding/VLM) at install/`--repair`.

### memory native
See §5.4.

Both vendor backends are required (not silent-fallback). `native.ts` for graph/context are stubs (Phase 5).

---

## 10. Data flow per turn (ordered)

1. **UserPromptSubmit**: session.lineOfThought → categorizer stage1 (`graph.scoreFiles`) → stage2 ranker (+ `selectModelEffort`) → `memory.recall(decisions,approaches)`; if `dispatch_retrieval`: retrieval (KnowledgeGraph/ContextStore/MemoryStore) → aggregate; if `breakpoint`: design-review. Inject recommendation + retrieved-context + recalled decisions + design feedback. Return.
2. Main model reads injected context, acts.
3. **PreToolUse** (per call): if Read/Glob/Grep → inject (purpose via session, slice via KnowledgeGraph, warnings via `memory.recall(file,…)`); if safe Bash → allow; else deny/ask.
4. Tool executes.
5. **PostToolUse**: verifier (per-tenet fan-out; `memory.capture` on failure); git `commitWrite` if file write.
6. Repeat 3–5 or model replies.
7. **Stop** (background): compactor (`context.write` + `memory.consolidate` + `recordOutcome`); doc generator; git promote if signaled.

Everything reaches the model only as hook `additionalContext`.

---

## 11. CLI commands

| command | behavior |
|---|---|
| `corpocode install [--platform <name>] [--all] [--dry-run] [--skip-backends] [--repair]` | write shims + register hooks; install `haiku-helper` agent and `corpocode-router` skill; provision backends (unless `--skip-backends`). Idempotent. `--dry-run` prints plan only. `--repair` regenerates `ov.conf` etc. Platforms: claude-code, codex, opencode, cursor, gemini-cli. |
| `corpocode hook <name>` | dispatch a hook (used by shims). |
| `corpocode doctor` | run checks in order: (1) config schema, (2) secrets readable, (3) provider reachability (1-token call on default), (4) hook wiring (shims + settings registration), (5) graphify (CLI on PATH, `graphify-out/graph.json` present, MCP responsive), (6) OpenViking (port 1933, config valid), (7) Python toolchain version, (8) memory dir writable. Red checks print the `corpocode install --repair` remedy. |
| `corpocode stats [--json] [--days N]` | read NDJSON log; cost per component & provider; savings vs no-CorpoCode baseline; error rates. |
| `corpocode skillify` | promote candidate memos → skills. |
| `corpocode review` | weekly: read log, find overridden classifications and misfiring checks, propose config tweaks as a PR. |
| `corpocode upgrade [--refresh-deps]` | update package; `--refresh-deps` re-pins/rebuilds backends. |
| uninstall | remove shims + config; optionally stop daemon; `--purge` removes Python tools + `graphify-out/`. |

---

## 12. Logging (`log/ndjson.ts`)

Append one JSON line per hook to `~/.corpocode/logs/corpocode.ndjson`. Never throw on log error. Disabling logging (config) makes calls no-ops.

Common fields: `ts`, `event`, `session_id`, `component`, `cost_usd`, `latency_ms`, `provider`, `model`.
Events & key extra fields:
- `router`: `stage2_invoked`, `stage1_candidates`, `decision`.
- `session`: `line_of_thought` (`intent`, `entities`, …).
- `retrieval` (summary) + `retrieval_item` (`kind`, `confidence`, `timed_out`).
- `verifier` (summary) + `verifier_check` (`tenet`, `verdict`, `confidence`).
- `review` (summary) + `review_check` (`tenet`).
- `compaction`: `backend`.
- `git`: `branch` (trace/clean), `op` (commit/promote), `files`.

---

## 13. MOLAR-EDIT tenet checks (`verifier/tenets/`)

One module per tenet exporting `TenetCheck`(s); single-purpose prompt; `appliesTo` file pattern. `strictness`/`active_tenets` from config.

| tenet | check focus | appliesTo |
|---|---|---|
| M Maintainability | change isolated to needed files; accurate names; named magic values; no dead/commented code | changed source |
| O Observability | critical paths emit metrics; real readiness checks; trace IDs across async | changed source |
| L Logging | structured logs; errors logged once with context; no secrets/PII | changed source |
| A Atomicity | unit does one thing, named in ≤5 words; call graph is a line | changed source |
| R Responsiveness | ≤375px viewport; keyboard-complete; alt/labels; color not sole signal; APIs return structure | UI files only (`off_for_non_ui` default off) |
| E Extensibility | new code swappable behind an abstraction; core logic separated | changed source |
| D Documentation | ADR for decisions; why-comments; commit message present; no stale docs | changed source + docs |
| I In-flight | timeout/retry/fallback on external calls; graceful degradation; tested off-paths | changed source |
| T Testing | regression test per bug; failure paths tested; behavioral asserts | changed source + tests |

---

## 14. Build order (milestones)

- **Phase 1**: package scaffold + esbuild bin; envelope schemas + dispatch; all five `Provider` impls + registry + pricing + conformance suite; config load/schema/paths/secrets; declare KnowledgeGraph/ContextStore/MemoryStore interfaces; graphify adapter; memory native impl + `recall` wired into categorizer; session reader feeding categorizer; two-stage router + `selectModelEffort`; filter + verifier in recommend (log-only) mode; `install --platform claude-code` + graphify/openviking provisioning; `doctor`; `stats`; NDJSON logger + cost tracker.
- **Phase 2**: filter teeth (deny/allow/ask); MOLAR-EDIT verifier per-tenet fan-out; HCA compactor (openviking + memdir) + sliding-window enforcement; retrieval worker (checklist fan-out, all 3 abstractions, cue-guided); openviking adapter; context injector (file-read interception + purpose + memory warnings); design-review team; dynamic model/effort honored on spawn; MemoryStore `capture`/`consolidate`/`recordOutcome` + supersession.
- **Phase 3**: multi-platform install (codex/opencode/cursor/gemini-cli); git two-branch model (trace commits + clean promotion); doc generator; skillgen + `corpocode review`; auto-route to subagents.
- **Phase 4**: public npm release; opt-in telemetry; plugin API (`corpocode-template-*`, `corpocode-tenet-*` auto-discovered at startup); perf; docs.
- **Phase 5**: native graph (`web-tree-sitter`) + native context (SQLite/LMDB + Provider tiering); flip `backends` defaults to `native`; drop Python toolchain from install. (MemoryStore already native.)

---

## 15. Acceptance criteria

1. `corpocode install` is idempotent; `--dry-run` mutates nothing; clean install on Node 20 & 22 across mac/linux/windows.
2. `corpocode doctor` runs all checks; missing backend → red check + repair hint.
3. Provider conformance suite passes for every adapter: non-empty text; `json` mode parses; `timeoutMs:1` → `ProviderError{kind:"timeout",retryable:true}`; bad key → `{kind:"auth",retryable:false}`; `costUsd` matches pricing table; `ping` true when healthy.
4. Router: trivial prompt → log `stage2_invoked=false, cost_usd=0`; non-trivial → `stage2_invoked=true`, `stage1_candidates.files` includes a structurally-related file not named in the prompt, `decision.context_files_to_preload ⊆ candidates`; recommendation block injected.
5. Session reader: intent persists across a later terse prompt and shapes `stage1_candidates`; per-hook cost/latency stays flat as transcript grows; obvious file purpose → carried on slice; unknown purpose → clarifying question; retrieval item query contains line-of-thought terms.
6. Filter teeth: auto-deny stops a destructive command pre-model; auto-allow suppresses the prompt.
7. Verifier: an edit violating two tenets → one `verifier` summary + one `verifier_check` per tenet, parallel (summary latency ≈ slowest, not sum), both surfaced; one broken check doesn't stop the others; removing a tenet from `active_tenets` stops its check.
8. Backend conformance (graphify, openviking): `scoreFiles` deterministic ordering; `getNode`/`getNeighbors`/`findPath`/`query` well-formed on a fixture; `find`/`load`/`tree`/`write` round-trip at L0/L1/L2; `ping` reflects daemon health.
9. MemoryStore: `capture`→`recall({query})` ranks it; `recall({file,kinds:["mistake"]})` file-scoped; `consolidate` on a reversing transcript sets `supersededBy` and the old memory leaves recall; `mistake` survives decay, stale `decision` down-ranked; `recordOutcome` shifts scores; fresh session recalls prior decisions; corrupt store → empty recall, no throw; embeddings via configured Provider.
10. Compactor: runs on both backends; produces valid summaries; on daemon kill, one restart attempt then `backend=openviking` or `backend=memdir`, never a session error; preserved turns never compacted.
11. Retrieval: medium prompt → `retrieval` summary + one `retrieval_item` per item; `items_succeeded==checklist_items`; summary latency ≈ single item (parallel); killing graphify mid-run → that item `timed_out=true`, others succeed, package returns; retrieved-context block within `package_token_budget`.
12. Design-review: breakpoint prompt → one `review_check` per active tenet (parallel), feedback injected before the write; subset `active_tenets` → only those fire.
13. Git two-branch: three writes → three atomic trace commits (one file each), middle revert clean; finished two-concern section + promote signal → two clean commits while trace retains granular history; never force-push/rewrite/hard-reset; `suggest` stages+messages without committing/promoting, `auto` applies.
14. Doc generator: writes inline docs + what-code-does record; signature edit refreshes the record in the same change.
15. Multi-platform: `install` on ≥3 platforms beyond Claude Code each produces correct shims/registry and the expected `hookSpecificOutput` on a reference prompt.
16. Plugin API: `corpocode-template-*` / `corpocode-tenet-*` packages auto-register and appear in `doctor`.
17. Telemetry: default `enabled:false` → no network egress on a full turn; `true` → only documented aggregate fields, banner in `doctor`.

---

## 16. Constraints

- Git: never force-push, rewrite history, or hard-reset.
- MemoryStore: never indexes code structure (KnowledgeGraph) or does tiered doc retrieval/transcript compression (ContextStore).
- Hooks must never break a host turn (top-level catch → exit 0 empty).
- Consumers call interfaces only, never adapters.
- Upper-Management: not implemented this build.

# `corpocode` — CorpoCode Backend Interfaces (Detailed Design Spec)

Companion to the main plan (`corpocode.md`). Where the plan describes the architecture in prose, this document specifies the four modular boundaries as concrete TypeScript contracts: `Provider` (the LLM abstraction — the muscle), and the three knowledge abstractions `KnowledgeGraph` (structural index, reference adapter: graphify), `ContextStore` (tiered reference material, reference adapter: OpenViking), and `MemoryStore` (the experiential layer — native, no adapter).

The governing rules are the same for all four:

1. **Consumer-driven.** Each interface exposes only the operations the package's own components (router, retrieval worker, compactor, filter, verifier) actually call — never the full surface of the underlying vendor.
2. **Conformance-tested.** A single shared test suite per interface runs against every implementation. Shipping a new implementation (the planned native versions) means passing the same suite the vendor adapter passes today.
3. **Adapter now, native later.** Each interface ships initially with a vendor adapter (`graphify-adapter.ts`, `openviking-adapter.ts`) and an LLM-provider matrix. Native pure-TypeScript implementations are a planned Phase 5; the interface boundary is fixed now so the swap is mechanical.

All methods are async and return plain JSON-serializable shapes (no class instances cross the boundary) so that an implementation could later run out-of-process, in a worker, or over IPC without changing callers.

---

## 0. Shared conventions

```typescript
// src/types/common.ts

/** A token-count estimate (byte/4 + per-model adjustment); never a billing figure. */
export type TokenEstimate = number;

/** Milliseconds since epoch or a duration, disambiguated at the call site. */
export type Millis = number;

/** Every backend exposes a cheap liveness probe used by `corpocode doctor` and hot-path guards. */
export interface Pingable {
  ping(): Promise<boolean>;
}

/** Normalized retry policy honored by every Provider and backend adapter. */
export interface RetryPolicy {
  maxAttempts: number;       // default 3
  baseDelayMs: Millis;       // default 500
  maxDelayMs: Millis;        // default 8000
  jitter: boolean;           // default true
  retryableKinds: string[];  // error `kind`s considered retryable
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
  retryableKinds: ["rate_limit", "timeout", "network", "daemon_restart"],
};
```

---

## 1. `Provider` — LLM abstraction

The LLM boundary. Every cheap-model call in the package goes through this. The interface is deliberately narrow: short system prompt, a small message list, optional structured output, no streaming, no images — because that is the entire shape of what the router, retrieval items, compactor, filter, and verifier ever need.

### 1.1 Interface

```typescript
// src/providers/types.ts
import { Pingable, Millis } from "../types/common";

export type ProviderKind =
  | "anthropic"
  | "anthropic-cli"   // shells out to the `claude` binary; no API key
  | "google"
  | "openai"
  | "openrouter"      // OpenAI-compatible; user picks the model
  | "ollama";         // local loopback; no auth; cost = 0

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ChatInput {
  system: string;
  messages: Message[];
  maxTokens?: number;             // default set per component
  responseFormat?: "text" | "json";
  jsonSchema?: object;            // used when responseFormat==="json" and the provider supports schemas
  temperature?: number;          // default 0 (deterministic classification)
  timeoutMs?: Millis;            // default 30000
}

export interface ChatOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;                // computed from pricing.ts, NOT trusted from the provider response
  latencyMs: Millis;
  providerId: ProviderKind;
  model: string;
  finishReason: "stop" | "length" | "timeout" | "error";
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "invalid_response"
  | "network"
  | "model_unavailable";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    public providerId: ProviderKind,
    message: string,
    public retryable: boolean,
    public cause?: unknown,
  ) {
    super(message);
  }
}

export interface Provider extends Pingable {
  readonly id: ProviderKind;
  readonly model: string;
  readonly modelTier: "fast" | "balanced";

  chat(input: ChatInput): Promise<ChatOutput>;
}
```

### 1.2 Per-provider adapter notes

| Adapter | Default model | SDK | Structured output | Auth | Cost |
| --- | --- | --- | --- | --- | --- |
| `anthropic` | `claude-haiku-4-5-20251001` | `@anthropic-ai/sdk` | tool-use / prefill | `ANTHROPIC_API_KEY` | from `pricing.ts` |
| `anthropic-cli` | `claude-haiku-4-5` | spawn `claude --print --output-format json` | parse JSON from stdout | user's CLI session | from `pricing.ts` (best-effort) |
| `google` | `gemini-2.5-flash` | `@google/generative-ai` | JSON mode | `GEMINI_API_KEY` | from `pricing.ts` |
| `openai` | `gpt-5-nano` (fallback `gpt-4o-mini`) | `openai` | JSON mode + JSON schema | `OPENAI_API_KEY` | from `pricing.ts` |
| `openrouter` | user-selected | `openai` (baseURL override) | model-dependent | `OPENROUTER_API_KEY` | from `pricing.ts` / OpenRouter headers |
| `ollama` | user-selected (e.g. `qwen2.5-coder:7b`) | `ollama` | JSON mode where the model supports it | none (loopback) | `0` |

Each adapter normalizes failures into `ProviderError` with the correct `kind`/`retryable`, and computes `costUsd` locally so `corpocode stats` numbers are comparable across providers.

### 1.3 Registry

```typescript
// src/providers/registry.ts
import { Provider } from "./types";
import { LpfConfig } from "../config/schema";

export type ComponentName = "router" | "retrieval" | "compactor" | "filter" | "verifier";

export interface ProviderRegistry {
  /** Resolve the configured provider for a component (config.components[name] -> config.providers[key]). */
  forComponent(name: ComponentName): Provider;
  /** All distinct providers in use (for `corpocode doctor` reachability sweeps). */
  all(): Provider[];
}

export function buildRegistry(config: LpfConfig): ProviderRegistry;
```

### 1.4 Conformance contract (`tests/providers/conformance.test.ts`)

Run against every adapter. Asserts: a fixed prompt returns non-empty text; `responseFormat:"json"` returns parseable JSON; a 1ms `timeoutMs` raises `ProviderError{kind:"timeout",retryable:true}`; a bad key raises `ProviderError{kind:"auth",retryable:false}`; `costUsd` matches the pricing-table computation for known token counts; `ping()` is true when healthy.

---

## 2. `KnowledgeGraph` — structural-index abstraction

Reference adapter: **graphify** (`/safishamsi/graphify`). Graphify builds a knowledge graph from a folder — code via tree-sitter AST extraction (no API calls), docs/PDFs via an LLM — persists it to `graphify-out/graph.json`, and exposes both a CLI and an MCP server. The package consumes the MCP server's tools (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `get_pr_impact`, `triage_prs`) and the CLI (`graphify .`, `graphify query`, `graphify hook install`).

The interface captures only what the prefilter and retrieval worker need. Graphify's PR-triage tooling (`triage_prs`) is deliberately **not** on the interface; if a future consumer needs it, the interface grows once across all implementations.

### 2.1 Supporting types

```typescript
// src/backends/graph/types.ts
import { Pingable } from "../../types/common";

/** Graphify tags extracted relationships by how confidently they were derived. */
export type Confidence = "extracted" | "inferred" | "ambiguous";

export type NodeKind =
  | "file" | "function" | "class" | "method" | "variable"
  | "module" | "concept" | "doc" | "table" | "endpoint";

export interface GraphNode {
  id: string;                 // stable graph identifier
  name: string;               // symbol or file name
  kind: NodeKind;
  path?: string;              // file path when applicable
  span?: { startLine: number; endLine: number };
  summary?: string;           // LLM-extracted one-liner for non-code nodes
  centrality?: number;        // "god-node-ness"; higher = more connected
  metadata?: Record<string, unknown>;
}

export type EdgeKind =
  | "calls" | "imports" | "defines" | "references"
  | "inherits" | "implements" | "reads" | "writes" | "relates_to";

export interface GraphEdge {
  from: string;               // node id
  to: string;                 // node id
  kind: EdgeKind;
  confidence: Confidence;
  weight?: number;
}

export interface ScoredFile {
  path: string;
  score: number;              // 0..1 relevance to the prompt
  nodeId: string;             // graph node backing this file
  reason?: string;            // e.g. "calls the retry helper"
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];         // nodes within `depth` of center
  edges: GraphEdge[];         // edges among center + nodes
  depth: number;
}

export interface GraphPath {
  from: string;
  to: string;
  nodes: GraphNode[];         // ordered along the path
  edges: GraphEdge[];         // ordered connecting edges
  length: number;             // hop count
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  query: string;              // the query that produced it
  budgetTokens: number;       // requested cap
  truncated: boolean;         // whether results were cut to fit budget
}
```

### 2.2 Interface

```typescript
export interface KnowledgeGraph extends Pingable {
  readonly id: string;        // "graphify" | "native"

  /** Prefilter primary path: rank file candidates by structural relevance to the prompt. */
  scoreFiles(prompt: string, opts: { limit: number }): Promise<ScoredFile[]>;

  /** Retrieval checklist item: locate a symbol/file by name. */
  getNode(name: string): Promise<GraphNode | null>;

  /** Retrieval checklist item: callers and callees (and other edges) of a node. */
  getNeighbors(
    nodeId: string,
    opts?: { depth?: number; edgeKinds?: EdgeKind[] },
  ): Promise<Neighborhood>;

  /** Retrieval checklist item: is there a structural path between two entities? */
  findPath(fromId: string, toId: string): Promise<GraphPath | null>;

  /** Retrieval checklist item: natural-language query returning a budget-bounded subgraph. */
  query(query: string, opts: { budget: number }): Promise<Subgraph>;

  // --- lifecycle (used by install/doctor, not by hot-path consumers) ---

  /** Build `graphify-out/graph.json` if absent. Idempotent. */
  ensureBuilt(repoRoot: string): Promise<void>;

  /** Rebuild after a large change (e.g. post `git reset`). */
  refresh(repoRoot: string): Promise<void>;
}
```

### 2.3 graphify adapter mapping

| Interface method | graphify call | Notes |
| --- | --- | --- |
| `scoreFiles(prompt, {limit})` | MCP `query_graph(prompt)` → filter `kind==="file"` nodes, rank by `centrality`, cap to `limit` | the prefilter's primary scoring path |
| `getNode(name)` | MCP `get_node(name)` | returns `null` on miss |
| `getNeighbors(id, {depth})` | MCP `get_neighbors(id, depth)` | `edgeKinds` filtered client-side if the tool returns all |
| `findPath(from, to)` | MCP `shortest_path(from, to)` | `null` if disconnected |
| `query(q, {budget})` | MCP `query_graph(q)` with budget; set `truncated` if capped | retrieval worker's broad item |
| `ping()` | MCP `initialize` handshake, or a trivial `query_graph("")` | |
| `ensureBuilt(root)` | CLI `graphify .` if `graphify-out/graph.json` missing | run during `corpocode install` |
| `refresh(root)` | CLI `graphify .` | also wired to graphify's git hook by `corpocode install` |

Adapter implementation notes: the adapter spawns `python -m graphify.serve graphify-out/graph.json` as a child process and speaks MCP over stdio; it caches the process per repo root and exposes `ping()` as the handshake. `get_pr_impact` / `triage_prs` are intentionally unused.

### 2.4 Native implementation sketch (Phase 5)

`src/backends/graph/native.ts` built on `web-tree-sitter` for AST extraction (cross-platform, no Python), persisting to `corpocode-out/graph.json`. Non-code nodes (docs, PDFs) extracted through the existing `Provider` interface. Must pass §2.5 unchanged.

### 2.5 Conformance contract (`tests/backends/graph/conformance.test.ts`)

Against a fixture repo: `scoreFiles` returns deterministically-ordered candidates including a file that is structurally related but not named in the prompt; `getNode` round-trips a known symbol and returns `null` for a missing one; `getNeighbors` returns the known callers of a fixture function; `findPath` finds a known path and returns `null` for disconnected nodes; `query` respects the token budget and sets `truncated` correctly; `ping` reflects daemon health.

---

## 3. `ContextStore` — tiered-context abstraction

Reference adapter: **OpenViking** (`/volcengine/openviking`). OpenViking is a context database for agents organized under a `viking://` virtual filesystem, served by a localhost daemon (`openviking-server`, port 1933) with a CLI (`ov find`, `ov tree`, `ov grep`, `ov add-resource`, `ov status`). Its defining feature is **tiered context loading** — every resource is processed into L0 (abstract, ~100 tokens), L1 (overview, ~2k tokens), and L2 (full original) — plus **directory recursive retrieval** and **automatic session management** (it compresses conversation content and extracts long-term memory on its own).

The interface captures what the compactor and retrieval worker need: tiered find, tiered load, write, tree, and grep. OpenViking's conversational surface (`ov chat`) is **not** on the interface.

### 3.1 Supporting types

```typescript
// src/backends/context/types.ts
import { Pingable } from "../../types/common";

/** L0 ≈ 100-token abstract, L1 ≈ 2k-token overview, L2 = full original. */
export type Tier = "L0" | "L1" | "L2";

/** viking:// namespaces: agent/user memories, shared resources, skills. */
export type ResourceKind = "memory" | "resource" | "skill";

export interface Resource {
  uri: string;                // e.g. "viking://agent/memories/<session>/<turn>.md"
  kind: ResourceKind;
  tier: Tier;                 // which tier this payload represents
  content: string;            // payload at that tier
  tokens: number;             // size of this tier's content
  score?: number;             // relevance from a find()
  children?: string[];        // child URIs (for recursive drill-down)
}

export interface TreeEntry {
  uri: string;
  kind: ResourceKind | "directory";
  abstract?: string;          // L0 one-liner for quick scanning
  childCount?: number;
}

export interface FindResult {
  query: string;
  tier: Tier;                 // the tier the resources were returned at
  resources: Resource[];      // ranked
  trajectory?: string[];      // recursive-retrieval path, for observability/debugging
}
```

### 3.2 Interface

```typescript
export interface ContextStore extends Pingable {
  readonly id: string;        // "openviking" | "native"

  /** Retrieval semantic path: ranked resources at a chosen tier (L0 to scan, escalate as needed). */
  find(query: string, opts: { tier: Tier; limit: number; root?: string }): Promise<FindResult>;

  /** Escalate a single resource to a deeper tier (L0 abstract -> L1 overview -> L2 detail). */
  load(uri: string, tier: Tier): Promise<string>;

  /** Compactor primary path: write a digest into agent memory; daemon derives L0/L1/L2. */
  write(uri: string, content: string, opts?: { kind?: ResourceKind }): Promise<void>;

  /** Enumerate a namespace; `abstract` gives the L0 line per entry without loading bodies. */
  tree(uri: string, opts?: { depth?: number }): Promise<TreeEntry[]>;

  /** Literal/substring search across resource bodies. */
  grep(pattern: string, opts?: { root?: string }): Promise<Resource[]>;

  // --- lifecycle (used by install/doctor) ---

  /** Start `openviking-server` if it isn't running. Idempotent. */
  start(): Promise<void>;

  health(): Promise<{ up: boolean; version?: string }>;
}
```

### 3.3 OpenViking adapter mapping

| Interface method | OpenViking call | Notes |
| --- | --- | --- |
| `find(q, {tier, limit, root})` | `ov find` / HTTP `POST /find` with tier + limit | uses OpenViking's recursive directory retrieval; surface its path as `trajectory` |
| `load(uri, tier)` | HTTP `GET` on the URI at the requested tier | L0/L1/L2 selection |
| `write(uri, content, {kind})` | `ov add-resource` / HTTP write into `viking://agent/memories/...` | daemon auto-generates L0/L1/L2 layers |
| `tree(uri, {depth})` | `ov tree` / HTTP `GET /tree` | `abstract` populated from each node's L0 |
| `grep(pattern, {root})` | `ov grep` | |
| `ping()` / `health()` | `ov status` / HTTP `GET /health` | |
| `start()` | spawn `openviking-server` | run during `corpocode install` |

Adapter implementation notes: a plain HTTP client against `localhost:1933` with one restart-on-connection-refused retry (`daemon_restart` retryable kind) before surfacing an error. The compactor's primary path is `write(`viking://agent/memories/${session}/${turn}.md`, digest)`; the router's next turn injects the L0/L1 layers via `find`/`load`, not the full digest.

**`ov.conf` generation.** `corpocode install` writes `~/.openviking/ov.conf` from `~/.corpocode/config.json` so the user authenticates once. The mapping resolves the embedding + VLM providers OpenViking needs from the corpocode provider the user already configured (via OpenViking's `litellm` provider): the configured provider's API key and a sensible embedding/VLM model for that vendor are written into `ov.conf`. A regeneration runs on `corpocode install --repair`.

### 3.4 Native implementation sketch (Phase 5)

`src/backends/context/native.ts` built on a local SQLite or LMDB index with explicit L0/L1/L2 generation driven through the `Provider` interface — so a user with any configured provider gets embeddings/summaries for free, with no separate VLM configuration and no Python daemon. Must pass §3.5 unchanged.

### 3.5 Conformance contract (`tests/backends/context/conformance.test.ts`)

Against a seeded store: `write` then `find` round-trips a resource and returns it ranked at `L0`; `load` escalates the same resource to `L1` and `L2` with monotonically larger `tokens`; `tree` lists a namespace with non-empty `abstract`s and without loading bodies; `grep` finds a known substring; `health.up` is true when the daemon is running and false when stopped; `start()` brings a stopped daemon back.

---

## 4. `MemoryStore` — experiential-memory abstraction

The third knowledge abstraction, and the one that is **native from day one** — there is no vendor project to shell out to, so unlike `KnowledgeGraph` and `ContextStore` there is no adapter and no Phase 5 swap. It answers "what have we learned doing this, and what did we decide?" — the experiential continuity neither sibling can carry, since both describe artifacts (code, docs) that exist outside the agent's own activity. Its scope is deliberately narrow: it does **not** index code structure (that is `KnowledgeGraph`) and does **not** do tiered document retrieval or transcript compression (that is `ContextStore`); it owns only typed memories, supersession, and outcomes.

### 4.1 Supporting types

```typescript
// src/backends/memory/types.ts
import { Pingable } from "../../types/common";
import { Transcript } from "../../compactor/types";   // reused, not redefined

export type MemoryKind = "decision" | "mistake" | "rule" | "approach";

export interface Scope {
  project: string;            // per-project store at ~/.corpocode/memory/<project>.json
  workspaceCascade: boolean;  // also recall workspace-level memories above the project
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;               // the decision/mistake/rule/approach, stated plainly
  files?: string[];           // file anchors (mistakes and rules are often file-scoped)
  createdAt: number;
  supersededBy?: string;      // id of the memory that replaced this one (set by consolidate)
  outcomes?: { passed: boolean; at: number }[];   // appended by recordOutcome
}

export interface ScoredMemory extends Memory {
  score: number;              // semantic relevance × recency decay × outcome weight
}

export interface MemoryInput {
  kind: MemoryKind;
  text: string;
  files?: string[];
  sessionId: string;
}

export interface ConsolidationResult {
  captured: number;           // new memories written this pass
  superseded: number;         // existing memories marked superseded this pass
}
```

Decay and expiry are kind-dependent: `mistake` and `rule` never expire (they stay protective); `decision` and `approach` decay by recency so old context fades from recall.

### 4.2 Interface

```typescript
export interface MemoryStore extends Pingable {
  readonly id: string;        // "native" — no vendor adapter

  // READ — hot path (categorizer, context injector)
  recall(opts: {
    query?: string;           // prompt-relevance recall
    file?: string;            // file-anchored recall
    kinds?: MemoryKind[];     // narrow to "mistake"/"rule" before an edit
    scope: Scope;
    limit: number;
  }): Promise<ScoredMemory[]>;

  // WRITE incremental — as things happen (verifier, context injector)
  capture(m: MemoryInput): Promise<void>;

  // WRITE consolidation — Stop hook; builds continuity via supersession
  consolidate(transcript: Transcript, scope: Scope): Promise<ConsolidationResult>;

  // FEEDBACK — closes the cost-gate loop
  recordOutcome(o: { recalledIds: string[]; passed: boolean; sessionId: string }): Promise<void>;
}
```

### 4.3 Native implementation notes

No daemon, no Python, nothing added to `corpocode install`. Records live in a flat per-project JSON file with a small sibling embeddings file; embeddings are produced through the configured `Provider`, so an OpenAI user gets OpenAI vectors and an Ollama user local ones. `consolidate` extracts typed memories from the session and, before writing each, checks it against existing memories — a new `decision` that reverses an old one sets the old one's `supersededBy` rather than leaving both to contradict at recall time. `recordOutcome` appends to the outcome log and updates recall weighting so channels that never precede a passing result get tuned down — the same cost-gate discipline as the retrieval team. A missing or corrupt store degrades to empty recall without throwing (the I tenet).

### 4.4 Hook-to-capability mapping

| Hook | Call | Capability | How it steers the main model |
| --- | --- | --- | --- |
| `UserPromptSubmit` (categorizer) | `recall({query, scope})` | ranked recall of relevant decisions/approaches | opens the turn with what was already decided/learned — the model continues instead of re-deriving |
| `PreToolUse` (context injector) | `recall({file, kinds:["mistake","rule"]})` | file-anchored mistake + rule recall | warns before the edit lands — prevents the mistake rather than catching it after |
| `PostToolUse` (verifier) | `capture()` + `recall` on failure | records new mistakes; recognizes repeats | breaks error loops — "same ENOENT as three turns ago" |
| `Stop` (compactor) | `consolidate(transcript, scope)` | session mining + supersession | turns the session into typed memory and resolves contradictions, so next session's recall is current |

### 4.5 Conformance contract (`tests/backends/memory/conformance.test.ts`)

`capture` then `recall({query})` returns the memory ranked by relevance; `recall({file, kinds:["mistake"]})` returns only that file's mistakes; `consolidate` on a reversing transcript sets `supersededBy` and the superseded memory leaves subsequent recall; a `mistake` survives recency decay while a `decision` is down-ranked; `recordOutcome` shifts recall scores in the expected direction; a fresh session recalls the prior session's decisions (continuity); a corrupt store yields empty recall without throwing; embeddings route through the configured `Provider`.

---

## 5. Config surface

```jsonc
// ~/.corpocode/config.json (excerpt — full schema in src/config/schema.ts)
{
  "providers": {
    "default":     { "kind": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "cheap_local": { "kind": "ollama", "model": "qwen2.5-coder:7b", "host": "http://localhost:11434" }
  },
  "components": {
    "router": "default", "retrieval": "default",
    "compactor": "cheap_local", "filter": "default", "verifier": "default"
  },
  "backends": {
    "knowledgeGraph": "graphify",   // | "native"
    "contextStore":   "openviking", // | "native"
    "memoryStore":    "native"      // native-only; no vendor adapter
  }
}
```

```typescript
// src/backends/graph/registry.ts
export function buildKnowledgeGraph(config: LpfConfig): KnowledgeGraph; // selects by config.backends.knowledgeGraph
// src/backends/context/registry.ts
export function buildContextStore(config: LpfConfig): ContextStore;     // selects by config.backends.contextStore
// src/backends/memory/registry.ts
export function buildMemoryStore(config: LpfConfig): MemoryStore;       // one impl today; symmetric with the others
```

Defaults are the vendor adapters in every phase before the Phase 5 native swap, except `memoryStore`, which is native from day one and has no swap. Flipping a graph/context default is a one-word config change once the native implementation passes its conformance suite; no consumer call site changes.

---

## 6. How consumers use the interfaces

```typescript
// stage-1 prefilter (src/router/heuristics.ts)
const graph = buildKnowledgeGraph(config);
const files = await graph.scoreFiles(prompt, { limit: config.router.heuristic_candidate_limit_files });

// moment categorizer opens the turn with what was already decided (src/router/ranker.ts)
const priorDecisions = await memory.recall({ query: prompt, kinds: ["decision", "approach"], scope, limit: 5 });

// context injector warns before an edit lands (src/filter/inject.ts)
const warnings = await memory.recall({ file: targetFile, kinds: ["mistake", "rule"], scope, limit: 3 });

// retrieval checklist item handler (src/retrieval/item-handler.ts)
switch (item.kind) {
  case "get_node":      return shape(await graph.getNode(item.arg));
  case "get_neighbors": return shape(await graph.getNeighbors(item.arg, { depth: 1 }));
  case "find_path":     return shape(await graph.findPath(item.from, item.to));
  case "query_graph":   return shape(await graph.query(item.arg, { budget: 800 }));
  case "ov_find":       return shape(await context.find(item.arg, { tier: "L0", limit: 5 }));
}

// verifier records a new mistake and recognizes repeats (src/verifier/worker.ts)
if (!finding.ok) await memory.capture({ kind: "mistake", text: finding.message, files: [touchedFile], sessionId });

// compactor: write context AND consolidate experiential memory (src/compactor/worker.ts)
await context.write(`viking://agent/memories/${sessionId}/${turn}.md`, digest, { kind: "memory" });
await memory.consolidate(transcript, scope);   // mines + supersedes; builds continuity
// after the test run, close the cost-gate loop
await memory.recordOutcome({ recalledIds, passed: testsPassed, sessionId });
```

No consumer references `graphify-adapter` or `openviking-adapter` directly; they resolve an interface from the registry and call it. This is the single property that makes the planned native swap a non-event for the rest of the codebase — and `MemoryStore`, already native, needs no swap at all.

---

## 7. Caretaker interfaces

Beyond the four modular boundaries above, each caretaker agent gets a small interface in the same consumer-driven, conformance-tested style. These are not swap boundaries (no vendor adapters) — they're internal contracts that keep each agent atomic (the A tenet) and independently testable (the T tenet). They group by caretaker: **Middle-Management** owns the `SessionReader` (§7.5) and `selectModelEffort` (§7.4) and consumes the moment-categorizer's `Provider`-backed router; **Housekeeping** owns the `MolarEditEngine`'s verify path (§7.1), `GitManager` (§7.2), and `DocGenerator` (§7.3); the `MolarEditEngine`'s review path is Middle-Management's design-review team. **Upper-Management** (WIP) has no interface yet — it will reuse `MemoryStore` and the `Provider` (pointed at an expensive tier) when it is designed.

### 7.1 MOLAR-EDIT — shared by verifier and design-review team

```typescript
// src/molar/types.ts
export type Tenet = "M" | "O" | "L" | "A" | "R" | "E" | "D" | "I" | "T";

export interface TenetCheck {
  tenet: Tenet;
  name: string;                       // e.g. "atomicity:one-thing-per-unit"
  appliesTo(file: { path: string }): boolean;   // e.g. R only on UI files
  prompt: string;                     // single-purpose, derived from the tenet rubric
}

export interface TenetFinding {
  tenet: Tenet;
  ok: boolean;
  severity: "info" | "warn" | "block";
  message: string;                    // structured: what, where, why, what to check next (L tenet)
  confidence: number;                 // 0..1
}

/** Verifier (post-edit/periodic) and design-review team (at breakpoints) both consume these. */
export interface MolarEditEngine {
  activeTenets(): Tenet[];                                   // from config.molar_edit.active_tenets
  verify(files: string[]): Promise<TenetFinding[]>;          // fan-out one TenetCheck family per active tenet
  review(designContext: string): Promise<TenetFinding[]>;    // fan-out one subagent per active tenet at a breakpoint
}
```

Both methods fan out one provider call per active tenet via `Promise.all`, then merge deterministically. `verify` runs after edits and periodically; `review` runs before work at a categorized breakpoint. Community `corpocode-tenet-*` packages register additional `TenetCheck`s into the same engine.

### 7.2 GitManager

```typescript
// src/git/types.ts
export type GitMode = "suggest" | "auto";

/** Signals that a major section is finished and can be promoted to the clean branch. */
export type PromoteSignal = "verifier_clean" | "unit_boundary" | "tests_passed";

export interface CommitSet {
  files: string[];
  message: string;                    // structured: what changed, why, what to watch for (D tenet)
  rationale: string;
}

export interface BranchPair {
  trace: string;                      // e.g. "corpocode/trace" — one commit per write
  clean: string;                      // e.g. "corpocode/clean" — promoted finished sections
}

export interface GitManager {
  /** Create/switch the trace+clean branch pair for a unit of work (named from the categorizer). */
  ensureBranches(name: string): Promise<BranchPair>;

  /** TRACE: commit exactly one PostToolUse file write as its own atomic commit. */
  commitWrite(file: string, opts: { sessionId: string; mode: GitMode }): Promise<void>;

  /** CLEAN: when a section is finished, group the trace range into logical commit sets... */
  planPromotion(repoRoot: string, since: string): Promise<CommitSet[]>;
  /** ...and promote them onto the clean branch (squash) per mode. */
  promote(sets: CommitSet[], mode: GitMode): Promise<void>;

  /** Surface (never auto-resolve) conflicts. Destructive ops are out of scope. */
  conflicts(repoRoot: string): Promise<string[]>;
}
```

`commitWrite` is the trace branch's hot path — fired from `PostToolUse` for every `Write`/`Edit`, it stages just that file and commits with an auto-generated message, so the trace is a complete, revertable, bisectable record. `planPromotion` is the clean branch's curation step, fired when `config.git.promote_on` signals fire (verifier clean, a session-reader unit boundary, tests passed): it is checklist-decomposed — one cheap pass per changed file proposes its logical-change bucket, a deterministic aggregator forms the `CommitSet`s, and each message is generated from the section diff plus the line of thought. `promote` squashes those sets onto the clean branch. Force-push, history rewrite, and hard reset are deliberately absent from the interface; the trace branch's append-only fullness is what makes that restraint safe to live with.

### 7.3 DocGenerator

```typescript
// src/docs/types.ts
export interface WhatCodeDoes {
  impacts: string[];
  touches: string[];                  // resolved via KnowledgeGraph, not guessed
  risks: string[];
  futureConsiderations: string[];
  input: { params: string; structure: string; mutabilityIfChanged: string };
  transformation: { how: string; purpose: string };
  output: { structure: string; considerations: string };
}

export interface DocGenerator {
  /** Inline comments + cross-references for a touched unit. */
  inlineDocs(file: string, symbol: string): Promise<string>;
  /** The structured what-code-does record, one cheap pass per facet. */
  whatCodeDoes(file: string, symbol: string): Promise<WhatCodeDoes>;
  /** Refresh records that a change has staled (D tenet: no stale docs). */
  refresh(changedFiles: string[]): Promise<void>;
}
```

### 7.4 Dynamic model/effort selection

```typescript
// src/router/effort.ts
export type Difficulty = "trivial" | "medium" | "hard";
export type Effort = "minimal" | "medium" | "high";

export interface ModelEffortChoice {
  difficulty: Difficulty;
  providerComponent?: ComponentName;  // which configured provider to route to
  model?: string;                     // explicit override (e.g. a stronger model for hard moments)
  effort: Effort;                     // reasoning/thinking budget hint
}

/** Reads config.effort.difficulty_to_model; emitted as fields on the categorizer's output. */
export function selectModelEffort(difficulty: Difficulty, config: LpfConfig): ModelEffortChoice;
```

### 7.5 SessionReader — continuous transcript understanding

The shared Middle-Management faculty that reads the Claude Code session transcript and distills the main model's current line of thought, so the rest of the team steers *with* the model's own reasoning instead of re-deriving it. It reads from the `transcript_path` the hook envelope provides, caches per session, and updates incrementally at each hook.

```typescript
// src/session/types.ts
export interface ThoughtState {
  intent: string;            // what the model is currently trying to accomplish
  approach?: string;         // the approach it has settled on, if stated
  openQuestions: string[];   // questions the model is working through
  recentDecisions: string[]; // decisions visible in the transcript this session
  entities: string[];        // symbols/files/concepts in active play (seed retrieval)
}

export interface RetrievalCues {
  // distilled from ThoughtState; folded into KnowledgeGraph/ContextStore/MemoryStore queries
  query: string;
  files: string[];
  kinds?: ("decision" | "mistake" | "rule" | "approach")[];
}

export interface SessionReader {
  /** Running understanding of the main model's line of thought (cached per session). */
  lineOfThought(sessionId: string, transcriptPath: string): Promise<ThoughtState>;
  /** Why a file is about to be read, inferred from the transcript; null when not obvious (then ask). */
  filePurpose(sessionId: string, file: string): Promise<string | null>;
  /** Cues that guide and augment retrieval across the three knowledge abstractions. */
  retrievalCues(sessionId: string): Promise<RetrievalCues>;
}
```

`lineOfThought` is the categorizer's primary input; `filePurpose` scopes the context injector's extraction (and is the trigger for a clarifying question when it returns `null`); `retrievalCues` is what makes the retrieval team's queries reflect the model's current goal rather than the bare prompt. The SessionReader is read-only over the transcript and distinct from Housekeeping's compactor, which *writes* a compressed form of the same transcript at `Stop`.

These five interfaces complete the caretakers' agents: the **transcript reader** (`SessionReader`, §7.5) feeding the categorizer (the `Provider`-backed router from §1 plus `selectModelEffort`, opening each turn with `MemoryStore.recall`), the retrieval team and context injector (`KnowledgeGraph`, `ContextStore`, and `MemoryStore` from §2–4, with the injector pairing a transcript-derived file purpose and a focused slice with file-anchored mistake/rule recall), the MOLAR-EDIT engine (§7.1) driving both verifier and design review, the `GitManager` (§7.2), and the `DocGenerator` (§7.3). Every one is a thin orchestration over the same `Provider` and the three knowledge abstractions, decomposed into parallel single-purpose passes and aggregated deterministically — and all of them steer from the same continuously-read line of thought.

Use sequential thinking and superpowers continuously.
Use typescript-lsp