# 3. Fail-open hook dispatch with an overall timeout

- Status: accepted
- Date: 2026-05-30

## Context

CorpoCode runs inside another agent's loop. A crash, a non-zero exit, or a hang in a hook could break
the host's turn. This is the single most important safety property of the whole system: a buggy or
failing CorpoCode must degrade to doing nothing, never to disrupting the model it is meant to help.

## Decision

`dispatchHook` wraps its entire flow:

1. Any unhandled error (malformed stdin, invalid envelope, a thrown handler, a bad config) is caught
   and turned into an empty `{}` response and a clean exit — the host turn proceeds untouched. A
   leading BOM on stdin is stripped before parsing (some shells/encoders prepend one).
2. Handler execution is additionally raced against an overall timeout budget, so a wedged backend
   cannot hang the hook even though individual calls already have their own (tighter) timeouts.
3. Errors are recorded to the structured log; when `CORPOCODE_DEBUG` is set they are also written to
   stderr (safe on a 0-exit hook — shown by the host, never fatal).

## Consequences

- The "malformed payload exits clean" and "a thrown handler exits clean" acceptance criteria hold by
  construction, verified by tests that deliberately break a handler.
- Every component below the dispatcher is free to throw on genuinely exceptional input rather than
  inventing degraded return values, because the dispatcher is the single circuit breaker.

## Amendment (Phase 2): the dispatcher catch does NOT cover async event emitters

The try/catch and the promise timeout only catch thrown errors and rejected promises. They do **not**
catch a Node `EventEmitter` `'error'` event with no listener — Node treats that as a fatal uncaught
exception that terminates the process, bypassing the dispatcher entirely. This surfaced in Phase 2:
the OpenViking adapter spawned `openviking-server`, and on a machine without it the `ChildProcess`
emitted `'error'` (ENOENT) with no handler, crashing the whole hook. The fix is local — every spawned
child must attach an `'error'` handler — but the principle is general: **fail-open at the dispatcher
is necessary but not sufficient; any code that spawns a process or attaches an emitter must handle its
`'error'` event at the source.** Guarded by a regression test that drives the real spawner against a
missing binary.

## Alternatives considered

- **Let exceptions propagate and rely on the host's own hook timeout/﻿error handling.** Rejected: it
  makes CorpoCode a bad citizen — some hosts surface hook errors to the user or abort the turn, which
  is exactly the disruption we must avoid.
- **Per-handler try/catch only, no overall timeout.** Rejected: catches errors but not hangs; a
  blocked backend would still stall the turn.
