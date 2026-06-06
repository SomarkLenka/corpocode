// The agent-session store — disk-backed continuity for the IntelligentRouter. Every hook is a fresh
// process, so a `claude` agent thread CorpoCode opened in one hook can only be resumed in the next if we
// persist its server-side session uuid. This store does exactly that and nothing more: one small JSON
// record per purpose-scoped key (per-file or per-topic), with TTL + LRU eviction so the directory can't
// grow without bound. The router decides reuse-vs-new; this just remembers.
//
// Fail-open throughout (the In-flight tenet): a missing/corrupt record reads as null, a write error is
// swallowed (continuity is best-effort — losing a session only costs one cold start), and eviction never
// throws into a hook. Nothing here makes a model call.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { agentSessionsDir, agentSessionFile, ensureDir } from "../config/paths";
import type { Logger } from "../log/ndjson";

/** A persisted agent-session record, so a fresh hook process can `--resume <claudeSessionId>`. */
export interface AgentSessionRecord {
  key: string;
  hostSessionId: string; // the host (Claude Code) session that owns it — lets SessionEnd release just its own
  claudeSessionId: string;
  lastUsedTs: number;
  turns: number;
  files: string[];
  persisted: boolean;
}

export interface SessionStoreOptions {
  ttlMs: number;
  maxSessions: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  logger?: Logger;
}

export interface SessionStore {
  /** The fresh record for a key, or null if absent/expired/unreadable. */
  get(key: string): AgentSessionRecord | null;
  /** Persist (create or update) a record. Best-effort — a write failure is swallowed. */
  put(record: AgentSessionRecord): void;
  /** Delete one record by key. Best-effort. */
  remove(key: string): void;
  /** Drop expired records, then LRU-trim to maxSessions. Returns how many were removed. */
  evict(now?: number): { removed: number };
  /** Every readable record (for eviction sweeps and a doctor view). */
  all(): AgentSessionRecord[];
}

/** Purpose-scoped session keys. Hashing keeps host session ids + paths out of the filename and makes the
 *  key fixed-length; the per-file scope lets a file discussed earlier resume, per-topic groups a thread. */
export function sessionKeyForFile(hostSessionId: string, relpath: string): string {
  return createHash("sha1").update(`${hostSessionId}:${relpath}`).digest("hex");
}
export function sessionKeyForTopic(hostSessionId: string, slug: string): string {
  return createHash("sha1").update(`${hostSessionId}:topic:${slug}`).digest("hex");
}

function isRecord(v: unknown): v is AgentSessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === "string" && typeof r.claudeSessionId === "string" && typeof r.lastUsedTs === "number";
}

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const file = (key: string): string => agentSessionFile(key, opts.cwd, opts.env);

  const readRecord = (path: string): AgentSessionRecord | null => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null; // absent or corrupt → treat as no session (fail-open)
    }
  };

  const all = (): AgentSessionRecord[] => {
    let names: string[];
    try {
      names = readdirSync(agentSessionsDir(opts.cwd, opts.env)).filter((n) => n.endsWith(".json"));
    } catch {
      return []; // directory not created yet → no sessions
    }
    const out: AgentSessionRecord[] = [];
    for (const name of names) {
      const rec = readRecord(agentSessionFile(name.replace(/\.json$/, ""), opts.cwd, opts.env));
      if (rec) out.push(rec);
    }
    return out;
  };

  const remove = (key: string): void => {
    try {
      rmSync(file(key), { force: true });
    } catch {
      // best-effort
    }
  };

  return {
    all,
    remove,

    get(key) {
      const rec = readRecord(file(key));
      if (!rec) return null;
      if (now() - rec.lastUsedTs > opts.ttlMs) {
        remove(key); // expired — drop it so the caller mints a fresh session
        return null;
      }
      return rec;
    },

    put(record) {
      try {
        ensureDir(agentSessionsDir(opts.cwd, opts.env));
        writeFileSync(file(record.key), JSON.stringify(record), "utf8");
      } catch (err) {
        opts.logger?.log({ event: "agent_session_put_failed", key: record.key, reason: err instanceof Error ? err.message : String(err) });
      }
    },

    evict(at) {
      const t = at ?? now();
      const records = all();
      let removed = 0;

      const live: AgentSessionRecord[] = [];
      for (const rec of records) {
        if (t - rec.lastUsedTs > opts.ttlMs) {
          remove(rec.key);
          removed++;
        } else {
          live.push(rec);
        }
      }

      // LRU trim: oldest-used first, drop the overflow beyond maxSessions.
      if (live.length > opts.maxSessions) {
        live.sort((a, b) => a.lastUsedTs - b.lastUsedTs);
        for (const rec of live.slice(0, live.length - opts.maxSessions)) {
          remove(rec.key);
          removed++;
        }
      }

      if (removed > 0) opts.logger?.log({ event: "agent_sessions_evicted", removed, remaining: Math.min(live.length, opts.maxSessions) });
      return { removed };
    },
  };
}
