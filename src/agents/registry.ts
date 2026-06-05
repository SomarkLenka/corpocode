// Resolve which AgentBackend handles a given task kind. Mirrors providers/registry.ts: a per-task
// lookup over registered backends with a default, plus a synchronous availability check so callers
// degrade gracefully when no backend is loaded. Backends are passed in already-built (the config→
// backend wiring lives in buildContext, like the provider registry), keeping this layer pure and
// trivially testable. anthropic-cli is the default; agent-engine is opt-in per task.
import type { AgentBackend, AgentTaskKind } from "./backend";

export type AgentBackendKey = "anthropic-cli" | "agent-engine";

export interface AgentRegistry {
  /** The backend configured for a task kind (its default-backend fallback when unmapped). */
  forTask(kind: AgentTaskKind): AgentBackend;
  /** Every distinct registered backend, for a doctor reachability sweep. */
  all(): AgentBackend[];
  /** Whether the task's backend reports usable — used to gate the agent stage, fail-open. */
  availableFor(kind: AgentTaskKind): boolean;
}

export interface AgentRegistryOptions {
  backends: Partial<Record<AgentBackendKey, AgentBackend>>;
  taskBackends?: Partial<Record<AgentTaskKind, AgentBackendKey>>;
  defaultBackend?: AgentBackendKey;
  /** Synchronous loaded-check per backend key (no network); defaults to "present in backends". */
  loaded?: (key: AgentBackendKey) => boolean;
}

export function buildAgentRegistry(opts: AgentRegistryOptions): AgentRegistry {
  const defaultKey: AgentBackendKey = opts.defaultBackend ?? "anthropic-cli";
  const keyForTask = (kind: AgentTaskKind): AgentBackendKey => opts.taskBackends?.[kind] ?? defaultKey;
  const isLoaded = opts.loaded ?? ((key) => Boolean(opts.backends[key]));

  const backendFor = (kind: AgentTaskKind): AgentBackend => {
    const want = keyForTask(kind);
    // Fail open: if the configured backend is missing/unloaded, fall through to any other loaded one.
    const chosen = opts.backends[want] ?? Object.values(opts.backends).find(Boolean);
    if (!chosen) throw new Error("no AgentBackend registered"); // build-time misconfig, surfaced clearly
    return chosen;
  };

  return {
    forTask: backendFor,
    all: () => [...new Set(Object.values(opts.backends).filter(Boolean) as AgentBackend[])],
    availableFor: (kind) => {
      const want = keyForTask(kind);
      if (opts.backends[want] && isLoaded(want)) return true;
      // any other loaded backend can serve as fallback
      return (Object.keys(opts.backends) as AgentBackendKey[]).some((k) => opts.backends[k] && isLoaded(k));
    },
  };
}
