import { describe, it, expect } from "vitest";
import { computeWhy } from "../../src/commands/why";

const line = (o: object): string => JSON.stringify(o);
const NOW = Date.parse("2026-07-02T12:00:00Z");

// A stage-2 router record with the real NESTED shape the handler emits (decision.*, stage1_candidates.files).
const routerStage2 = (session: string, ts: string) =>
  line({
    ts,
    event: "router",
    session_id: session,
    stage2_invoked: true,
    decision: { type: "code-edit", complexity: "hard", effort: "high", breakpoint: true, dispatch_retrieval: true },
    stage1_candidates: { files: ["a.ts"] },
  });

describe("computeWhy · session selection", () => {
  it("defaults to the most recent session (greatest ts with a session_id)", () => {
    const lines = [
      line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "OLD", stage2_invoked: false }),
      routerStage2("NEW", "2026-07-02T11:00:00Z"),
    ];
    const r = computeWhy(lines, { now: NOW });
    expect(r.sessionId).toBe("NEW");
    expect(r.sessionsSeen).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.event).toBe("router");
  });

  it("targets a session by exact id and by 8-char prefix", () => {
    const lines = [
      line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "abcd1234efgh", stage2_invoked: false }),
      line({ ts: "2026-07-02T11:00:00Z", event: "router", session_id: "zzzz9999zzzz", stage2_invoked: false }),
    ];
    expect(computeWhy(lines, { session: "abcd1234efgh", now: NOW }).sessionId).toBe("abcd1234efgh");
    expect(computeWhy(lines, { session: "abcd1234", now: NOW }).sessionId).toBe("abcd1234efgh"); // prefix
  });

  it("returns a null session and no lines for an empty log", () => {
    const r = computeWhy([], { now: NOW });
    expect(r.sessionId).toBeNull();
    expect(r.lines).toEqual([]);
  });

  it("tolerates malformed and blank lines", () => {
    const lines = ["not json", "", line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "s", stage2_invoked: false })];
    const r = computeWhy(lines, { now: NOW });
    expect(r.sessionId).toBe("s");
    expect(r.lines).toHaveLength(1);
  });

  it("filters out sessions outside the --days window", () => {
    const lines = [
      line({ ts: "2026-06-01T00:00:00Z", event: "router", session_id: "OLD", stage2_invoked: false }),
      line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "NEW", stage2_invoked: false }),
    ];
    const r = computeWhy(lines, { days: 7, now: NOW });
    expect(r.sessionId).toBe("NEW");
    expect(r.sessionsSeen).toBe(1);
  });
});

describe("computeWhy · translation", () => {
  const one = (rec: object) => computeWhy([line({ ts: "2026-07-02T10:00:00Z", session_id: "s", ...rec })], { now: NOW }).lines[0]!;

  it("translates a nested stage-2 router decision", () => {
    const l = one({ event: "router", stage2_invoked: true, decision: { type: "code-edit", complexity: "hard", effort: "high", breakpoint: true, dispatch_retrieval: true }, stage1_candidates: { files: ["a.ts"] } });
    expect(l.text).toContain("Classified as code-edit / hard at high effort");
    expect(l.text).toContain("dispatched retrieval");
    expect(l.text).toContain("design breakpoint");
  });

  it("translates the trivial router early-exit", () => {
    expect(one({ event: "router", stage2_invoked: false }).text).toContain("Trivial prompt");
  });

  it("translates a filter deny, marking a non-enforced decision advisory", () => {
    const l = one({ event: "filter", decision: "deny", tool: "Bash", matched: "destructive-recursive-delete", reason: "recursive delete at root", enforced: false });
    expect(l.component).toBe("filter");
    expect(l.text).toContain("Denied `Bash`");
    expect(l.text).toContain("destructive-recursive-delete");
    expect(l.text).toContain("[advisory]");
  });

  it("translates the A1 bug-hunt pattern event (ran) and labels the component 'bug-hunt'", () => {
    const l = one({ event: "pattern", pattern: "bug-hunt", surface: "UserPromptSubmit", decision: "ran", reason: "ran", files_fanned: 3, survivors: 2, injected_tokens: 412 });
    expect(l.component).toBe("bug-hunt");
    expect(l.text).toContain("fanned out 3");
    expect(l.text).toContain("2 files implicated");
    expect(l.text).toContain("412 tokens");
  });

  it("translates a skipped bug-hunt with its gate reason", () => {
    expect(one({ event: "pattern", pattern: "bug-hunt", decision: "skipped", reason: "gate:not-bug-like" }).text).toContain("Skipped (gate:not-bug-like)");
  });

  it("translates the A2 pre-write pattern event (ran) and labels the component 'pre-write'", () => {
    const l = one({ event: "pattern", pattern: "pre-write", surface: "PreToolUse", decision: "ran", reason: "ran", warnings: 2, injected_tokens: 180 });
    expect(l.component).toBe("pre-write");
    expect(l.text).toContain("pre-write guidance");
    expect(l.text).toContain("2 warning(s)");
    expect(l.text).toContain("180 tokens");
  });

  it("translates a skipped pre-write with its gate reason (the pattern-generic skipped path)", () => {
    expect(one({ event: "pattern", pattern: "pre-write", decision: "skipped", reason: "gate:no-blast-radius" }).text).toContain("Skipped (gate:no-blast-radius)");
  });

  it("notes the off-'ran' path on a pre-write event, mirroring bug-hunt", () => {
    expect(one({ event: "pattern", pattern: "pre-write", decision: "ran", reason: "deadline", warnings: 0, injected_tokens: 0 }).text).toContain("hit the deadline path");
  });

  it("renders inject whole-file, toolbox session-start, and git commit vs promote variants", () => {
    expect(one({ event: "inject", file: "x.ts", sliced: false, purpose_known: false, warnings: 0 }).text).toContain("Read x.ts whole (purpose unknown)");
    expect(one({ event: "inject", file: "x.ts", sliced: false, purpose_known: false, warnings: 0 }).component).toBe("injector");
    expect(one({ event: "toolbox", trigger: "sessionstart", gated: 5, skipped: 2 }).text).toContain("5 gated, 2 skipped");
    expect(one({ event: "git", op: "commit", branch: "trace", files: ["a.ts"] }).text).toContain("Trace-committed a.ts");
    expect(one({ event: "git", op: "promote", branch: "clean", planned: 3, applied: 2, mode: "auto" }).text).toContain("Promoted 2 of 3");
  });

  it("counts untranslated in-session events in otherEvents without emitting a line", () => {
    const lines = [
      line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "s", stage2_invoked: false }),
      line({ ts: "2026-07-02T10:00:01Z", event: "some_unknown_event", session_id: "s" }),
    ];
    const r = computeWhy(lines, { now: NOW });
    expect(r.lines).toHaveLength(1);
    expect(r.otherEvents).toBe(1);
  });
});

describe("computeWhy · sessionless attribution", () => {
  it("attributes translatable sessionless events within the session window (flagged), ignores untranslatable ones", () => {
    const lines = [
      line({ ts: "2026-07-02T10:00:00Z", event: "router", session_id: "s", stage2_invoked: false }),
      line({ ts: "2026-07-02T10:00:01Z", event: "orchestrate", calls: 1, succeeded: 1, surviving: 1 }), // sessionless, in window, translatable
      line({ ts: "2026-07-02T10:00:01Z", event: "mystery_engine_event" }), // sessionless, in window, NOT translatable → ignored
      line({ ts: "2026-07-02T10:00:02Z", event: "pattern", pattern: "bug-hunt", session_id: "s", decision: "ran", reason: "ran", files_fanned: 1, survivors: 1, injected_tokens: 10 }),
    ];
    const r = computeWhy(lines, { now: NOW });
    const orch = r.lines.find((l) => l.event === "orchestrate");
    expect(orch).toBeDefined();
    expect(orch!.sessionless).toBe(true);
    expect(r.note).toBeDefined(); // caveat set because a sessionless event was attributed by time
    expect(r.otherEvents).toBe(0); // the untranslated sessionless stray is NOT counted as this session's
    expect(r.lines.map((l) => l.event)).toEqual(["router", "orchestrate", "pattern"]); // time-ordered
  });
});
