import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorDeps } from "../../src/commands/doctor";
import { defaultConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";

const allOk: DoctorDeps = {
  loadConfig: () => defaultConfig(),
  secretsState: () => "ok",
  pingProvider: async () => true,
  channels: () => ({ npm: true, plugin: false }),
  graphifyVersion: async () => true,
  graphPresent: () => true,
  openvikingUp: async () => true,
  pythonVersion: async () => "Python 3.11.0",
  memoryWritable: () => true,
  plugins: () => [],
  nativeGraphBuilt: () => true,
};

// A config that deliberately selects the Python-backed adapters, to exercise the conditional checks.
const pythonConfig = () => configSchema.parse({ backends: { knowledgeGraph: "graphify", contextStore: "openviking" } });

describe("runDoctor", () => {
  it("reports every check ok in a healthy native environment (no Python/daemon checks)", async () => {
    const checks = await runDoctor(allOk);
    // config, telemetry, secrets, provider, wiring, knowledge graph (native), context store (native), memory, plugins
    expect(checks).toHaveLength(9);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.some((c) => c.name === "python toolchain")).toBe(false); // not run under native config
    expect(checks.some((c) => c.name === "knowledge graph")).toBe(true);
  });

  it("runs the Python/daemon checks only when a Python-backed backend is selected", async () => {
    const checks = await runDoctor({ ...allOk, loadConfig: pythonConfig });
    expect(checks.some((c) => c.name === "graphify")).toBe(true);
    expect(checks.some((c) => c.name === "openviking")).toBe(true);
    expect(checks.some((c) => c.name === "python toolchain")).toBe(true);
  });

  it("flags a missing backend as fail with a repair hint (under a graphify config)", async () => {
    const checks = await runDoctor({ ...allOk, loadConfig: pythonConfig, graphifyVersion: async () => false });
    const graphify = checks.find((c) => c.name === "graphify")!;
    expect(graphify.status).toBe("fail");
    expect(graphify.repair).toBe("corpocode provision");
  });

  it("warns when both install channels are active", async () => {
    const checks = await runDoctor({ ...allOk, channels: () => ({ npm: true, plugin: true }) });
    const wiring = checks.find((c) => c.name === "hook wiring")!;
    expect(wiring.status).toBe("warn");
    expect(wiring.detail).toContain("twice");
  });

  it("fails the config check when loadConfig throws and skips the provider probe", async () => {
    const checks = await runDoctor({
      ...allOk,
      loadConfig: () => {
        throw new Error("bad config");
      },
    });
    expect(checks.find((c) => c.name === "config schema")!.status).toBe("fail");
    expect(checks.find((c) => c.name === "provider reachable")!.status).toBe("warn");
  });

  it("fails hook wiring when not installed in either channel", async () => {
    const checks = await runDoctor({ ...allOk, channels: () => ({ npm: false, plugin: false }) });
    expect(checks.find((c) => c.name === "hook wiring")!.status).toBe("fail");
  });
});
