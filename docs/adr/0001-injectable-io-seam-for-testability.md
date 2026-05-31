# 1. Injectable I/O seams at every external boundary

- Status: accepted
- Date: 2026-05-30

## Context

CorpoCode's correctness is mostly about behavior at external boundaries — provider timeouts and
retries, graph queries, daemon health, file reads. None of those can be exercised with real network,
Python, or daemons in CI, yet they are exactly where bugs hide. The Testing and In-flight tenets
both demand that failure paths (timeout, 5xx, malformed input, daemon down) be tested as deliberately
as the happy path.

## Decision

Every module that does external I/O exposes a narrow, injectable seam, and the cross-cutting logic
lives above it:

- **Provider** adapters expose a `rawChat` seam; the shared `runner` owns timeout (race + abort),
  bounded jittered retry, `ProviderError` normalization, local cost computation, and the JSON
  contract. The conformance suite runs every adapter against controllable fakes.
- **graphify** adapter depends on a `GraphifyTransport` interface; tests inject an in-memory fake
  over a fixture graph. The real transport (spawned MCP-over-stdio) is integration-only.
- **MemoryStore** takes an injectable `Embedder`; provisioners take an injectable `CommandRunner`;
  the session reader and config take injectable clocks / env.

Vendor SDK calls sit behind the seam, dynamically imported, and are typed loosely at that one point
(a justified, commented `any`) so a patch-level SDK type change cannot break our typecheck.

## Consequences

- The failure-path assertions in the spec's acceptance criteria become ordinary unit tests.
- Adding a seventh provider means passing the existing conformance suite, not writing a new one.
- The cost is a little extra surface (a `rawChat`/transport/runner param on each adapter), accepted
  deliberately for the testability and In-flight guarantees it buys.

## Alternatives considered

- **Mock the vendor SDKs directly.** Rejected: couples tests to each SDK's internal shape and breaks
  on SDK upgrades; the seam is vendor-neutral.
- **Hit real endpoints in CI behind env-gated keys.** Kept as an optional future addition, but it
  can't be the primary suite — it is slow, flaky, and unavailable offline.
