// agent-engine AgentBackend — the in-repo, opencode-backed runtime that lands later (plan Phase 4).
// Stubbed now so config can already reference it and the conformance suite pins the same contract:
// it resolves fail-open (never throws) with a model_unavailable error until implemented.
import type { AgentBackend, AgentCall, AgentResult } from "../backend";

export function createAgentEngineBackend(): AgentBackend {
  const notReady = <T>(call: AgentCall<T>): AgentResult<T> => ({
    ok: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: call.model?.model ?? "agent-engine" },
    model: call.model ?? { providerKey: "agent-engine", model: "agent-engine" },
    error: { kind: "model_unavailable", message: "agent-engine backend not yet implemented (plan Phase 4)", retryable: false },
  });
  return {
    id: "agent-engine",
    invoke: async (call) => notReady(call),
    release: async () => {},
    health: async () => ({ up: false }),
    ping: async () => false,
    shutdown: async () => {},
  };
}
