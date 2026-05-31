import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePostToolUse } from "../../src/verifier/handler";
import { defaultConfig } from "../../src/config/load";
import type { HookContext } from "../../src/hooks/context";
import type { PostToolUseEnvelope } from "../../src/hooks/envelope";
import type { CorpoConfig, Tenet } from "../../src/config/schema";
import type { ChatOutput, Provider } from "../../src/providers/types";
import type { MemoryInput } from "../../src/backends/memory/types";

interface Captured {
  records: Array<Record<string, unknown>>;
  mistakes: MemoryInput[];
}

function makeCtx(
  providerText: string,
  activeTenets: Tenet[],
  captured: Captured,
): HookContext {
  const provider: Provider = {
    id: "anthropic",
    model: "m",
    modelTier: "fast",
    async chat(): Promise<ChatOutput> {
      return {
        text: providerText,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        providerId: "anthropic",
        model: "m",
        finishReason: "stop",
      };
    },
    async ping() {
      return true;
    },
  };
  const config: CorpoConfig = defaultConfig();
  config.molar_edit = { ...config.molar_edit, active_tenets: activeTenets };
  return {
    config,
    project: "proj",
    logger: { enabled: true, log: (r: Record<string, unknown>) => captured.records.push(r) },
    registry: { forComponent: () => provider, all: () => [provider] },
    memory: {
      id: "native",
      async recall() {
        return [];
      },
      async capture(m: MemoryInput) {
        captured.mistakes.push(m);
      },
      async consolidate() {
        return { captured: 0, superseded: 0 };
      },
      async recordOutcome() {},
      async ping() {
        return true;
      },
    },
    plugins: { plugins: [], templates: [], tenets: [] },
  } as unknown as HookContext;
}

const env = (toolName: string, input: Record<string, unknown>): PostToolUseEnvelope =>
  ({ session_id: "s", transcript_path: "/t", tool_name: toolName, tool_input: input }) as unknown as PostToolUseEnvelope;

describe("verifier handler (Phase 2 teeth)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-ver-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("fans out the active tenets, surfaces violations, captures mistakes, and does not block on warns", async () => {
    const file = join(dir, "sample.ts");
    writeFileSync(file, "export function doEverything() { return 1; }");
    const captured: Captured = { records: [], mistakes: [] };
    const ctx = makeCtx(
      JSON.stringify({ ok: false, severity: "warn", message: "does too much", confidence: 0.8 }),
      ["A", "L"],
      captured,
    );

    const res = await handlePostToolUse(env("Write", { file_path: file }), ctx);

    // Two active tenets → two check lines, run in parallel, plus one summary.
    expect(captured.records.filter((r) => r.event === "verifier_check")).toHaveLength(2);
    const summary = captured.records.find((r) => r.event === "verifier")!;
    expect(summary.enforced).toBe(true);
    expect(summary.violations).toBe(2);
    expect(summary.blocked).toBe(false);
    // Warns are surfaced to the model, not blocked.
    expect(res.continue).toBeUndefined();
    expect(res.additionalContext).toContain("middle-management verifier");
    expect(res.additionalContext).toContain("[A]");
    expect(res.additionalContext).toContain("[L]");
    // Both violations written to memory as file-anchored mistakes.
    expect(captured.mistakes).toHaveLength(2);
    expect(captured.mistakes[0]!.files).toContain(file);
    expect(captured.mistakes[0]!.kind).toBe("mistake");
  });

  it("halts the edit on a single high-confidence block finding", async () => {
    const file = join(dir, "danger.ts");
    writeFileSync(file, "while (true) {}");
    const captured: Captured = { records: [], mistakes: [] };
    const ctx = makeCtx(
      JSON.stringify({ ok: false, severity: "block", message: "unbounded loop", confidence: 0.95 }),
      ["A"],
      captured,
    );

    const res = await handlePostToolUse(env("Write", { file_path: file }), ctx);

    expect(res.continue).toBe(false);
    expect(res.stopReason).toContain("MOLAR-EDIT");
    expect(captured.records.find((r) => r.event === "verifier")!.blocked).toBe(true);
  });

  it("does not block on a block finding below the confidence bar (no false block)", async () => {
    const file = join(dir, "weak.ts");
    writeFileSync(file, "const x = 1;");
    const captured: Captured = { records: [], mistakes: [] };
    const ctx = makeCtx(
      JSON.stringify({ ok: false, severity: "block", message: "maybe", confidence: 0.4 }),
      ["A"],
      captured,
    );

    const res = await handlePostToolUse(env("Write", { file_path: file }), ctx);
    expect(res.continue).toBeUndefined(); // low confidence → advice, not a halt
  });

  it("does nothing for a non-write tool", async () => {
    const captured: Captured = { records: [], mistakes: [] };
    const res = await handlePostToolUse(env("Read", {}), makeCtx("{}", ["A"], captured));
    expect(res).toEqual({});
    expect(captured.records).toHaveLength(0);
  });

  it("skips entirely when no tenets are active", async () => {
    const file = join(dir, "x.ts");
    writeFileSync(file, "const y = 2;");
    const captured: Captured = { records: [], mistakes: [] };
    const res = await handlePostToolUse(env("Write", { file_path: file }), makeCtx("{}", [], captured));
    expect(res).toEqual({});
  });
});
