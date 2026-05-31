// Config forward/backward tolerance (Phase 4 §1). Because the schema is now something strangers depend
// on, an upgrade must never break a user who has not touched their config: a config predating new
// blocks must fill them with defaults, and a config carrying a now-removed legacy key must not error.
import { describe, it, expect } from "vitest";
import { configSchema } from "../../src/config/schema";

describe("config schema tolerance", () => {
  it("an empty config yields a complete, versioned default", () => {
    const cfg = configSchema.parse({});
    expect(cfg.version).toBe(1);
    expect(cfg.telemetry.enabled).toBe(false); // default-off is the privacy foundation
    expect(cfg.git.trace_branch).toBe("corpocode/trace");
    expect(cfg.delegation.mode).toBe("suggest");
  });

  it("an old config that predates newer blocks loads them as defaults", () => {
    // A Phase-1-era config: only providers + components, none of the Phase 2-4 blocks.
    const old = {
      providers: { default: { kind: "anthropic", model: "claude-haiku-4-5-20251001" } },
      components: { router: "default", retrieval: "default", compactor: "default", filter: "default", verifier: "default" },
    };
    const cfg = configSchema.parse(old);
    expect(cfg.molar_edit.active_tenets.length).toBeGreaterThan(0);
    expect(cfg.git.enabled).toBe(true);
    expect(cfg.delegation.enabled).toBe(true);
  });

  it("tolerates an unknown legacy key by stripping it, never throwing", () => {
    const withLegacy = { version: 1, legacy_removed_setting: { foo: "bar" }, telemetry: { enabled: false } };
    const cfg = configSchema.parse(withLegacy) as Record<string, unknown>;
    expect(cfg.legacy_removed_setting).toBeUndefined(); // stripped, not fatal
    expect((cfg.telemetry as { enabled: boolean }).enabled).toBe(false);
  });
});
