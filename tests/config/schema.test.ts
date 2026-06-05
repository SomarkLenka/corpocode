import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema";

const FULL_COMPONENTS = {
  router: "default",
  retrieval: "default",
  compactor: "default",
  filter: "default",
  verifier: "default",
};

describe("configSchema", () => {
  it("fills a complete, coherent default config from an empty object", () => {
    const cfg = configSchema.parse({});
    expect(cfg.providers.default.kind).toBe("anthropic-cli"); // keyless default — uses the `claude` CLI
    expect(cfg.providers.default.model).toBe("claude-haiku-4-5");
    expect(cfg.providers.cheap_local.kind).toBe("ollama"); // opt-in local alternative, unused by default
    expect(cfg.components.compactor).toBe("default"); // all six components on the default provider now
    expect(cfg.router.heuristic_candidate_limit_files).toBe(10);
    expect(cfg.router.trivial_early_exit).toBe(true);
    expect(cfg.backends.knowledgeGraph).toBe("native"); // Phase 5: native by default
    expect(cfg.backends.contextStore).toBe("native");
    expect(cfg.backends.memoryStore).toBe("native");
    expect(cfg.molar_edit.active_tenets).toHaveLength(9);
    expect(cfg.logging.enabled).toBe(true);
    expect(cfg.telemetry.enabled).toBe(false);
  });

  it("rejects an invalid provider kind with a precise path", () => {
    const result = configSchema.safeParse({
      providers: { default: { kind: "bogus", model: "x" } },
      components: FULL_COMPONENTS,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "providers.default.kind")).toBe(true);
    }
  });

  it("rejects a component that references an unknown provider", () => {
    const result = configSchema.safeParse({
      providers: { default: { kind: "anthropic", model: "m" } },
      components: { ...FULL_COMPONENTS, router: "missing" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "components.router")).toBe(true);
    }
  });

  it("merges a partial block with its defaults", () => {
    const cfg = configSchema.parse({ router: { trivial_early_exit: false } });
    expect(cfg.router.trivial_early_exit).toBe(false);
    expect(cfg.router.heuristic_candidate_limit_files).toBe(10);
  });

  it("defaults the agent seam to off, anthropic-cli, no task overrides", () => {
    const cfg = configSchema.parse({});
    expect(cfg.agents.enabled).toBe(false); // ships dark
    expect(cfg.agents.default_backend).toBe("anthropic-cli");
    expect(cfg.agents.task_backends).toEqual({});
    expect(cfg.agents.max_parallel).toBe(3);
    expect(cfg.agents.session_ttl_ms).toBe(1_800_000);
    expect(cfg.agents.max_sessions).toBe(50);
    expect(cfg.agents.router_router).toBe(true);
  });

  it("accepts a valid per-task backend mapping", () => {
    const cfg = configSchema.parse({ agents: { enabled: true, task_backends: { triage: "agent-engine" } } });
    expect(cfg.agents.task_backends.triage).toBe("agent-engine");
  });

  it("rejects an unknown agent backend key", () => {
    const result = configSchema.safeParse({ agents: { default_backend: "bogus" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "agents.default_backend")).toBe(true);
    }
  });

  it("rejects an unknown agent task kind in task_backends", () => {
    const result = configSchema.safeParse({ agents: { task_backends: { not_a_kind: "anthropic-cli" } } });
    expect(result.success).toBe(false);
  });
});
