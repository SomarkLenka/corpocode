import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, nullLogger } from "../../src/log/ndjson";

describe("ndjson logger", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-log-"));
    file = join(dir, "logs", "corpocode.ndjson");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes one well-formed JSON line per call with a stamped ts", () => {
    const logger = createLogger({
      file,
      enabled: true,
      now: () => new Date("2026-05-30T12:00:00.000Z"),
    });
    logger.log({ event: "router", session_id: "s1", component: "router", cost_usd: 0.0001, stage2_invoked: true });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.ts).toBe("2026-05-30T12:00:00.000Z");
    expect(record.event).toBe("router");
    expect(record.session_id).toBe("s1");
    expect(record.cost_usd).toBe(0.0001);
    expect(record.stage2_invoked).toBe(true);
  });

  it("appends successive lines", () => {
    const logger = createLogger({ file, enabled: true });
    logger.log({ event: "a" });
    logger.log({ event: "b" });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("a");
    expect(JSON.parse(lines[1]!).event).toBe("b");
  });

  it("is a no-op when disabled", () => {
    const logger = createLogger({ file, enabled: false });
    logger.log({ event: "router" });
    expect(existsSync(file)).toBe(false);
  });

  it("tees every line into the per-session file as well as the global one", () => {
    const sessionFile = join(dir, "sessions", "s1", "corpocode.ndjson");
    const logger = createLogger({ file, sessionFile, enabled: true });
    logger.log({ event: "router", session_id: "s1" });
    logger.log({ event: "toolbox", session_id: "s1" });

    // Global log has both lines …
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    // … and the per-session log is a faithful, identical copy.
    const sessionLines = readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(sessionLines).toHaveLength(2);
    expect(JSON.parse(sessionLines[0]!).event).toBe("router");
    expect(JSON.parse(sessionLines[1]!).event).toBe("toolbox");
  });

  it("a per-session tee failure never costs the global write (fail-open tee)", () => {
    // A session file path whose parent is the global FILE (not a dir) can't be created → tee fails.
    const logger = createLogger({ file, sessionFile: join(file, "nope", "x.ndjson"), enabled: true });
    expect(() => logger.log({ event: "router", session_id: "s1" })).not.toThrow();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1); // global still written
  });

  it("never throws even when the sink fails", () => {
    const logger = createLogger({
      file,
      enabled: true,
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => logger.log({ event: "router" })).not.toThrow();
  });

  it("nullLogger reports disabled and does nothing", () => {
    const logger = nullLogger();
    expect(logger.enabled).toBe(false);
    expect(() => logger.log({ event: "x" })).not.toThrow();
  });
});
