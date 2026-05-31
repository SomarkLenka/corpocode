// OpenViking adapter — completes the ContextStore. An HTTP client to the daemon on
// localhost:1933. The retrieval team reads through `find`/`load`, the compactor writes through
// `write`; `tree`/`grep` round out the surface. Phase 1 shipped only the lifecycle (start/health/
// ping) so provision + doctor worked; Phase 2 wires the data path.
//
// Resilience (the In-flight tenet): a daemon can be briefly down (restarting, or not yet up after a
// reboot). On a refused connection the adapter makes EXACTLY ONE attempt to start the daemon and
// then retries the call once; if it still fails it raises a clear error rather than hanging or
// retrying forever. Callers (retrieval, compactor) treat any throw as "degrade", never as a turn
// breaker — so a momentarily-absent daemon costs context, never correctness.
import { spawn } from "node:child_process";
import { z } from "zod";
import type { ContextStore, FindResult, Resource, ResourceKind, Tier, TreeEntry } from "./types";

export interface OpenVikingAdapterOptions {
  baseUrl?: string;
  serverCmd?: string;
  // Injectable for tests / non-default environments:
  fetchFn?: typeof fetch;
  spawnServer?: () => void;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_OPENVIKING_BASE_URL = "http://localhost:1933";

const tierSchema = z.enum(["L0", "L1", "L2"]);
const resourceKindSchema = z.enum(["memory", "resource", "skill"]);

// Tolerant parse of a daemon resource: estimate tokens when the daemon omits them so callers always
// get a usable number for budgeting.
const resourceSchema = z
  .object({
    uri: z.string(),
    kind: resourceKindSchema.default("resource"),
    tier: tierSchema.default("L0"),
    content: z.string().default(""),
    tokens: z.number().int().nonnegative().optional(),
    score: z.number().optional(),
    children: z.array(z.string()).optional(),
  })
  .transform((r) => ({
    uri: r.uri,
    kind: r.kind,
    tier: r.tier,
    content: r.content,
    tokens: r.tokens ?? estimateTokens(r.content),
    ...(r.score !== undefined ? { score: r.score } : {}),
    ...(r.children ? { children: r.children } : {}),
  }));

const findResponseSchema = z.object({
  resources: z.array(resourceSchema).default([]),
  trajectory: z.array(z.string()).optional(),
});
const loadResponseSchema = z.object({ content: z.string() });
const treeResponseSchema = z.object({
  entries: z
    .array(
      z.object({
        uri: z.string(),
        kind: z.union([resourceKindSchema, z.literal("directory")]).default("resource"),
        abstract: z.string().optional(),
        childCount: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
});
const grepResponseSchema = z.object({ resources: z.array(resourceSchema).default([]) });

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Node's fetch wraps a refused TCP connect as a TypeError whose `cause.code` is ECONNREFUSED. */
function isConnRefused(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | undefined;
  if (!e) return false;
  if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") return true;
  return typeof e.message === "string" && /econnrefused|connection refused|fetch failed/i.test(e.message);
}

export function createOpenVikingAdapter(opts: OpenVikingAdapterOptions = {}): ContextStore {
  const baseUrl = opts.baseUrl ?? DEFAULT_OPENVIKING_BASE_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const startTimeoutMs = opts.startTimeoutMs ?? 15_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Set by the default spawner's error handler when the binary is missing, so startup fails fast
  // instead of polling for a daemon that will never appear.
  let spawnFailed = false;
  const spawnServer =
    opts.spawnServer ??
    (() => {
      const child = spawn(opts.serverCmd ?? "openviking-server", [], { detached: true, stdio: "ignore" });
      // A missing binary emits an async 'error' (ENOENT). With NO listener, Node treats it as a fatal
      // unhandled error and crashes the whole hook process — bypassing the fail-open catch entirely.
      // Swallow it and record the failure (the In-flight tenet: degrade, never crash).
      child.on("error", () => {
        spawnFailed = true;
      });
      child.unref();
    });

  const health = async (): Promise<{ up: boolean; version?: string }> => {
    try {
      const res = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return { up: false };
      const body = (await res.json().catch(() => ({}))) as { version?: string };
      return body.version ? { up: true, version: body.version } : { up: true };
    } catch {
      return { up: false };
    }
  };

  const startDaemon = async (): Promise<void> => {
    if ((await health()).up) return; // idempotent
    spawnFailed = false;
    spawnServer();
    let waited = 0;
    while (waited < startTimeoutMs) {
      await sleep(pollIntervalMs);
      waited += pollIntervalMs;
      if ((await health()).up) return;
      if (spawnFailed) throw new Error("OpenViking server could not be started (is it installed?)");
    }
    throw new Error(`OpenViking did not become healthy within ${startTimeoutMs}ms`);
  };

  // One restart attempt on a refused connection, then exactly one retry. Any other error, or a
  // second refusal, surfaces as a clean throw — never an unbounded retry loop.
  const withDaemon = async (res: () => Promise<Response>): Promise<Response> => {
    try {
      return await res();
    } catch (err) {
      if (!isConnRefused(err)) throw normalize(err);
      await startDaemon(); // the single `daemon_restart` attempt
      return await res(); // a second refusal here propagates as a clean error
    }
  };

  const normalize = (err: unknown): Error => {
    if (err instanceof Error) return new Error(`OpenViking request failed: ${err.message}`);
    return new Error(`OpenViking request failed: ${String(err)}`);
  };

  // Schemas are typed structurally as `{ parse }` so a transforming schema (ZodEffects) whose input
  // type differs from its output type still slots in cleanly and infers T from the parsed output.
  const getJson = async <T>(path: string, schema: { parse: (data: unknown) => T }): Promise<T> => {
    const res = await withDaemon(() =>
      fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(requestTimeoutMs) }),
    );
    if (!res.ok) throw new Error(`OpenViking ${path} returned ${res.status}`);
    return schema.parse(await res.json());
  };

  const postJson = async <T>(
    path: string,
    body: unknown,
    schema: { parse: (data: unknown) => T },
  ): Promise<T> => {
    const res = await withDaemon(() =>
      fetchFn(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      }),
    );
    if (!res.ok) throw new Error(`OpenViking ${path} returned ${res.status}`);
    return schema.parse(await res.json());
  };

  const store: ContextStore = {
    id: "openviking",

    async find(query, findOpts): Promise<FindResult> {
      const body = {
        query,
        tier: findOpts.tier,
        limit: findOpts.limit,
        ...(findOpts.root ? { root: findOpts.root } : {}),
      };
      const parsed = await postJson("/find", body, findResponseSchema);
      const result: FindResult = {
        query,
        tier: findOpts.tier,
        resources: parsed.resources,
        ...(parsed.trajectory ? { trajectory: parsed.trajectory } : {}),
      };
      return result;
    },

    async load(uri: string, tier: Tier): Promise<string> {
      const parsed = await getJson(
        `/load?uri=${encodeURIComponent(uri)}&tier=${encodeURIComponent(tier)}`,
        loadResponseSchema,
      );
      return parsed.content;
    },

    async write(uri: string, content: string, writeOpts): Promise<void> {
      const kind: ResourceKind = writeOpts?.kind ?? "memory";
      await postJson("/resource", { uri, content, kind }, z.object({}).passthrough());
    },

    async tree(uri: string, treeOpts): Promise<TreeEntry[]> {
      const depth = treeOpts?.depth;
      const q =
        `/tree?uri=${encodeURIComponent(uri)}` + (depth !== undefined ? `&depth=${depth}` : "");
      const parsed = await getJson(q, treeResponseSchema);
      return parsed.entries;
    },

    async grep(pattern: string, grepOpts): Promise<Resource[]> {
      const root = grepOpts?.root;
      const q =
        `/grep?pattern=${encodeURIComponent(pattern)}` + (root ? `&root=${encodeURIComponent(root)}` : "");
      const parsed = await getJson(q, grepResponseSchema);
      return parsed.resources;
    },

    // Lifecycle — used by provision/doctor (unchanged from Phase 1, now sharing startDaemon).
    health,
    ping: async () => (await health()).up,
    start: startDaemon,
  };
  return store;
}
