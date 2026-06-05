// agent-engine AgentBackend — adapts the `corpocode-agent-engine` package (the opencode-backed model
// runtime, github.com/SomarkLenka/AgentEngine) to CorpoCode's AgentBackend seam. The package is an
// OPTIONAL, lazily-loaded peer: it is dynamic-imported via a NON-LITERAL specifier so neither tsc nor
// esbuild tries to resolve/bundle it (it carries the heavy opencode SDK + its server, which can't live
// in the self-contained plugin bundle). When it is not installed, the backend resolves fail-open with
// `model_unavailable` — so anthropic-cli stays the zero-dependency default and CorpoCode never breaks.
// Enable it by installing/linking `corpocode-agent-engine` and pointing a task's backend at it in config.
import type { AgentBackend, AgentCall, AgentResult, AgentErrorKind, ModelRef, ToolPolicy } from "../backend";

// Non-literal so the module is not statically resolved (tsc → any; esbuild → runtime import()).
const AGENT_ENGINE_PKG = "corpocode-agent-engine";

// ── Minimal structural mirrors of the package's public types (we adapt to/from these) ────────────────
interface EngineModelRef { providerID: string; modelID: string }
interface EngineResponseSchema<T> { name: string; jsonSchema: Record<string, unknown>; parse(j: unknown): T }
interface EngineAgentCall<T = unknown> {
  component: string;
  task: string;
  inputs?: { transcript?: string; files?: string[]; reasoning?: string; decisions?: string[] };
  model?: EngineModelRef;
  effort?: "minimal" | "medium" | "high";
  schema?: EngineResponseSchema<T>;
  tools?: "none" | "read-only" | "read-write" | { enable: Record<string, boolean>; allowMutation?: boolean };
  session?: "ephemeral" | { reuse?: string; persist?: boolean };
  timeoutMs?: number;
}
interface EngineUsage { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }
interface EngineError { kind: string; message: string; retryable: boolean }
interface EngineAgentResult<T = unknown> {
  ok: boolean;
  data?: T;
  text?: string;
  usage: EngineUsage;
  model: EngineModelRef;
  trace?: Array<{ tool: string; status?: string; title?: string }>;
  session?: { id: string; persisted: boolean };
  error?: EngineError;
}
interface AgentEngineInstance {
  invoke<T>(call: EngineAgentCall<T>): Promise<EngineAgentResult<T>>;
  release(id: string): Promise<void>;
  health(): Promise<{ ok: boolean; serverUp: boolean; detail?: string }>;
  shutdown(): Promise<void>;
}
interface EngineModule {
  createOpencodeEngine(opts: Record<string, unknown>): AgentEngineInstance;
}

// ── Adapters (exported for unit tests; no package install needed to test them) ───────────────────────

export function toEngineTools(tools: ToolPolicy | undefined): EngineAgentCall["tools"] {
  if (tools === undefined || tools === "none" || tools === "read-only") return tools ?? "read-only";
  const enable: Record<string, boolean> = { read: tools.read !== false, glob: tools.glob !== false, grep: tools.grep !== false };
  for (const m of tools.mcp ?? []) enable[m] = true;
  return { enable, allowMutation: Boolean(tools.write) };
}

export function toEngineCall<T>(call: AgentCall<T>): EngineAgentCall<T> {
  const out: EngineAgentCall<T> = { component: call.component, task: call.task };
  if (call.inputs) out.inputs = { transcript: call.inputs.transcript, files: call.inputs.files, reasoning: call.inputs.reasoning, decisions: call.inputs.decisions ? [call.inputs.decisions] : undefined };
  if (call.model) out.model = { providerID: call.model.providerKey, modelID: call.model.model };
  if (call.effort) out.effort = call.effort;
  if (call.schema) out.schema = { name: "result", jsonSchema: call.schema, parse: (j) => j as T };
  out.tools = toEngineTools(call.tools);
  if (call.session) out.session = call.session === "ephemeral" ? "ephemeral" : { reuse: call.session.reuse, persist: call.session.persist };
  if (call.timeoutMs) out.timeoutMs = call.timeoutMs;
  return out;
}

const ERROR_KIND_MAP: Record<string, AgentErrorKind> = {
  schema_invalid: "invalid_response",
  server_unavailable: "model_unavailable",
  aborted: "timeout",
  unknown: "network",
};

export function fromEngineResult<T>(r: EngineAgentResult<T>): AgentResult<T> {
  const model: ModelRef = { providerKey: r.model.providerID, model: r.model.modelID };
  const res: AgentResult<T> = {
    ok: r.ok,
    data: r.data,
    text: r.text,
    usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.usage.costUsd, latencyMs: r.usage.latencyMs, model: r.model.modelID },
    model,
    session: r.session,
  };
  if (r.trace) res.trace = r.trace.map((t) => ({ name: t.tool, input: t.title }));
  if (r.error) res.error = { kind: ERROR_KIND_MAP[r.error.kind] ?? (r.error.kind as AgentErrorKind), message: r.error.message, retryable: r.error.retryable };
  return res;
}

const unavailable = <T>(call: AgentCall<T>, message: string): AgentResult<T> => ({
  ok: false,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: call.model?.model ?? "agent-engine" },
  model: call.model ?? { providerKey: "agent-engine", model: "agent-engine" },
  error: { kind: "model_unavailable", message, retryable: false },
});

export interface AgentEngineBackendOptions {
  /** Engine config passed to createOpencodeEngine (generated from CorpoCode config upstream). */
  engineConfig?: Record<string, unknown>;
  /** Test seam: provide a pre-built engine, or a loader; defaults to lazily importing the package. */
  engine?: AgentEngineInstance;
  load?: () => Promise<EngineModule | null>;
}

async function defaultLoad(): Promise<EngineModule | null> {
  try {
    return (await import(AGENT_ENGINE_PKG)) as unknown as EngineModule;
  } catch {
    return null; // package not installed → backend unavailable (anthropic-cli stays the default)
  }
}

export function createAgentEngineBackend(opts: AgentEngineBackendOptions = {}): AgentBackend {
  let instance: AgentEngineInstance | null | undefined = opts.engine;
  const load = opts.load ?? defaultLoad;

  // Lazily resolve the engine once; absence is cached so we don't re-attempt the import every call.
  const getEngine = async (): Promise<AgentEngineInstance | null> => {
    if (instance !== undefined) return instance;
    const mod = await load();
    instance = mod ? mod.createOpencodeEngine(opts.engineConfig ?? {}) : null;
    return instance;
  };

  return {
    id: "agent-engine",
    invoke: async <T>(call: AgentCall<T>): Promise<AgentResult<T>> => {
      try {
        const engine = await getEngine();
        if (!engine) return unavailable(call, "corpocode-agent-engine is not installed");
        return fromEngineResult<T>(await engine.invoke<T>(toEngineCall(call)));
      } catch (err) {
        return unavailable(call, err instanceof Error ? err.message : String(err));
      }
    },
    release: async (id) => {
      const engine = await getEngine().catch(() => null);
      await engine?.release(id).catch(() => {});
    },
    health: async () => {
      const engine = await getEngine().catch(() => null);
      if (!engine) return { up: false };
      try {
        const h = await engine.health();
        return { up: h.ok && h.serverUp };
      } catch {
        return { up: false };
      }
    },
    ping: async () => {
      const engine = await getEngine().catch(() => null);
      if (!engine) return false;
      return engine.health().then((h) => h.ok && h.serverUp).catch(() => false);
    },
    shutdown: async () => {
      const engine = instance || null;
      await engine?.shutdown().catch(() => {});
    },
  };
}
