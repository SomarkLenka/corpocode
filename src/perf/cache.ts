// A version-scoped keyed cache (Phase 4 §4). The whole point is to never pay twice for an answer that
// cannot have changed — and to NEVER serve a stale one. Invalidation is structural: the cache carries a
// version token, and the moment that token differs from what's on disk the entire cache is dropped. So
// a cache hit is always a correct answer (its version matched) and there is no per-entry expiry to get
// wrong. The store is injectable (memory for tests, a file for cross-process reuse); both are fail-open.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "../config/paths";

export interface CacheData {
  version: string;
  entries: Record<string, unknown>;
}

export interface CacheStore {
  read(): CacheData | null;
  write(data: CacheData): void;
}

/** In-process store — useful for tests and for memoizing within a single hook invocation. */
export function memoryStore(): CacheStore {
  let mem: CacheData | null = null;
  return {
    read: () => mem,
    write: (d) => {
      mem = d;
    },
  };
}

/** Disk store — survives across the per-hook process boundary, fail-open on any IO error. */
export function fileStore(path: string): CacheStore {
  return {
    read() {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheData;
        return parsed && typeof parsed === "object" && typeof parsed.version === "string" ? parsed : null;
      } catch {
        return null; // missing/corrupt cache reads as empty, never throws
      }
    },
    write(data) {
      try {
        ensureDir(dirname(path));
        writeFileSync(path, JSON.stringify(data));
      } catch {
        // caching is a performance aid, never a correctness dependency — a write failure is swallowed
      }
    },
  };
}

export interface Cache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function createCache<T>(opts: { version: string; store?: CacheStore }): Cache<T> {
  const store = opts.store ?? memoryStore();
  let data = store.read();
  if (!data || data.version !== opts.version) {
    // Version mismatch (or first use) → start fresh. This is what guarantees a hit is never stale.
    data = { version: opts.version, entries: {} };
    store.write(data);
  }
  const current = data;
  return {
    get: (key) => current.entries[key] as T | undefined,
    set: (key, value) => {
      current.entries[key] = value;
      store.write(current);
    },
  };
}
