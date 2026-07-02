# Design — `pre-write` action-pattern (IntelligentRouter A2 / Phase 3)

**Date:** 2026-07-02
**Status:** Draft for review
**Scope:** The second live IntelligentRouter action-pattern. On a `Write`/`Edit`/`MultiEdit` at
`PreToolUse`, gather the file's blast radius (graph neighbors + file memories), run one read-only
`pre-write-guidance` agent, and inject architectural guidance ("what not to touch, how this breaks Y")
**before** the write lands. Reuses the `patterns/` contract and the `pattern` decision-event schema that
A1 (`bug-hunt`) established; ships dark behind `agents.enabled`.

> **Scope decision flagged for your review (see §9):** `docs/INTELLIGENT-ROUTER-PHASES.md` Phase 3 lists
> *two* units — `architectural-guidance` (inject now) **and** `deferred-actions` (a `pending-actions`
> disk record consumed at PostToolUse). This spec builds **`architectural-guidance` only** and documents
> `deferred-actions` as a designed-but-deferred follow-up (§8), because its only consumers (a pre-test
> agent, an inline-docs agent) are themselves Phase-5 capabilities that don't exist yet — building the
> record + drain plumbing now would be dead code with nothing to defer. If you want the plumbing in this
> increment anyway, say so and I'll fold in §8.

---

## 1. Goal

The write-path analog of `bug-hunt`. Before the expensive model commits a change, spend one cheap
read-only agent to read the target file's structural neighborhood and warn about breakage the diff can't
see: "the caller in `billing/charge.ts:88` assumes this returns cents, not dollars." The guidance is
**advisory** — injected as context, never blocking the write (§4.1). Flag off ⇒ `ctx.agents` is
`undefined`, the pattern is never reached, and `PreToolUse` output is byte-identical to today.

A POC that proves the write-path surface and reuses A1's substrate wholesale. Not a linter, not a gate.

---

## 2. Context: what already exists (compose, do not rebuild)

Grounded in a read-only survey of HEAD.

| Thing | Fact | File |
|---|---|---|
| `Intent` (`pre-write`) | `{ kind:"pre-write"; file; proposedContent?; sessionId; transcriptPath }` — already defined | `src/intelligence/types.ts:46` |
| `gather` (file-scoped) | centers on `graph.getNode(file)` + `getNeighbors` (blast radius) + `memory.recall({file})`, per-source fail-open | `src/intelligence/gather.ts:72-84` |
| task kind | `pre-write-guidance` already in `AGENT_TASK_KINDS` — **A2 is its first consumer** | `src/agents/backend.ts:30` |
| engine / synthesize | `run(plan, {forTask,log})`; `TAGS.intelligentRouter` injection tag (reused, per the "one tag" rule) | `src/intelligence/engine.ts:26`, `src/hooks/response.ts:27` |
| PreToolUse handler | `handlePreToolUse(env, ctx) → HookResponse`; Write/Edit currently fall through to `{}` / a toolbox route | `src/filter/handler.ts:21-39` |
| composition mirror | `composeUserPromptSubmit` factory + `mergeContext`; registered in `buildHandlers()` | `src/hooks/handlers.ts:70-113` |
| write-tool detection | `Write`/`Edit`/`MultiEdit`; file path at `tool_input.file_path` | `src/toolbox/route.ts:16,75`, `src/verifier/handler.ts:17-22` |
| config mirror | `agents.bug_hunt` slice shape | `src/config/schema.ts:193-202` |
| pattern reference impl | the four-piece contract + `pattern` event | `src/intelligence/patterns/bug-hunt.ts` |

**New deltas A2 introduces:** a `content`/`new_string` extractor (none exists — `tool_input` is untyped
and no handler reads proposed content today); a `composePreToolUse` wrapper; a generalized `mergeContext`
that stamps the right `hookEventName`; `src/intelligence/patterns/pre-write.ts`; an `agents.pre_write`
config slice; a `pre-write-guidance` prompt id; and a one-case extension to B1's `why` translation.

---

## 3. The action-pattern contract (unchanged from A1)

Same four atomic pieces under `src/intelligence/patterns/pre-write.ts`: pure **plan producer**, registered
**prompt id**, **synthesizer**, thin gated **handler adapter**. Reached only when `ctx.agents` is present.

---

## 4. `pre-write` design (`architectural-guidance`)

### 4.1 Behavior + the advisory rule

- Surface: `PreToolUse` for `Write`/`Edit`/`MultiEdit`. Intent `{kind:"pre-write", file, proposedContent}`.
- **Inject only — never `ask`/`deny`.** `PreToolUse` *can* block, but guidance is advisory: the response
  carries `additionalContext` only, never `permissionDecision`. A slow/failed/uncertain agent must never
  stall or veto a write. (This is the phases-doc default; flagged in §9 as a decision to confirm.)

### 4.2 Trigger gate (free, deterministic)

Two cheap checks before any agent spend:
1. **Write-tool check** (composition layer): not `Write`/`Edit`/`MultiEdit`, or no `file_path` → skip.
2. **Blast-radius check** (in the handler, after `gather`): if `gather` returns no graph node, no
   neighbors, and no file memories, there is nothing architectural to say → skip with
   `reason:"gate:no-blast-radius"`. `gather` is deterministic (no model call), so this gate is free and
   keeps the agent from firing on isolated/brand-new files. This is the `pre-write` analog of `bug-hunt`'s
   `isBugLike` gate — it makes guidance *rare and relevant* rather than firing on every keystroke.

### 4.3 Plan producer — `planPreWrite(intent, candidates, cfg) → OrchestrationPlan`

- **One** `pre-write-guidance` task (not a fan-out — the phases doc specifies a single guidance agent).
- `id`: the target file path. `call`: `{ component:"router", taskKind:"pre-write-guidance",
  task:<resolved prompt>, inputs:{ files:[target, ...top-`cfg.maxFiles` neighbor paths],
  reasoning:<change summary + capped proposedContent> }, tools:"read-only", session:"ephemeral",
  effort:"minimal", timeoutMs:cfg.perAgentMs, schema: GUIDANCE_SCHEMA }`.
- `inputs.files` carries **paths** the agent reads itself (the blast radius). `proposedContent` is the one
  thing not on disk (the write hasn't happened), so a **capped** copy (≤`cfg.maxProposedChars`, default
  2000) rides in `reasoning` — the documented, necessary exception to "paths not contents".
- `fanoutWidth: 1`. `judge`: keep iff `ok` **and** `warnings` is a non-empty array of shape-valid entries
  (defensive validation — the backend only parses, per A1). Empty warnings → nothing to inject.

`GUIDANCE_SCHEMA` (passed via `AgentCall.schema`):
```json
{
  "type": "object", "required": ["warnings"],
  "properties": {
    "warnings": {
      "type": "array",
      "items": {
        "type": "object", "required": ["claim", "severity"],
        "properties": {
          "claim": { "type": "string" },
          "severity": { "enum": ["info", "warn", "block"] },
          "refs": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```
(`severity:"block"` is a *label on the warning's importance*, not a permission decision — A2 still only injects.)

### 4.4 Prompt id — `pre-write-guidance`

Registered in `prompts/registry.ts` (`BUILTIN_PROMPTS`) + `prompts/catalog.ts` (`PROMPT_META`, path
`intelligence/pre-write-guidance.md`), exactly as A1 registered `bug-hunt-file-relevance`. Resolved via
`ctx.prompts.resolve("pre-write-guidance")` (no `{{placeholders}}` — the file paths and change ride in the
call's structured `inputs`). Intent: *"You are shown a file about to be edited, its structurally related
files (read them), and a summary of the proposed change. Warn ONLY about concrete breakage the diff can't
see — callers that rely on current behavior, invariants, contracts. Be terse and specific; cite files.
No style nits. Return only the schema; empty `warnings` if nothing is at risk."*

### 4.5 Synthesizer — `synthesizePreWriteGuidance(result, cfg) → string`

- Renders the surviving warnings under `TAGS.intelligentRouter` with a header
  (`Pre-write guidance for {file} — architectural risks before you write:`), highest-severity first
  (`block` > `warn` > `info`), each as `- [{severity}] {claim}` + ` (refs: {refs})` when present.
- Truncated to `cfg.maxInjectedTokens` (default 800, `length/4` estimate), dropping lowest-severity first;
  the top warning is always kept. Returns `""` when nothing survives → no injection.

### 4.6 Handler adapter — `handlePreWrite(envelope, ctx) → HookResponse`

```
handlePreWrite(env, ctx):
  target = extractPreWriteTarget(env)            // {file, proposedContent} | null (Write/Edit/MultiEdit)
  if !target: return {}
  intent = { kind:"pre-write", file: target.file, proposedContent: target.proposedContent, … }
  candidates = await gather(intent, {graph, memory, project, logger})
  if blastRadiusEmpty(candidates): emit skip("gate:no-blast-radius"); return {}
  plan = planPreWrite(intent, candidates, cfg)
  result = await raceDeadline(run(plan, {forTask: ctx.agents.forTask, log}), cfg.deadlineMs)
  block = synthesizePreWriteGuidance(result, cfg)
  emit pattern event (surface "PreToolUse")
  return block ? { hookEventName:"PreToolUse", additionalContext: block } : {}
```
- **Latency (synchronous, hard-bounded — same as A1).** Guidance is injected NOW (phases-doc mandate), so
  it's in the write's critical path. One agent, `per_agent_ms` (10s) primary bound, `deadline_ms` (15s —
  tighter than bug-hunt's 30s since it's a single call and blocks an edit) as the backstop race resolving
  to empty. Fully fail-open: any throw → `{}`.
- `extractPreWriteTarget`: Write → `tool_input.content`; Edit → `tool_input.new_string`; MultiEdit →
  join `tool_input.edits[].new_string`; file from `tool_input.file_path`. Mirrors `extractWrittenFile`
  (`verifier/handler.ts:17-22`), defensively typed.

### 4.7 Composition — `src/hooks/handlers.ts`

Wrap the base `PreToolUse` handler exactly as A1 wrapped `UserPromptSubmit`:
```
composePreToolUse(deps):
  base = await handlePreToolUse(env, ctx)        // filter: deny/allow/ask + injector — untouched
  if !ctx.agents || !ctx.config.agents.pre_write.enabled: return base
  if !isWriteTool(env.tool_name): return base    // free check
  guidance = await handlePreWrite(env, ctx)
  return mergeContext(base, guidance, "PreToolUse")
```
Registered as `PreToolUse: composePreToolUse()` in `buildHandlers()`. **`mergeContext` is generalized**
to take an optional `fallbackHook` (default `"UserPromptSubmit"`, preserving A1) so the merged response
stamps `hookEventName: "PreToolUse"` here. If `base` already carries a `permissionDecision` (a deny/ask
from the filter), `mergeContext` preserves it and still appends guidance — a denied command and pre-write
guidance never collide (different tools), but the merge is correct regardless.

---

## 5. Decision-event (reuses A1's `pattern` schema, extends B1's translation)

Emits the same `pattern` event pinned in A1, with `pattern:"pre-write"`, `surface:"PreToolUse"`,
`decision:"ran"|"skipped"`, `reason` (`gate:no-blast-radius` | `ran` | `no-warnings` | `deadline` |
`empty-candidates` | `error`), `files_considered` (neighbors handed to the agent), `warnings` (count),
`injected_tokens`, `cost_usd`, `latency_ms`.

Because B1's `why` renders bug-hunt-specific fields (`files_fanned`/`survivors`) for `pattern` events, A2
adds **one branch** to `describe()` in `src/commands/why.ts`: when `rec.pattern === "pre-write"`, render
`Ran: pre-write guidance — {warnings} warning(s), injected {injected_tokens} tokens.` (skipped path is
already generic). This is the intended compounding — the shared event schema, rendered per pattern.

---

## 6. Configuration

New `agents.pre_write` slice (Zod, all defaulted), mirroring `agents.bug_hunt`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | per-pattern off switch (within `agents.enabled`) |
| `max_files` | `4` | neighbor blast-radius files handed to the agent |
| `per_agent_ms` | `10000` | agent timeout (primary bound) |
| `deadline_ms` | `15000` | overall race backstop (tighter — it blocks a write) |
| `max_injected_tokens` | `800` | guidance truncation budget |
| `max_proposed_chars` | `2000` | cap on inline proposed content |

---

## 7. Testing — `tests/intelligence/patterns/pre-write.test.ts`

Mirrors `bug-hunt.test.ts` (fake `HookContext` with `ctx.agents`, fake `AgentBackend`, fake graph/memory).

1. **Guidance injected** — a Write to a file with graph neighbors + an agent returning warnings → response `additionalContext` under `intelligentRouter` contains the cited warnings.
2. **Flag-off parity** — `agents.enabled:false` ⇒ `composePreToolUse` output identical to the base filter handler (byte-for-byte) for a Write.
3. **No-blast-radius gate** — a Write to an isolated file (empty `gather`) skips the agent, emits `reason:"gate:no-blast-radius"`.
4. **Non-write tool** — a `Bash`/`Read` call is passed straight through to the base handler (no guidance).
5. **Advisory only** — the response never sets `permissionDecision`/`deny`, even when warnings are severe.
6. **Fail-open** — a throwing backend → clean base response, no guidance block.
7. **Deadline backstop** — an agent slower than `deadline_ms` → nothing injected, `reason:"deadline"`.
8. **Judge** — empty-warnings and shape-invalid results are dropped (→ `no-warnings`, no injection).
9. **`extractPreWriteTarget`** — pulls `content` (Write), `new_string` (Edit), joined `edits` (MultiEdit); caps proposed content at `max_proposed_chars`.
10. **read-only posture** — the emitted task asserts `tools:"read-only"`.
11. **B1 link** — extend `tests/commands/why.test.ts`: a `pattern` event with `pattern:"pre-write"` renders the pre-write prose (not the bug-hunt shape).

`npm run verify` stays green; existing `tests/{filter,verifier,hooks}` pass unchanged with the flag off.

---

## 8. Deferred sub-unit — `deferred-actions` (designed, NOT built in A2)

Documented so the design is settled when its first consumer lands (a Phase-5 pre-test or inline-docs
capability). **Not implemented here** (see §9 scope decision).

- At `PreToolUse`, when the pattern decides an action is better done *after* the write, append it to a
  `pending-actions` disk record keyed by **session + file**, mirroring `session/decision-cache.ts`
  (ensureDir + writeFileSync + try/catch; read + JSON.parse + null fallback) with a new
  `pendingActionsFile(sessionId, file, cwd?, env?)` helper in `config/paths.ts` (hash the file into the
  key before `safeSessionId`, per the `agentSessionFile` precedent). **New vs the mirror:** a
  best-effort `unlinkSync` consume step (decision-cache has no delete).
- Consumed at the **top of `handlePostToolUse`** — at `verifier/handler.ts:28`, *before* the
  `verify_on_edit` and no-tenets early-returns (so a verify-off repo still drains the record), gated on
  `ctx.agents`. Committed via the existing `recordWrite(ctx, file, sessionId)` (`git/hook.ts:38`).
- Open concretions (per phases doc): which actions run inline vs deferred; the scoped-write posture for a
  write-capable deferred agent (`--add-dir` sandbox vs diff-only).

---

## 9. Decisions flagged for your review

1. **Scope (main):** build `architectural-guidance` only now (recommended — §8 has no real consumer yet),
   or include the `deferred-actions` plumbing in this increment.
2. **Advisory vs gate:** guidance is **inject-only, never ask/deny** (phases-doc default). Confirm you
   don't want `severity:"block"` warnings to actually `ask` before the write.
3. **Proposed-content cap:** 2000 chars inline (the diff isn't on disk, so some inline content is
   unavoidable). Confirm the cap / whether Edit should send only `new_string` vs a fuller diff.
4. **Single agent vs fan-out:** one `pre-write-guidance` agent (phases-doc "one agent"). A future variant
   could fan out one agent per high-risk neighbor; out of scope here.

---

## 10. Files touched

**New**
- `src/intelligence/patterns/pre-write.ts` — the four pieces + `extractPreWriteTarget` + `isWriteTool` + `GUIDANCE_SCHEMA` + `PreWriteConfig`.
- `tests/intelligence/patterns/pre-write.test.ts`.

**Modified**
- `src/hooks/handlers.ts` — `composePreToolUse`; generalize `mergeContext(base, extra, fallbackHook?)`; wire `PreToolUse: composePreToolUse()`.
- `src/prompts/registry.ts` + `catalog.ts` — register `pre-write-guidance`.
- `src/config/schema.ts` — `agents.pre_write` slice.
- `src/commands/why.ts` (+ `tests/commands/why.test.ts`) — one `pattern` branch for `pre-write`.

**Unchanged (must not need edits)**
- `src/intelligence/engine.ts`, `gather.ts`, `synthesize.ts`; `src/filter/handler.ts` (composed, untouched); `src/verifier/handler.ts` (untouched in this scope).

---

## 11. Invariants

- **Gated + dark:** reached only when `ctx.agents` present; flag off ⇒ byte-identical PreToolUse output; tests assert parity.
- **Advisory:** never emits `permissionDecision` — a write is never blocked or delayed-to-veto by guidance.
- **Read-only + recursion guard:** the guidance agent is `tools:"read-only"`, spawned `--bare` by the backend.
- **Fail-open:** `gather` per-source, `invoke` never throws, the handler catches all, the deadline race resolves.
- **Structure-only synthesis:** no HTML/markup; one `intelligentRouter`-tagged block.
```
