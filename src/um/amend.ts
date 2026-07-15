// OpenSpec-style delta amendments to an approved spec. A run's spec is not frozen forever: a
// mid-flight escalation or a pilot revision lands as a DELTA — add-or-replace some keys, drop others —
// not a wholesale rewrite. The delta is applied by keyed-merge so an amendment is auditable at the key
// level: exactly which entities/contracts/acceptance/etc. were added, replaced, or removed.
//
// Pure and non-mutating: the input spec is never touched (its arrays keep their identity), the amended
// spec is a fresh object, and every collection carries the same keyed-merge convention the loop uses:
//   entities / contracts / compartments / reusableSystems  → keyed by `.name`
//   acceptance / taskSeeds                                  → keyed by `.id`
//   constraints / futureSeams / scalePath                  → keyed by value (de-dup by ===)
// The clock is injected (`now`) — no Date.now() in module logic. Not yet wired into the loop.
import type { Spec } from "./spec-schema";

/** Keys/ids/values to drop from each collection. */
export interface SpecRemove {
  entities?: string[];
  contracts?: string[];
  constraints?: string[];
  futureSeams?: string[];
  compartments?: string[];
  scalePath?: string[];
  reusableSystems?: string[];
  acceptance?: string[];
  taskSeeds?: string[];
}

/** A spec delta: keyed add-or-replace, then keyed remove. Either half may be omitted. */
export interface SpecDelta {
  add?: Partial<
    Pick<
      Spec,
      | "entities"
      | "contracts"
      | "constraints"
      | "futureSeams"
      | "compartments"
      | "scalePath"
      | "reusableSystems"
      | "acceptance"
      | "taskSeeds"
    >
  >;
  remove?: SpecRemove;
}

/** The audit trail of one amendment — what actually changed, keyed for the ledger. */
export interface AmendmentRecord {
  at: number;
  wasApproved: boolean;
  addedKeys: Record<string, string[]>;
  removedKeys: Record<string, string[]>;
}

/** The collections and how each is keyed. Object collections key by a field; scalars key by value. */
const OBJECT_COLLECTIONS = {
  entities: "name",
  contracts: "name",
  compartments: "name",
  reusableSystems: "name",
  acceptance: "id",
  taskSeeds: "id",
} as const;

const VALUE_COLLECTIONS = ["constraints", "futureSeams", "scalePath"] as const;

type ObjectCollectionKey = keyof typeof OBJECT_COLLECTIONS;
type ValueCollectionKey = (typeof VALUE_COLLECTIONS)[number];

/** Merge additions into an object collection by key: replace-if-present, else append. Returns the new
 *  array and the keys that were actually added or replaced (order = order of the additions). */
function mergeObjects<T extends Record<string, unknown>>(
  current: readonly T[],
  additions: readonly T[] | undefined,
  keyField: string,
): { merged: T[]; addedKeys: string[] } {
  const merged = current.map((item) => item); // fresh array; elements kept by identity unless replaced
  const addedKeys: string[] = [];
  for (const addition of additions ?? []) {
    const key = String(addition[keyField]);
    const idx = merged.findIndex((item) => String(item[keyField]) === key);
    if (idx >= 0) merged[idx] = addition;
    else merged.push(addition);
    addedKeys.push(key);
  }
  return { merged, addedKeys };
}

/** Merge additions into a value collection, de-duping by ===. Records only genuinely-new values. */
function mergeValues(
  current: readonly string[],
  additions: readonly string[] | undefined,
): { merged: string[]; addedKeys: string[] } {
  const merged = current.map((v) => v);
  const addedKeys: string[] = [];
  for (const value of additions ?? []) {
    if (!merged.includes(value)) {
      merged.push(value);
      addedKeys.push(value);
    }
  }
  return { merged, addedKeys };
}

/** Filter out named keys from an object collection. Records the keys that were actually present. */
function removeObjects<T extends Record<string, unknown>>(
  current: readonly T[],
  toRemove: readonly string[] | undefined,
  keyField: string,
): { kept: T[]; removedKeys: string[] } {
  if (!toRemove?.length) return { kept: current.map((item) => item), removedKeys: [] };
  const drop = new Set(toRemove);
  const kept: T[] = [];
  const removedKeys: string[] = [];
  for (const item of current) {
    const key = String(item[keyField]);
    if (drop.has(key)) removedKeys.push(key);
    else kept.push(item);
  }
  return { kept, removedKeys };
}

/** Filter out named values from a value collection. Records the values that were actually present. */
function removeValues(
  current: readonly string[],
  toRemove: readonly string[] | undefined,
): { kept: string[]; removedKeys: string[] } {
  if (!toRemove?.length) return { kept: current.map((v) => v), removedKeys: [] };
  const drop = new Set(toRemove);
  const kept: string[] = [];
  const removedKeys: string[] = [];
  for (const value of current) {
    if (drop.has(value)) removedKeys.push(value);
    else kept.push(value);
  }
  return { kept, removedKeys };
}

/**
 * Apply a delta to a spec by keyed-merge (add-or-replace) then keyed-filter (remove), returning a
 * fresh amended spec and an AmendmentRecord of exactly what changed. The input spec is never mutated.
 */
export function applyAmendment(
  spec: Spec,
  delta: SpecDelta,
  now: number,
): { spec: Spec; amendment: AmendmentRecord } {
  const out: Spec = { ...spec };
  const addedKeys: Record<string, string[]> = {};
  const removedKeys: Record<string, string[]> = {};

  for (const collection of Object.keys(OBJECT_COLLECTIONS) as ObjectCollectionKey[]) {
    const keyField = OBJECT_COLLECTIONS[collection];
    const current = spec[collection] as Record<string, unknown>[];
    const additions = delta.add?.[collection] as Record<string, unknown>[] | undefined;
    const toRemove = delta.remove?.[collection];

    const added = mergeObjects(current, additions, keyField);
    const removed = removeObjects(added.merged, toRemove, keyField);
    (out as Record<string, unknown>)[collection] = removed.kept;

    if (added.addedKeys.length) addedKeys[collection] = added.addedKeys;
    if (removed.removedKeys.length) removedKeys[collection] = removed.removedKeys;
  }

  for (const collection of VALUE_COLLECTIONS as readonly ValueCollectionKey[]) {
    const current = spec[collection] as string[];
    const additions = delta.add?.[collection] as string[] | undefined;
    const toRemove = delta.remove?.[collection];

    const added = mergeValues(current, additions);
    const removed = removeValues(added.merged, toRemove);
    (out as Record<string, unknown>)[collection] = removed.kept;

    if (added.addedKeys.length) addedKeys[collection] = added.addedKeys;
    if (removed.removedKeys.length) removedKeys[collection] = removed.removedKeys;
  }

  return {
    spec: out,
    amendment: {
      at: now,
      wasApproved: spec.approvedAt !== undefined,
      addedKeys,
      removedKeys,
    },
  };
}
