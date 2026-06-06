// The shared dependency graph a hook handler needs, constructed once per dispatch. Building it is
// cheap: providers, the graph adapter, and the memory store are all lazy (no network/process spawn
// until first use), so constructing a context never blocks or fails a hook.
import { cwd } from "node:process";
import { projectKey } from "../config/paths";
import type { CorpoConfig } from "../config/schema";
import { loggerFromConfig, type Logger } from "../log/ndjson";
import { buildRegistry, type ProviderRegistry } from "../providers/registry";
import { buildKnowledgeGraph } from "../backends/graph/registry";
import type { KnowledgeGraph } from "../backends/graph/types";
import { withScoreFilesCache } from "../perf/graph-cache";
import { buildContextStore } from "../backends/context/registry";
import type { ContextStore } from "../backends/context/types";
import { buildMemoryStore } from "../backends/memory/registry";
import type { MemoryStore } from "../backends/memory/types";
import { createSessionReader } from "../session/reader";
import type { SessionReader } from "../session/types";
import { createPromptResolver, type PromptResolver } from "../prompts/resolve";
import type { PlatformId } from "./platform-output";
import { loadPluginContributions, EMPTY_CONTRIBUTIONS, type PluginContributions } from "../plugins/registry";
import { buildAgentRegistry, type AgentRegistry } from "../agents/registry";
import { createAnthropicCliAgent } from "../agents/backends/anthropic-cli";
import { createAgentEngineBackend } from "../agents/backends/agent-engine";

export interface HookContext {
  config: CorpoConfig;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  project: string;
  platform: PlatformId; // which host platform this hook runs under (gates platform-aware behavior)
  logger: Logger;
  registry: ProviderRegistry;
  graph: KnowledgeGraph;
  context: ContextStore;
  memory: MemoryStore;
  sessionReader: SessionReader;
  prompts: PromptResolver; // resolves editable per-component system prompts (local→global→built-in)
  plugins: PluginContributions; // discovered corpocode-template-*/corpocode-tenet-* contributions
  agents?: AgentRegistry; // the IntelligentRouter's agent seam — present only when agents.enabled (ships dark)
}

export interface BuildContextOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  logger?: Logger;
  platform?: PlatformId;
  plugins?: PluginContributions;
}

/** Discover plugin contributions, fail-open: a discovery error yields no plugins, never a broken hook. */
function discoverContributions(): PluginContributions {
  try {
    return loadPluginContributions();
  } catch {
    return EMPTY_CONTRIBUTIONS;
  }
}

export function buildContext(config: CorpoConfig, opts: BuildContextOptions = {}): HookContext {
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? cwd();
  const project = projectKey(repoRoot);
  const platform = opts.platform ?? "claude-code";
  const logger = opts.logger ?? loggerFromConfig(config, { cwd: repoRoot, env }); // logs into <repoRoot>/.corpocode
  const registry = buildRegistry(config, { env });
  // Memoize stage-1 file-scoring across hooks (keyed on the graph's version) — the latency that sits
  // directly in front of the model's first token is the one most worth caching.
  const graph = withScoreFilesCache(buildKnowledgeGraph(config, { repoRoot }), { repoRoot, env });
  const context = buildContextStore(config);
  // Memory and the session cache are project-local too (under <repoRoot>/.corpocode), so repoRoot flows in.
  const memory = buildMemoryStore(config, { project, env, repoRoot });
  const prompts = createPromptResolver({ cwd: repoRoot, env });
  const sessionReader = createSessionReader({ provider: registry.forComponent("router"), env, cwd: repoRoot, prompts });
  const plugins = opts.plugins ?? discoverContributions();
  // The agent seam is built only when enabled, so the orchestration layer ships dark: with agents.enabled
  // false (the default) ctx.agents is undefined and every caller falls back to today's behavior. Both
  // backends are registered as cheap factory objects — anthropic-cli runs the `claude` loop, agent-engine
  // lazily loads its (optional) package on first invoke; per-task selection comes from config.
  const agents = config.agents.enabled
    ? buildAgentRegistry({
        backends: {
          "anthropic-cli": createAnthropicCliAgent({ repoRoot }),
          "agent-engine": createAgentEngineBackend(),
        },
        taskBackends: config.agents.task_backends,
        defaultBackend: config.agents.default_backend,
      })
    : undefined;
  return { config, env, repoRoot, project, platform, logger, registry, graph, context, memory, sessionReader, prompts, plugins, agents };
}
