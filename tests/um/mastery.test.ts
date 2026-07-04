// Phase-1 mastery model — constantPoll treatment plus best-effort day-one observation journaling.
// Covers the treatment matrix, persistence via injected seams AND a real CORPOCODE_HOME temp dir,
// and every fail-open path (malformed file, unwritable disk, throwing seams).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createMasteryModel, masteryFileSchema } from "../../src/um/mastery";
import { masteryFile } from "../../src/config/paths";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "cc-mastery-"));
  dirs.push(d);
  return { CORPOCODE_HOME: d } as NodeJS.ProcessEnv;
}

/** In-memory fs seams for the injected-io tests. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = { ...initial };
  return {
    files,
    readFile: (p: string) => (p in files ? files[p] : null),
    writeFile: (p: string, text: string) => {
      files[p] = text;
      return true;
    },
  };
}

describe("treatment matrix (constantPoll)", () => {
  it("teach on => teach-then-poll; teach off => poll; never assume regardless of enabled/history", () => {
    const fs = fakeFs();
    for (const enabled of [true, false]) {
      const teachOn = createMasteryModel({ file: "/m.json", teach: true, enabled, ...fs });
      const teachOff = createMasteryModel({ file: "/m.json", teach: false, enabled, ...fs });
      // Pile up confident history — Phase 1 must still never assume.
      for (let i = 0; i < 20; i++) teachOn.observe("routing", { confident: true, delegated: false });
      expect(teachOn.treatment("routing")).toBe("teach-then-poll");
      expect(teachOff.treatment("routing")).toBe("poll");
    }
  });
});

describe("observation persistence", () => {
  it("appends and round-trips via injected seams, with timestamps from injected now()", () => {
    const fs = fakeFs();
    let t = 1000;
    const m = createMasteryModel({
      file: "/m.json",
      teach: true,
      enabled: true,
      now: () => t,
      ...fs,
    });
    m.observe("caching", { confident: true, delegated: false });
    t = 2000;
    m.observe("caching", { confident: false, delegated: true });
    const shape = masteryFileSchema.parse(JSON.parse(fs.files["/m.json"]!));
    expect(shape.concepts["caching"]!.observations).toEqual([
      { at: 1000, confident: true, delegated: false },
      { at: 2000, confident: false, delegated: true },
    ]);
  });

  it("persists to the real masteryFile under a CORPOCODE_HOME temp dir", () => {
    const env = home();
    const m = createMasteryModel({ env, teach: false, enabled: false, now: () => 42 });
    m.observe("sharding", { confident: true, delegated: false });
    const onDisk = masteryFileSchema.parse(JSON.parse(readFileSync(masteryFile(env), "utf8")));
    expect(onDisk.concepts["sharding"]!.observations).toEqual([
      { at: 42, confident: true, delegated: false },
    ]);
    // Second model instance reads the same file and appends — a true round-trip.
    const m2 = createMasteryModel({ env, teach: false, enabled: false, now: () => 43 });
    m2.observe("sharding", { confident: false, delegated: true });
    const again = masteryFileSchema.parse(JSON.parse(readFileSync(masteryFile(env), "utf8")));
    expect(again.concepts["sharding"]!.observations).toHaveLength(2);
  });

  it("replaces a malformed existing file instead of crashing", () => {
    const env = home();
    const p = masteryFile(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json at all");
    const m = createMasteryModel({ env, teach: true, enabled: true, now: () => 7 });
    expect(() => m.observe("auth", { confident: false, delegated: false })).not.toThrow();
    const shape = masteryFileSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    expect(shape.concepts["auth"]!.observations).toEqual([
      { at: 7, confident: false, delegated: false },
    ]);
  });

  it("treats a shape-drifted (valid JSON, wrong schema) file as fresh", () => {
    const fs = fakeFs({ "/m.json": JSON.stringify({ version: 99, concepts: "nope" }) });
    const m = createMasteryModel({ file: "/m.json", teach: true, enabled: true, now: () => 1, ...fs });
    m.observe("queues", { confident: true, delegated: false });
    const shape = masteryFileSchema.parse(JSON.parse(fs.files["/m.json"]!));
    expect(shape.version).toBe(1);
    expect(Object.keys(shape.concepts)).toEqual(["queues"]);
  });
});

describe("fail-open observe", () => {
  it("never throws when writeFile returns false", () => {
    const m = createMasteryModel({
      file: "/m.json",
      teach: true,
      enabled: true,
      readFile: () => null,
      writeFile: () => false,
    });
    expect(() => m.observe("x", { confident: true, delegated: false })).not.toThrow();
  });

  it("never throws when the injected seams themselves throw", () => {
    const m = createMasteryModel({
      file: "/m.json",
      teach: false,
      enabled: false,
      readFile: () => {
        throw new Error("disk on fire");
      },
      writeFile: () => {
        throw new Error("disk still on fire");
      },
    });
    expect(() => m.observe("x", { confident: false, delegated: true })).not.toThrow();
    // Treatment is unaffected by broken persistence.
    expect(m.treatment("x")).toBe("poll");
  });

  it("never throws when the default fs path is unwritable (file is a directory)", () => {
    const env = home();
    // Make the mastery path itself a directory so writeFileSync must fail.
    mkdirSync(masteryFile(env), { recursive: true });
    const m = createMasteryModel({ env, teach: true, enabled: true });
    expect(() => m.observe("x", { confident: true, delegated: false })).not.toThrow();
  });
});
