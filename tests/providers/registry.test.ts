import { describe, it, expect } from "vitest";
import { buildRegistry } from "../../src/providers/registry";
import { configSchema } from "../../src/config/schema";

const config = configSchema.parse({});

describe("provider registry", () => {
  it("resolves the configured provider per component", () => {
    const reg = buildRegistry(config, { env: {}, secrets: {} });
    expect(reg.forComponent("router").id).toBe("anthropic");
    expect(reg.forComponent("compactor").id).toBe("ollama");
  });

  it("lists the distinct providers in use", () => {
    const reg = buildRegistry(config, { env: {}, secrets: {} });
    expect(reg.all().map((p) => p.id).sort()).toEqual(["anthropic", "ollama"]);
  });

  it("caches one instance per provider key", () => {
    const reg = buildRegistry(config, { env: {}, secrets: {} });
    // router and filter both resolve to "default".
    expect(reg.forComponent("router")).toBe(reg.forComponent("filter"));
  });
});

/** Build a config where every component points at one provider, so availableFor("filter") tests it. */
function single(provider: Record<string, unknown>) {
  const components = Object.fromEntries(
    ["router", "retrieval", "compactor", "filter", "verifier", "toolbox"].map((c) => [c, "p"]),
  );
  return configSchema.parse({ providers: { p: provider }, components });
}

describe("registry.availableFor — is a usable cheap model loaded", () => {
  it("key-requiring vendor: loaded only when a key resolves", () => {
    const cfg = single({ kind: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(buildRegistry(cfg, { env: {}, secrets: {} }).availableFor("filter")).toBe(false);
    expect(buildRegistry(cfg, { env: { ANTHROPIC_API_KEY: "sk-x" }, secrets: {} }).availableFor("filter")).toBe(true);
  });

  it("ollama: loaded only when an endpoint (host/baseUrl) is populated", () => {
    expect(buildRegistry(single({ kind: "ollama", model: "m" }), { env: {}, secrets: {} }).availableFor("filter")).toBe(false);
    expect(
      buildRegistry(single({ kind: "ollama", model: "m", host: "http://localhost:11434" }), { env: {}, secrets: {} }).availableFor("filter"),
    ).toBe(true);
  });

  it("anthropic-cli: loaded when a model is populated (keyless)", () => {
    expect(buildRegistry(single({ kind: "anthropic-cli", model: "claude-x" }), { env: {}, secrets: {} }).availableFor("filter")).toBe(true);
  });
});
