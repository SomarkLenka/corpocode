import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer, createLineBuffer } from "../../src/monitor/tail";

const dirs: string[] = [];
function tmpFile(name = "f.log"): string {
  const d = mkdtempSync(join(tmpdir(), "cc-tail-"));
  dirs.push(d);
  return join(d, name);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("tailer", () => {
  it("returns nothing for a file that does not exist yet", () => {
    const t = createTailer(join(tmpdir(), "definitely-not-here-xyz.log"));
    expect(t.read()).toBe("");
    expect(t.offset).toBe(0);
  });

  it("reads only newly appended bytes across reads", () => {
    const f = tmpFile();
    writeFileSync(f, "one\n");
    const t = createTailer(f);
    expect(t.read()).toBe("one\n");
    expect(t.read()).toBe(""); // nothing new
    appendFileSync(f, "two\n");
    expect(t.read()).toBe("two\n");
  });

  it("resets to the start when the file is truncated/rotated", () => {
    const f = tmpFile();
    writeFileSync(f, "aaaa\nbbbb\n");
    const t = createTailer(f);
    expect(t.read()).toBe("aaaa\nbbbb\n");
    writeFileSync(f, "x\n"); // shorter than the offset → truncation
    expect(t.read()).toBe("x\n");
    expect(t.offset).toBe(2);
  });
});

describe("line buffer", () => {
  it("yields complete lines and holds back a partial trailing line", () => {
    const buf = createLineBuffer();
    expect(buf.push("a\nb\nc")).toEqual(["a", "b"]); // "c" has no newline yet
    expect(buf.push("c\n")).toEqual(["cc"]); // completes "c" + "c"
  });

  it("drops empty lines between records", () => {
    const buf = createLineBuffer();
    expect(buf.push("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("handles a chunk that completes nothing", () => {
    const buf = createLineBuffer();
    expect(buf.push("partial")).toEqual([]);
    expect(buf.push(" more\n")).toEqual(["partial more"]);
  });
});
