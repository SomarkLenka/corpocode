// Telemetry (Phase 4 §2) — the privacy guarantees are the test surface. Off means zero egress; the
// payload is a whitelist that cannot carry identifying data even when the log is full of it; a send
// failure is swallowed; and doctor surfaces a banner whenever telemetry is on.
import { describe, it, expect } from "vitest";
import { buildTelemetryPayload, TELEMETRY_FIELDS } from "../../src/telemetry/whitelist";
import { sendTelemetry, type FetchFn } from "../../src/telemetry/transport";
import { runDoctor } from "../../src/commands/doctor";
import { configSchema } from "../../src/config/schema";

const base = configSchema.parse({});
const enabled = configSchema.parse({ telemetry: { enabled: true, endpoint: "https://example.test/t" } });

// A log line that is FULL of identifying data — file paths, a prompt-derived decision — so the test can
// prove none of it survives into the payload.
const sensitiveLog = [
  JSON.stringify({
    event: "router",
    component: "router",
    model: "claude-haiku-4-5-20251001",
    cost_usd: 0.001,
    latency_ms: 120,
    decision: { effort: "medium", context_files_to_preload: ["/home/alice/secret-project/auth.ts"] },
    prompt: "fix the login bug in /home/alice/secret-project",
  }),
  JSON.stringify({ event: "verifier", component: "verifier", latency_ms: 300, file: "/home/alice/secret-project/auth.ts" }),
  JSON.stringify({ event: "hook_error", component: "dispatch" }),
];

describe("telemetry payload (whitelist)", () => {
  it("contains only the whitelisted top-level fields", () => {
    const payload = buildTelemetryPayload(sensitiveLog, base);
    expect(Object.keys(payload).sort()).toEqual([...TELEMETRY_FIELDS].sort());
  });

  it("carries aggregate counts but never the identifying strings the log contained", () => {
    const payload = buildTelemetryPayload(sensitiveLog, base);
    expect(payload.events).toBe(3);
    expect(payload.effortChoices.medium).toBe(1);
    expect(payload.modelChoices["claude-haiku-4-5-20251001"]).toBe(1);
    expect(payload.errorRate).toBeCloseTo(1 / 3);
    expect(payload.latencyMs.p50).toBeGreaterThan(0);
    // The bright line: no file path, prompt, or repo identity anywhere in the serialized payload.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("auth.ts");
    expect(serialized).not.toContain("login bug");
  });
});

describe("telemetry transport", () => {
  it("makes zero network calls when telemetry is disabled (off means off)", async () => {
    let calls = 0;
    const spy: FetchFn = async () => {
      calls++;
      return {};
    };
    const res = await sendTelemetry(buildTelemetryPayload([], base), { config: base, fetchFn: spy });
    expect(res).toEqual({ sent: false, reason: "disabled" });
    expect(calls).toBe(0);
  });

  it("transmits exactly the payload when enabled with an endpoint", async () => {
    let body: string | undefined;
    const spy: FetchFn = async (_url, init) => {
      body = init.body;
      return {};
    };
    const payload = buildTelemetryPayload(sensitiveLog, enabled);
    const res = await sendTelemetry(payload, { config: enabled, fetchFn: spy });
    expect(res.sent).toBe(true);
    expect(JSON.parse(body!)).toEqual(payload);
  });

  it("swallows a transport failure — a send error never throws", async () => {
    const boom: FetchFn = async () => {
      throw new Error("network down");
    };
    const res = await sendTelemetry(buildTelemetryPayload([], enabled), { config: enabled, fetchFn: boom });
    expect(res).toEqual({ sent: false, reason: "transport-error" });
  });
});

describe("doctor telemetry banner", () => {
  const stubs = {
    secretsState: () => "ok" as const,
    pingProvider: async () => true,
    channels: () => ({ npm: true, plugin: false }),
    graphifyVersion: async () => true,
    graphPresent: () => true,
    openvikingUp: async () => true,
    pythonVersion: async () => "Python 3.11",
    memoryWritable: () => true,
  };

  it("shows an attention banner when telemetry is on", async () => {
    const checks = await runDoctor({ loadConfig: () => enabled, ...stubs });
    const banner = checks.find((c) => c.name === "telemetry");
    expect(banner?.status).toBe("warn");
    expect(banner?.detail).toContain("ON");
  });

  it("states telemetry is off by default", async () => {
    const checks = await runDoctor({ loadConfig: () => base, ...stubs });
    const banner = checks.find((c) => c.name === "telemetry");
    expect(banner?.status).toBe("ok");
    expect(banner?.detail).toContain("off");
  });
});
