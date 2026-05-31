// A global concurrency limiter (Phase 4 §4). The retrieval fan-out and the verifier fan-out each cap
// their OWN parallelism, but nothing stops several fan-outs in one turn from summing into a swarm of
// simultaneous model calls that blows past rate limits and spikes cost. This is the process-global
// backstop: a single ceiling every provider-call site can acquire from, so total in-flight work is
// bounded no matter how many fan-outs are live. Local caps still apply; this only ever lowers concurrency.
export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
}

export function createLimiter(max: number): Limiter {
  const cap = Math.max(1, Math.floor(max));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < cap) {
        active++;
        resolve();
      } else {
        waiters.push(() => {
          active++;
          resolve();
        });
      }
    });

  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  return {
    get inFlight() {
      return active;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/** The process-global ceiling on concurrent provider calls across every fan-out in a single hook. */
export const GLOBAL_PROVIDER_CONCURRENCY = 12;
export const globalProviderLimiter = createLimiter(GLOBAL_PROVIDER_CONCURRENCY);
