import { describe, it, expect } from "vitest";
import { provisionGraphify } from "../../src/install/backends/graphify";
import { generateOvConf, provisionOpenViking } from "../../src/install/backends/openviking";
import { defaultConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import type { CommandResult } from "../../src/install/run";
import type { ContextStore } from "../../src/backends/context/types";

const ok = async (): Promise<CommandResult> => ({ code: 0, stdout: "", stderr: "" });

describe("provisionGraphify", () => {
  it("builds the graph when it is absent", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await provisionGraphify({ repoRoot: "/r", run, exists: () => false });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c[0] === "graphify" && c[1] === ".")).toBe(true);
  });

  it("skips building when the graph is present", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await provisionGraphify({ repoRoot: "/r", run, exists: () => true });
    expect(calls.some((c) => c[0] === "graphify" && c[1] === ".")).toBe(false);
    expect(res.steps.find((s) => s.name === "build graph")?.skipped).toBe(true);
  });

  it("dry-run plans without running anything", async () => {
    let ran = false;
    const run = async (): Promise<CommandResult> => {
      ran = true;
      return ok();
    };
    const res = await provisionGraphify({ repoRoot: "/r", run, exists: () => false, dryRun: true });
    expect(ran).toBe(false);
    expect(res.steps.every((s) => s.skipped)).toBe(true);
  });
});

describe("generateOvConf", () => {
  it("maps the default anthropic-cli provider to the anthropic API + a keyless local embedder", () => {
    const conf = generateOvConf(defaultConfig(), { apiKey: "sk-test" });
    expect(conf).toContain('provider = "anthropic"'); // anthropic-cli → anthropic API for the OpenViking daemon
    expect(conf).toContain('model = "claude-haiku-4-5"');
    expect(conf).toContain('api_key = "sk-test"');
    expect(conf).toContain("nomic-embed-text");
  });

  it("maps an openai provider to openai embeddings", () => {
    const cfg = configSchema.parse({
      providers: { default: { kind: "openai", model: "gpt-5-nano" } },
      components: { router: "default", retrieval: "default", compactor: "default", filter: "default", verifier: "default" },
    });
    expect(generateOvConf(cfg)).toContain("text-embedding-3-small");
  });
});

describe("provisionOpenViking", () => {
  it("writes ov.conf, starts the daemon, and health-checks it", async () => {
    let confWritten = "";
    const store: ContextStore = {
      id: "openviking",
      find: async () => ({ query: "", tier: "L0", resources: [] }),
      load: async () => "",
      write: async () => {},
      tree: async () => [],
      grep: async () => [],
      start: async () => {},
      health: async () => ({ up: true, version: "1.0" }),
      ping: async () => true,
    };
    const res = await provisionOpenViking({
      config: defaultConfig(),
      store,
      run: ok,
      writeConf: (_p, c) => {
        confWritten = c;
      },
      confPath: "/tmp/ov.conf",
    });
    expect(res.ok).toBe(true);
    expect(confWritten).toContain("[embedding]");
    expect(res.steps.find((s) => s.name === "health check")?.ok).toBe(true);
  });
});
