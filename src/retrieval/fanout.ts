// Run the checklist concurrently, capped at max_parallel_instances, each item bounded by its own
// timeout. This is the parallelism that makes the team's total latency approximate a single item's
// rather than the sum — a research team asking its questions at once, not in turn.
import { handleItem } from "./item-handler";
import { globalProviderLimiter, type Limiter } from "../perf/limiter";
import type { ChecklistItem, ItemResult, RetrievalBackends } from "./types";

export interface FanOutOptions {
  maxParallel: number;
  perItemTimeoutMs: number;
  now?: () => number;
  /** Process-global concurrency ceiling shared with other fan-outs; defaults to the global limiter. */
  limiter?: Limiter;
}

/** Map with a concurrency cap, preserving input order in the output. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  const poolSize = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

export function fanOut(items: ChecklistItem[], backends: RetrievalBackends, opts: FanOutOptions): Promise<ItemResult[]> {
  const limiter = opts.limiter ?? globalProviderLimiter;
  // Two layers: the local cap shapes this fan-out, the global limiter bounds it against every other
  // fan-out alive in the turn. The effective concurrency is the lower of the two.
  return mapWithLimit(items, opts.maxParallel, (item) =>
    limiter.run(() => handleItem(item, backends, opts.perItemTimeoutMs, opts.now ?? (() => Date.now()))),
  );
}
