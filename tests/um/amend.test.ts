import { describe, it, expect } from "vitest";
import { applyAmendment, type SpecDelta } from "../../src/um/amend";
import { specSchema, type Spec } from "../../src/um/spec-schema";

// ---------- fixtures ----------

/** A minimal, schema-valid approved spec with one of each keyed collection to amend. */
function baseSpec(over?: Partial<Spec>): Spec {
  return specSchema.parse({
    version: 1,
    runId: "run-1",
    task: "build a widget service",
    entities: [{ name: "User", description: "a person", fields: ["id"] }],
    contracts: [{ name: "getUser", kind: "function", signature: "(id)=>User", description: "fetch" }],
    constraints: ["node>=20"],
    futureSeams: ["pluggable-storage"],
    compartments: [{ name: "store", responsibility: "persistence", reasonToChange: "db swap" }],
    scalePath: ["shard-by-tenant"],
    reusableSystems: [{ name: "logger", purpose: "ndjson" }],
    acceptance: [{ id: "a1", criterion: "user CRUD works", verify: { method: "test", command: "npm t" } }],
    taskSeeds: [
      { id: "t1", title: "schema", description: "make schema", files: [], dependsOn: [], acceptanceRefs: ["a1"] },
    ],
    decisions: [],
    sections: {},
    approvedAt: 5000,
    ...over,
  });
}

// ---------- add via keyed-merge ----------

describe("applyAmendment — add", () => {
  it("adds a new entity and REPLACES an existing acceptance by id", () => {
    const spec = baseSpec();
    const delta: SpecDelta = {
      add: {
        entities: [{ name: "Widget", description: "a thing", fields: ["id", "name"] }],
        acceptance: [{ id: "a1", criterion: "user CRUD is idempotent", verify: { method: "manual" } }],
      },
    };
    const { spec: out, amendment } = applyAmendment(spec, delta, 9000);

    // entity added alongside the original
    expect(out.entities.map((e) => e.name)).toEqual(["User", "Widget"]);
    // acceptance a1 replaced in place (not duplicated), count unchanged
    expect(out.acceptance).toHaveLength(1);
    expect(out.acceptance[0]!.criterion).toBe("user CRUD is idempotent");
    expect(out.acceptance[0]!.verify.method).toBe("manual");

    expect(amendment.at).toBe(9000);
    expect(amendment.wasApproved).toBe(true);
    expect(amendment.addedKeys.entities).toEqual(["Widget"]);
    expect(amendment.addedKeys.acceptance).toEqual(["a1"]);
    // result still round-trips the authoritative schema
    expect(specSchema.parse(out)).toEqual(out);
  });

  it("constraints add de-dups by value (adding an existing constraint is a no-op key-wise)", () => {
    const spec = baseSpec();
    const delta: SpecDelta = { add: { constraints: ["node>=20", "no network in tests"] } };
    const { spec: out, amendment } = applyAmendment(spec, delta, 9000);

    expect(out.constraints).toEqual(["node>=20", "no network in tests"]);
    // only the genuinely-new value is recorded as added
    expect(amendment.addedKeys.constraints).toEqual(["no network in tests"]);
  });

  it("adds a new taskSeed and contract by their keys", () => {
    const spec = baseSpec();
    const delta: SpecDelta = {
      add: {
        contracts: [{ name: "delUser", kind: "function", signature: "(id)=>void", description: "delete" }],
        taskSeeds: [
          { id: "t2", title: "api", description: "wire api", files: [], dependsOn: ["t1"], acceptanceRefs: [] },
        ],
      },
    };
    const { spec: out, amendment } = applyAmendment(spec, delta, 9000);
    expect(out.contracts.map((c) => c.name)).toEqual(["getUser", "delUser"]);
    expect(out.taskSeeds.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(amendment.addedKeys.contracts).toEqual(["delUser"]);
    expect(amendment.addedKeys.taskSeeds).toEqual(["t2"]);
  });
});

// ---------- remove ----------

describe("applyAmendment — remove", () => {
  it("removes an acceptance id and a taskSeed id, filtering them out", () => {
    const spec = baseSpec({
      acceptance: [
        { id: "a1", criterion: "c1", verify: { method: "manual" } },
        { id: "a2", criterion: "c2", verify: { method: "manual" } },
      ],
      taskSeeds: [
        { id: "t1", title: "one", description: "d", files: [], dependsOn: [], acceptanceRefs: [] },
        { id: "t2", title: "two", description: "d", files: [], dependsOn: [], acceptanceRefs: [] },
      ],
    });
    const delta: SpecDelta = { remove: { acceptance: ["a1"], taskSeeds: ["t2"] } };
    const { spec: out, amendment } = applyAmendment(spec, delta, 9000);

    expect(out.acceptance.map((a) => a.id)).toEqual(["a2"]);
    expect(out.taskSeeds.map((t) => t.id)).toEqual(["t1"]);
    expect(amendment.removedKeys.acceptance).toEqual(["a1"]);
    expect(amendment.removedKeys.taskSeeds).toEqual(["t2"]);
  });

  it("removes a constraint by value and an entity by name", () => {
    const spec = baseSpec({
      constraints: ["node>=20", "no network in tests"],
      entities: [
        { name: "User", description: "d", fields: [] },
        { name: "Widget", description: "d", fields: [] },
      ],
    });
    const delta: SpecDelta = { remove: { constraints: ["node>=20"], entities: ["Widget"] } };
    const { spec: out, amendment } = applyAmendment(spec, delta, 9000);

    expect(out.constraints).toEqual(["no network in tests"]);
    expect(out.entities.map((e) => e.name)).toEqual(["User"]);
    expect(amendment.removedKeys.constraints).toEqual(["node>=20"]);
    expect(amendment.removedKeys.entities).toEqual(["Widget"]);
  });

  it("removing a key that is not present records nothing removed", () => {
    const spec = baseSpec();
    const { amendment } = applyAmendment(spec, { remove: { entities: ["Nope"] } }, 9000);
    expect(amendment.removedKeys.entities ?? []).toEqual([]);
  });
});

// ---------- record + immutability ----------

describe("applyAmendment — record and immutability", () => {
  it("wasApproved reflects spec.approvedAt", () => {
    const approved = applyAmendment(baseSpec({ approvedAt: 5000 }), {}, 9000);
    expect(approved.amendment.wasApproved).toBe(true);

    const draft = applyAmendment(baseSpec({ approvedAt: undefined }), {}, 9000);
    expect(draft.amendment.wasApproved).toBe(false);
  });

  it("does NOT mutate the input spec (arrays and elements unchanged)", () => {
    const spec = baseSpec();
    const entitiesRef = spec.entities;
    const beforeNames = spec.entities.map((e) => e.name);
    const beforeAcceptance = JSON.stringify(spec.acceptance);

    const delta: SpecDelta = {
      add: {
        entities: [{ name: "Widget", description: "d", fields: [] }],
        acceptance: [{ id: "a1", criterion: "changed", verify: { method: "manual" } }],
      },
      remove: { constraints: ["node>=20"] },
    };
    applyAmendment(spec, delta, 9000);

    expect(spec.entities).toBe(entitiesRef); // same reference, untouched
    expect(spec.entities.map((e) => e.name)).toEqual(beforeNames);
    expect(JSON.stringify(spec.acceptance)).toBe(beforeAcceptance);
    expect(spec.constraints).toEqual(["node>=20"]);
  });

  it("an empty delta yields an equal spec and empty record maps", () => {
    const spec = baseSpec();
    const { spec: out, amendment } = applyAmendment(spec, {}, 9000);
    expect(out).toEqual(spec);
    expect(out).not.toBe(spec); // still a fresh object
    expect(amendment.addedKeys).toEqual({});
    expect(amendment.removedKeys).toEqual({});
  });
});
