import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigDetailed, ConfigError } from "../../src/config/load";

const FULL_COMPONENTS = {
  router: "default",
  retrieval: "default",
  compactor: "default",
  filter: "default",
  verifier: "default",
};

describe("loadConfig", () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-cfg-"));
    cfgPath = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns coherent defaults when the file is missing", () => {
    const r = loadConfigDetailed({ path: join(dir, "absent.json"), env: {} });
    expect(r.source).toBe("defaults");
    expect(r.config.providers.default.kind).toBe("anthropic");
  });

  it("round-trips a valid file", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        providers: { default: { kind: "openai", model: "gpt-5-nano" } },
        components: FULL_COMPONENTS,
      }),
    );
    const r = loadConfigDetailed({ path: cfgPath, env: {} });
    expect(r.source).toBe("file");
    expect(r.config.providers.default.kind).toBe("openai");
    expect(r.config.providers.default.model).toBe("gpt-5-nano");
  });

  it("throws a clear ConfigError on invalid file content", () => {
    writeFileSync(cfgPath, JSON.stringify({ providers: { default: { kind: "bogus", model: "x" } } }));
    expect(() => loadConfig({ path: cfgPath, env: {} })).toThrow(ConfigError);
  });

  it("throws a ConfigError on malformed JSON", () => {
    writeFileSync(cfgPath, "{ not valid json");
    expect(() => loadConfig({ path: cfgPath, env: {} })).toThrow(ConfigError);
  });

  it("lets an env override win over a file value", () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        providers: { default: { kind: "anthropic", model: "from-file" } },
        components: FULL_COMPONENTS,
      }),
    );
    const r = loadConfigDetailed({
      path: cfgPath,
      env: { CORPOCODE_PROVIDERS_DEFAULT_MODEL: "from-env" },
    });
    expect(r.config.providers.default.model).toBe("from-env");
    expect(r.appliedOverrides).toHaveLength(1);
  });
});
