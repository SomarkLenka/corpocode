// Shared primitives used across every Provider and backend adapter. Kept dependency-free
// so the lowest layer never imports upward.

/** Milliseconds since epoch or a duration, disambiguated at the call site. */
export type Millis = number;

/** Every backend exposes a cheap liveness probe used by `corpocode doctor` and hot-path guards. */
export interface Pingable {
  ping(): Promise<boolean>;
}

/** Normalized retry policy honored by every Provider and backend adapter. */
export interface RetryPolicy {
  maxAttempts: number; // total attempts including the first
  baseDelayMs: Millis; // first backoff delay
  maxDelayMs: Millis; // ceiling for exponential backoff
  jitter: boolean; // randomize delay to avoid retry storms
  retryableKinds: string[]; // error `kind`s considered retryable
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
  retryableKinds: ["rate_limit", "timeout", "network", "daemon_restart"],
};
