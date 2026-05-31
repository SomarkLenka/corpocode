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
}

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

  return {
    forComponent: (name) => providerForKey(config.components[name]),
    all: () => [...new Set(Object.values(config.components))].map(providerForKey),
  };
}
