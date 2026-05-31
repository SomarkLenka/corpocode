import { describe, it, expect } from "vitest";
import { applyEnvOverrides } from "../../src/config/env-overrides";
import { configSchema } from "../../src/config/schema";

const base = () => configSchema.parse({});

describe("applyEnvOverrides", () => {
  it("overrides a leaf whose key contains underscores", () => {
    const { config, applied } = applyEnvOverrides(base(), {
      CORPOCODE_ROUTER_TRIVIAL_EARLY_EXIT: "false",
    });
    expect(config.router.trivial_early_exit).toBe(false);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.path).toEqual(["router", "trivial_early_exit"]);
  });

  it("overrides a nested provider model", () => {
    const { config } = applyEnvOverrides(base(), { CORPOCODE_PROVIDERS_DEFAULT_MODEL: "claude-x" });
    expect(config.providers.default.model).toBe("claude-x");
  });

  it("overrides a provider key that itself contains an underscore", () => {
    const { config } = applyEnvOverrides(base(), { CORPOCODE_PROVIDERS_CHEAP_LOCAL_MODEL: "llama3" });
    expect(config.providers.cheap_local.model).toBe("llama3");
  });

  it("coerces a numeric override", () => {
    const { config } = applyEnvOverrides(base(), {
      CORPOCODE_ROUTER_HEURISTIC_CANDIDATE_LIMIT_FILES: "25",
    });
    expect(config.router.heuristic_candidate_limit_files).toBe(25);
  });

  it("ignores CORPOCODE_HOME and non-matching variables", () => {
    const { applied } = applyEnvOverrides(base(), {
      CORPOCODE_HOME: "/tmp/x",
      CORPOCODE_NOT_A_FIELD: "y",
      PATH: "z",
    });
    expect(applied).toHaveLength(0);
  });

  it("does not mutate the input object", () => {
    const b = base();
    applyEnvOverrides(b, { CORPOCODE_ROUTER_TRIVIAL_EARLY_EXIT: "false" });
    expect(b.router.trivial_early_exit).toBe(true);
  });
});
