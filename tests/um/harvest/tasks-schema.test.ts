import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseTasksFile, emitTasksFile } from "../../../src/um/harvest/tasks-schema";
import { specSchema, type Spec } from "../../../src/um/spec-schema";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "superpowers", name), "utf8")) as unknown;

/** A schema-valid spec with two seeds and one resolvable acceptance criterion. */
const makeSpec = (overrides: Partial<Spec> = {}): Spec =>
  specSchema.parse({
    runId: "run-1",
    task: "build the thing",
    acceptance: [
      { id: "ac-1", criterion: "the loader tolerates a corrupt file", verify: { method: "test", command: "npx vitest run tests/x.test.ts" } },
    ],
    taskSeeds: [
      {
        id: "seed-a",
        title: "Loader",
        description: "Write the tolerant loader",
        files: ["src/x.ts"],
        dependsOn: [],
        verifyCommand: "npx vitest run tests/x.test.ts",
        acceptanceRefs: ["ac-1"],
      },
      {
        id: "seed-b",
        title: "Consumer",
        description: "Wire the loader into the handler",
        files: ["src/y.ts"],
        dependsOn: ["seed-a"],
        acceptanceRefs: [],
      },
    ],
    ...overrides,
  });

describe("parseTasksFile", () => {
  it("parses a plan file as the superpowers plugin writes it, filling superset defaults", () => {
    const file = parseTasksFile(fixture("valid-superpowers.json"));
    expect(file).not.toBeNull();
    expect(file!.version).toBe(1);
    expect(file!.tasks).toHaveLength(2);
    const [first] = file!.tasks;
    // superpowers plan tasks carry no title/dependsOn/specRefs — defaults fill them
    expect(first.title).toBe("");
    expect(first.dependsOn).toEqual([]);
    expect(first.specRefs).toEqual([]);
    expect(first.status).toBe("in_progress");
    expect(first.verifyCommand).toBe("npx vitest run tests/agents/sessions.test.ts");
    expect(first.acceptanceCriteria).toHaveLength(2);
  });

  it("parses our superset file, preserving dependsOn/specRefs/budgetUsd and stripping unknown keys", () => {
    const file = parseTasksFile(fixture("valid-superset.json"));
    expect(file).not.toBeNull();
    const [a, b] = file!.tasks;
    expect(a.budgetUsd).toBe(0.5);
    expect(a.modelTier).toBe("standard");
    expect(a.specRefs).toEqual(["ac-1"]);
    expect(a.status).toBe("completed");
    expect((a as Record<string, unknown>).unknownFutureField).toBeUndefined();
    expect(b.dependsOn).toEqual(["seed-a"]);
    expect(b.specRefs).toEqual(["ac-1", "ac-2"]);
    // description defaults, verifyCommand stays absent — never invented on the parse side either
    expect(b.verifyCommand).toBeUndefined();
    expect(b.acceptanceCriteria).toEqual([]);
  });

  it("returns null for a malformed file (tasks not an array) — never throws", () => {
    expect(parseTasksFile(fixture("malformed.json"))).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseTasksFile(null)).toBeNull();
    expect(parseTasksFile("nope")).toBeNull();
    expect(parseTasksFile(42)).toBeNull();
    expect(parseTasksFile(undefined)).toBeNull();
  });

  it("rejects a task missing its id", () => {
    expect(parseTasksFile({ tasks: [{ description: "no id" }] })).toBeNull();
  });
});

describe("emitTasksFile", () => {
  it("maps seeds: acceptanceRefs -> specRefs, criteria resolved by ref, status pending", () => {
    const result = emitTasksFile(makeSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b] = result.file.tasks;
    expect(result.file.version).toBe(1);
    expect(a.id).toBe("seed-a");
    expect(a.title).toBe("Loader");
    expect(a.files).toEqual(["src/x.ts"]);
    expect(a.status).toBe("pending");
    expect(a.specRefs).toEqual(["ac-1"]);
    expect(a.acceptanceCriteria).toEqual(["the loader tolerates a corrupt file"]);
    expect(a.verifyCommand).toBe("npx vitest run tests/x.test.ts");
    // an absent verifyCommand is carried through as absent — authoring is decompose's job
    expect(b.verifyCommand).toBeUndefined();
    expect(b.dependsOn).toEqual(["seed-a"]);
  });

  it("round-trips: the emitted file re-parses identically", () => {
    const result = emitTasksFile(makeSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reparsed = parseTasksFile(JSON.parse(JSON.stringify(result.file)) as unknown);
    expect(reparsed).toEqual(result.file);
  });

  it("keeps an unresolvable acceptanceRef in specRefs but resolves no criterion text", () => {
    const spec = makeSpec();
    spec.taskSeeds[1] = { ...spec.taskSeeds[1], acceptanceRefs: ["ac-missing"] };
    const result = emitTasksFile(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.tasks[1].specRefs).toEqual(["ac-missing"]);
    expect(result.file.tasks[1].acceptanceCriteria).toEqual([]);
  });

  it("rejects a dependsOn naming a nonexistent seed, naming the offender", () => {
    const spec = makeSpec();
    spec.taskSeeds[1] = { ...spec.taskSeeds[1], dependsOn: ["seed-ghost"] };
    const result = emitTasksFile(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("seed-b");
    expect(result.error).toContain("seed-ghost");
  });

  it("rejects a dependency cycle, naming the ids on it", () => {
    const spec = makeSpec();
    spec.taskSeeds[0] = { ...spec.taskSeeds[0], dependsOn: ["seed-b"] };
    const result = emitTasksFile(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cycle");
    expect(result.error).toContain("seed-a");
    expect(result.error).toContain("seed-b");
  });

  it("rejects a self-cycle", () => {
    const spec = makeSpec();
    spec.taskSeeds[0] = { ...spec.taskSeeds[0], dependsOn: ["seed-a"] };
    const result = emitTasksFile(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("seed-a");
  });

  it("emits an empty task list from a spec with no seeds", () => {
    const result = emitTasksFile(makeSpec({ taskSeeds: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.tasks).toEqual([]);
  });
});

// The pcvelz/superpowers NATIVE persistence shape (numeric ids, subject/blockedBy, json:metadata
// fence inside the description) — the shape `--from-plan` actually receives from the plugin.
import { parseNativePlanFile } from "../../../src/um/harvest/tasks-schema";

describe("parseNativePlanFile", () => {
  it("imports the native plan shape: fence metadata extracted, ids/blockedBy stringified", () => {
    const file = parseNativePlanFile(fixture("valid-native-plan.tasks.json"))!;
    expect(file.tasks).toHaveLength(3);
    const [store, toggle, docs] = file.tasks;
    expect(store).toMatchObject({
      id: "0",
      title: "Task 0: Theme store",
      status: "completed",
      files: ["src/theme/store.ts"],
      verifyCommand: "npm test -- theme",
      modelTier: "mechanical",
    });
    expect(toggle).toMatchObject({ id: "1", dependsOn: ["0"], userGate: true, tags: ["user-gate"] });
    expect(toggle!.acceptanceCriteria).toEqual(["toggle flips data-theme attribute"]);
    // A task with no fence still imports — metadata degrades to empty, never rejects the plan.
    expect(docs).toMatchObject({ id: "2", files: [], acceptanceCriteria: [] });
    expect(docs!.verifyCommand).toBeUndefined();
  });

  it("re-parses through the superset schema (the two shapes converge on one TasksFile)", () => {
    const file = parseNativePlanFile(fixture("valid-native-plan.tasks.json"))!;
    expect(parseTasksFile(file)).toEqual(file);
  });

  it("returns null for the flat superset shape and for junk (callers fall back explicitly)", () => {
    expect(parseNativePlanFile(fixture("malformed.json"))).toBeNull();
    expect(parseNativePlanFile({ tasks: [] })).toBeNull();
    expect(parseNativePlanFile("nope")).toBeNull();
  });
});
