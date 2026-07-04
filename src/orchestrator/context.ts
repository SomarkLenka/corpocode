// The orchestrator's agent wiring. Mirrors the hook channel's construction (src/hooks/context.ts)
// with one deliberate inversion: `config.agents.enabled` is IGNORED here. That flag exists to keep
// the agent seam dark inside someone else's turn (the hook channel); in orchestrator mode CorpoCode
// is the host — there is no host to protect, so the registry is built unconditionally. Engine
// selection still comes from the same `config.agents.task_backends`, so pointing `implement` at
// "agent-engine" moves the whole swarm to Codex/OpenCode with no parallel resolution path.
import { buildAgentRegistry, type AgentRegistry } from "../agents/registry";
import { createAnthropicCliAgent } from "../agents/backends/anthropic-cli";
import { createAgentEngineBackend } from "../agents/backends/agent-engine";
import type { ModelRef } from "../agents/backend";
import type { CorpoConfig } from "../config/schema";

export interface OrchestratorContextOptions {
  repoRoot: string;
}

export function buildOrchestratorAgents(config: CorpoConfig, opts: OrchestratorContextOptions): AgentRegistry {
  return buildAgentRegistry({
    backends: {
      "anthropic-cli": createAnthropicCliAgent({ repoRoot: opts.repoRoot }),
      "agent-engine": createAgentEngineBackend(),
    },
    taskBackends: config.agents.task_backends,
    defaultBackend: config.agents.default_backend,
  });
}

/**
 * Resolve an orchestrator role (config.orchestrator.roles) to the concrete ModelRef its agent calls
 * carry — the same resolution shape as effort.difficulty_to_model: `component` → config.components →
 * provider, explicit `model` overrides the provider's. Returns undefined when nothing resolves, so
 * the backend's own default (cheap) model applies rather than a guessed one.
 */
export function resolveRoleModel(config: CorpoConfig, role: string): ModelRef | undefined {
  const rc = config.orchestrator.roles[role];
  const componentKey = rc?.component ?? "um";
  const providerKey = (config.components as Record<string, string>)[componentKey] ?? "default";
  const provider = config.providers[providerKey];
  const model = rc?.model ?? provider?.model;
  if (!model) return undefined;
  return { providerKey, model };
}
