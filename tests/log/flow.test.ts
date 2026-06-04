import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlowLogger, flowLoggerFromConfig, nullFlowLogger } from "../../src/log/flow";
import { flowLogFile } from "../../src/config/paths";

const FIXED = () => new Date("2026-06-03T12:00:00.000Z");

/** A transcript JSONL line in the simple {role, content} shape parseTranscriptSlice accepts. */
function line(role: string, content: string): string {
  return `${JSON.stringify({ role, content })}\n`;
}

describe("flow logger", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let transcript: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-flow-"));
    env = { CORPOCODE_HOME: home }; // redirects all project state (logs + cursor) into the temp dir
    transcript = join(home, "transcript.jsonl");
  });
  afterEach(() => {
    // best-effort; tmpdir is reclaimed by the OS
  });

  function read(): string {
    return readFileSync(flowLogFile(undefined, env), "utf8");
  }

  it("interleaves the transcript delta with the hook output", () => {
    writeFileSync(transcript, line("user", "analyze the filter") + line("assistant", "reading classify.ts"));
    const flow = createFlowLogger({ enabled: true, env, now: FIXED });

    flow.record("PreToolUse", { session_id: "abc12345", transcript_path: transcript, tool_name: "Read", tool_input: { file_path: "src/filter/classify.ts" } }, {
      additionalContext: "<middle-management file-context>\nwhy is this read?\n</middle-management file-context>",
      permissionDecision: "allow",
      permissionDecisionReason: "not a command tool",
    });

    const out = read();
    expect(out).toContain("▶ PreToolUse  ·  Read");
    expect(out).toContain("session abc12345");
    expect(out).toContain("file_path: src/filter/classify.ts"); // input hint
    expect(out).toContain("[user] analyze the filter");
    expect(out).toContain("[assistant] reading classify.ts");
    expect(out).toContain("additionalContext:");
    expect(out).toContain("permissionDecision: allow (not a command tool)");
    expect(out).toContain("2 new messages");
  });

  it("only emits NEW transcript lines on the next hook (delta advances)", () => {
    writeFileSync(transcript, line("user", "first message"));
    const flow = createFlowLogger({ enabled: true, env, now: FIXED });
    flow.record("UserPromptSubmit", { session_id: "s1", transcript_path: transcript }, { additionalContext: "<rec>m</rec>" });

    appendFileSync(transcript, line("assistant", "second message"));
    flow.record("PostToolUse", { session_id: "s1", transcript_path: transcript, tool_name: "Bash" }, {});

    const out = read();
    // Two hooks fired → two "▶ " headers. split() yields [leading-rule, block1, block2].
    const segs = out.split("▶ ");
    expect((out.match(/▶ /g) ?? []).length).toBe(2);

    // The first message belongs only to the first block; the second block carries only new content.
    expect(segs[1]).toContain("[user] first message");
    expect(segs[1]).not.toContain("second message");
    expect(segs[2]).toContain("[assistant] second message");
    expect(segs[2]).not.toContain("first message");
    expect(segs[2]).toContain("(no output — empty response)"); // empty response renders explicitly
  });

  it("renders a hook with no new transcript content", () => {
    writeFileSync(transcript, ""); // SessionStart often fires before any transcript exists
    const flow = createFlowLogger({ enabled: true, env, now: FIXED });
    flow.record("SessionStart", { session_id: "s1", transcript_path: transcript }, {});
    expect(read()).toContain("(no new transcript content)");
  });

  it("is a no-op when disabled", () => {
    writeFileSync(transcript, line("user", "hi"));
    const flow = createFlowLogger({ enabled: false, env, now: FIXED });
    flow.record("PreToolUse", { session_id: "s1", transcript_path: transcript }, {});
    expect(existsSync(flowLogFile(undefined, env))).toBe(false);
  });

  it("never throws when the write sink fails", () => {
    writeFileSync(transcript, line("user", "hi"));
    const flow = createFlowLogger({
      enabled: true,
      env,
      now: FIXED,
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() =>
      flow.record("PreToolUse", { session_id: "s1", transcript_path: transcript }, {}),
    ).not.toThrow();
  });

  it("flowLoggerFromConfig is gated by both logging.enabled and transcript_flow", () => {
    expect(flowLoggerFromConfig({ logging: { enabled: true, transcript_flow: true } }, { env }).enabled).toBe(true);
    expect(flowLoggerFromConfig({ logging: { enabled: true, transcript_flow: false } }, { env }).enabled).toBe(false);
    expect(flowLoggerFromConfig({ logging: { enabled: false, transcript_flow: true } }, { env }).enabled).toBe(false);
  });

  it("nullFlowLogger reports disabled and does nothing", () => {
    const flow = nullFlowLogger();
    expect(flow.enabled).toBe(false);
    expect(() => flow.record("PreToolUse", {}, {})).not.toThrow();
  });
});
