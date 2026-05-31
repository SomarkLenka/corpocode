# 2. A local, deterministic embedder is the MemoryStore default

- Status: accepted
- Date: 2026-05-30

## Context

The MemoryStore ranks recalled memories by semantic relevance, which needs embeddings. The interface
spec says embeddings should be "produced through the configured `Provider`." But the `Provider`
interface is deliberately narrow — `chat()` only — and not every provider has an embeddings API at
all (Anthropic, the default, does not). Forcing embeddings through `chat()` is impossible, and
requiring a second embedding credential contradicts the "authenticate once" goal.

The In-flight tenet also says a turn must never hard-depend on a remote service: `recall` runs on the
hot path of `UserPromptSubmit`, and it must not block on (or fail because of) an embedding endpoint.

## Decision

The MemoryStore depends on an `Embedder` interface, injected, defaulting to a dependency-free,
deterministic **local** embedder (the hashing trick: tokens hashed into a fixed-dimension signed
vector, L2-normalized so cosine similarity is a dot product). Recall therefore works offline, is
reproducible in tests, and never blocks on a network call.

A provider-backed embedder (OpenAI/Gemini/Ollama vectors for users who want them) is a clean future
addition behind the same `Embedder` seam, wired in a later phase — this is the deviation from the
literal "via the configured Provider" wording, made for the reasons above.

## Consequences

- Memory recall is functional, deterministic, and offline from day one (satisfies the corrupt-store,
  decay, and continuity acceptance tests without external services).
- Recall quality is lexical-ish rather than truly semantic until the provider-backed embedder lands;
  acceptable for Phase 1, where recall is a ranking aid over a small per-project store.

## Alternatives considered

- **Add `embed()` to `Provider`.** Rejected: Anthropic (the default) has no embeddings API, so the
  method would be unimplementable for the most common configuration, widening the interface for a
  capability not all providers have.
- **Require a separate embedding service.** Rejected: contradicts "authenticate once" and adds a
  hard remote dependency on a hot path.
