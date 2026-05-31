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
