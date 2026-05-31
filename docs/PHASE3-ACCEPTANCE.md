# Phase 3 — Definition of Done → evidence

Maps every Phase 3 acceptance criterion (from `phase3.md`) to the code and tests that satisfy it.
`npm run verify` (build → `tsc --noEmit` → `vitest`) is green: **269 tests / 46 files**
(up from Phase 2's 238/39).

Phase 3 gives CorpoCode **reach** and **craftsmanship**: it runs across coding-agent platforms
through one thin adapter, and it leaves durable artifacts behind — a clean git history distilled from
the edit torrent, documentation drawn from the real call graph, skills mined from memory, and config
proposals drawn from its own logs — while dispatching specialist work to specialists. The governing
invariant widens from Phase 2's "fail open" to add a **governor**: *the user stays in control of
consequential, durable changes.* Git defaults to suggesting promotions; review proposes config diffs
it never applies; promoting a skill is a manual step; delegation defaults to recommending.

| # | Criterion (phase3.md) | Evidence |
| --- | --- | --- |
| 1 | Multi-platform install through one adapter layer: ≥3 platforms beyond Claude Code produce correct shims + registrations; a reference prompt yields the expected injected-context envelope on each; a platform missing a hook event installs the supported subset cleanly rather than failing | `src/install/platform.ts` (`PlatformAdapter`, `registerJsonHooks` parse/rewrite, `installPlatform`), `src/install/{claude-code-adapter,codex,opencode,cursor,gemini-cli}.ts`, `src/install/platform-registry.ts`, `src/hooks/platform-output.ts` (`serializeForPlatform`), `src/commands/install.ts` (`--all`); `tests/install/platform.test.ts` (7 — full vs reduced event sets, idempotent register, foreign-group preserved, per-platform envelope shapes, shims only for supported events + `--platform` marker, detect, unknown id) |
| 2 | Git two-branch model: three writes → three atomic single-file trace commits, the middle independently revertable; a finished two-concern section with the promote signal → two coherent clean commits while the trace keeps the granular record; `suggest` surfaces the plan, `auto` applies it; **no** destructive op under any config | `src/git/{types,plumbing,manager,hook}.ts` (temp-`GIT_INDEX_FILE` commits never touch the user's branch; `assertSafe` structurally refuses force-push/hard-reset/rebase/filter-branch); wired at `PostToolUse` (`src/verifier/handler.ts` → `recordWrite`) and `Stop` (`src/compactor/worker.ts` → `maybePromote`); `tests/git/manager.test.ts` (4) + `tests/git/post-tooluse.test.ts` (1 — live handler→trace commit) |
| 3 | Doc generator: a touched unit gets inline docs **and** a structured `WhatCodeDoes` record; a signature edit refreshes that record in the same change; `touches` is drawn from the KnowledgeGraph, not guessed | `src/docs/{types,symbols,generator,stop}.ts` (per-facet parallel fan-out, graph-resolved `touches`, `<file>.cc-doc.json` sidecar, signature-gated `refresh`/`document`); wired at `Stop` via `tracedFiles` → `runDocGeneration`; `tests/docs/generator.test.ts` (3 — writes inline+record with graph `touches`; signature edit refreshes in-change + idempotent re-doc costs nothing; refresh no-op / never throws) |
| 4 | Skill generator + review turn experience into reviewable artifacts: a recurring memory pattern surfaces as a candidate skill that `skillify` promotes on demand; `corpocode review` produces a config-change proposal from a log of misfires | `src/loops/{skillgen,skillify}.ts`, `src/commands/{skillify,review}.ts`, CLI wiring; review emits machine-applicable `ConfigPatch` proposals and **never** edits config; `tests/loops/skillgen.test.ts` (6 — mine→memo, empty no-op, promote-valid/skip-invalid, missing-dir no-op, slugify, frontmatter), `tests/commands/review.test.ts` (5 — noise + PR-ready patch, below-threshold, idle tenet, router pressure, time window) |
| 5 | Auto-delegation acts on the categorizer's long-standing `delegate_to`: a recommendation by default; auto-dispatch only where enabled **and** the platform supports subagents; a clean degrade to recommendation where it cannot | `src/router/delegation.ts` (`planDelegation`), `src/hooks/platform-output.ts` (`platformSupportsSubagents`), `delegation` config block (`src/config/schema.ts`), `src/router/handler.ts` (integration + `delegation` log), platform threaded through `src/hooks/{context,dispatch}.ts`; `tests/router/delegation.test.ts` (5 — null when nothing/disabled, suggest default, auto on capable platform, degrade on incapable) |

## Wiring

The `Stop` hook (`src/compactor/worker.ts`) now runs three things after compaction, each best-effort
and independently wrapped: `maybePromote` (git promotion at the natural unit boundary a Stop
represents), then `runDocGeneration` over `tracedFiles` (the files the trace branch holds beyond
clean). `PostToolUse` (`src/verifier/handler.ts`) records each write to the trace branch after the
verifier runs. The platform id is resolved once in `dispatch.ts` and carried on `HookContext`, so the
categorizer can gate auto-delegation on the host's real capabilities.

## The control principle, made concrete

- **Git**: `commit_per_write` records to the isolated trace branch automatically (safe — never touches
  the user's branch); `mode: suggest` (default) only *surfaces* a promotion plan; `mode: auto` applies
  it. Force-push, history rewrite, and hard reset are absent by construction.
- **Skills**: `corpocode skillify` only *writes candidates*; installing one into the skill library is
  the explicit `--promote` step.
- **Review**: emits PR-ready `ConfigPatch` proposals (e.g. `set molar_edit.strictness.A = "off"`); it
  never edits config itself.
- **Delegation**: defaults to a suggestion; escalates to a directive only under `mode: auto` on a
  subagent-capable platform.

## Notable correctness fix found by the live-wiring test

`tests/git/post-tooluse.test.ts` drives the real `PostToolUse` handler against a real temp git repo.
It confirmed the trace commit lands correctly — and caught that the `git` **log line** recorded the
absolute envelope path while the commit itself stored the repo-relative one. Fixed two ways: `relPath`
now returns git's own convention (forward slashes) everywhere, so messages, logs, and `git add`
arguments agree across platforms; and `recordWrite` returns the committed relative path so the handler
logs exactly what was stored (the L/O tenets — a log that matches the artifact and carries no absolute
host paths).

## Environment-limited verifications

The non–Claude-Code envelope shapes and settings paths are documented best-effort (see the honesty
note in `src/hooks/platform-output.ts` and `phase3.md` §1) and are verified structurally against the
adapter layer; confirming each against a live Codex/opencode/Cursor/Gemini-CLI install is a
per-platform integration step, not a code change. `corpocode review` produces the configuration-change
*proposal* (the PR body + machine-applicable patches); opening it as an actual GitHub PR is a thin
follow-on through the `github-automation-engineer` agent and is intentionally left to the user so the
audit stays advisory. Deferred Phase 4/5 items (npm release, telemetry, plugin auto-registration,
native graph/context backends) are intentionally absent.
