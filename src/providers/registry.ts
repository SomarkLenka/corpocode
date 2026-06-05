// Resolves the provider a component should use: config.components[name] → config.providers[key] →
// a constructed Provider, with the API key resolved from secrets/env. Consumers never construct
// adapters directly — they ask the registry, so swapping a provider is a config change.
import type { Provider } from "./types";
import type { ComponentName, CorpoConfig, ProviderConfig } from "../config/schema";
import { loadSecrets, resolveApiKey } from "../config/secrets";
import type { AdapterOptions } from "./base";
import { createAnthropicProvider } from "./anthropic";
import { createAnthropicCliProvider } from "./anthropic-cli";
import { createGoogleProvider } from "./google";
import { createOpenAiProvider } from "./openai";
import { createOpenRouterProvider } from "./openrouter";
import { createOllamaProvider } from "./ollama";

export type { ComponentName };

export interface ProviderRegistry {
  /** Resolve the configured provider for a component. */
  forComponent(name: ComponentName): Provider;
  /** Every distinct provider in use, for doctor's reachability sweep. */
  all(): Provider[];
  /**
   * Whether a usable cheap model is actually configured for a component — checked synchronously from
   * config + secrets, without a network call. Lets callers degrade gracefully (e.g. the filter
   * disabling its deny path) when no LLM is loaded, rather than relying on a call that will fail.
   *  - key-requiring vendors (anthropic, google, openai, openrouter): a key must resolve;
   *  - ollama: an endpoint (`host` or `baseUrl`) must be populated — the default kind alone is not enough;
   *  - anthropic-cli: a model must be populated (its only config knob; it uses the `claude` CLI session).
   */
  availableFor(name: ComponentName): boolean;
}

const nonEmpty = (v?: string): boolean => typeof v === "string" && v.trim().length > 0;

/** Construct a single provider from its config slice + resolved key. */
export function buildProvider(cfg: ProviderConfig, apiKey: string | undefined): Provider {
  const base: AdapterOptions = { model: cfg.model, apiKey, host: cfg.host, baseUrl: cfg.baseUrl };
  switch (cfg.kind) {
    case "anthropic":
      return createAnthropicProvider(base);
    case "anthropic-cli":
      return createAnthropicCliProvider(base);
    case "google":
      return createGoogleProvider(base);
    case "openai":
      return createOpenAiProvider(base);
    case "openrouter":
      return createOpenRouterProvider(base);
    case "ollama":
      return createOllamaProvider(base);
    default: {
      const unreachable: never = cfg.kind;
      throw new Error(`unsupported provider kind: ${String(unreachable)}`);
    }
  }
}

export function buildRegistry(
  config: CorpoConfig,
  opts: { env?: NodeJS.ProcessEnv; secrets?: Record<string, string> } = {},
): ProviderRegistry {
  const env = opts.env ?? process.env;
  const secrets = opts.secrets ?? loadSecrets(env);
  const cache = new Map<string, Provider>();

  const providerForKey = (key: string): Provider => {
    const cached = cache.get(key);
    if (cached) return cached;
    const cfg = config.providers[key];
    if (!cfg) {
      // Should never happen post-validation (the schema cross-checks references), but fail clearly.
      throw new Error(`config references unknown provider "${key}"`);
    }
    const apiKey = resolveApiKey({ kind: cfg.kind, apiKeyRef: cfg.apiKeyRef }, secrets, env);
    const provider = buildProvider(cfg, apiKey);
    cache.set(key, provider);
    return provider;
  };

  const isProviderLoaded = (cfg: ProviderConfig): boolean => {
    switch (cfg.kind) {
      case "ollama":
        // Local daemon: loaded only when an endpoint is configured, not just because the kind is set.
        return nonEmpty(cfg.host) || nonEmpty(cfg.baseUrl);
      case "anthropic-cli":
        // Uses the user's `claude` CLI session (no key/endpoint); loaded when a model is configured.
        return nonEmpty(cfg.model);
      default:
        // Key-requiring vendors: loaded only when a key resolves from secrets/env.
        return Boolean(resolveApiKey({ kind: cfg.kind, apiKeyRef: cfg.apiKeyRef }, secrets, env));
    }
  };

  return {
    forComponent: (name) => providerForKey(config.components[name]),
    all: () => [...new Set(Object.values(config.components))].map(providerForKey),
    availableFor: (name) => {
      const cfg = config.providers[config.components[name]];
      return cfg ? isProviderLoaded(cfg) : false;
    },
  };
}
