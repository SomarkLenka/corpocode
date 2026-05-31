// The telemetry transport. Two guarantees live here. First, OFF MEANS OFF: when telemetry is disabled
// (the default for every install) this never touches the network — it returns before constructing any
// request. Second, it is fail-open like everything else: a failed send is swallowed and reported, never
// thrown, so a telemetry problem can never affect the turn the user is in. The send is deliberately not
// wired into any per-turn hook path; it is an explicit, batched, infrequent act, so a normal turn makes
// zero egress regardless of this module.
import type { CorpoConfig } from "../config/schema";
import type { TelemetryPayload } from "./whitelist";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

export interface SendResult {
  sent: boolean;
  reason?: "disabled" | "no-endpoint" | "transport-error";
}

export interface SendDeps {
  config: CorpoConfig;
  fetchFn?: FetchFn;
}

export async function sendTelemetry(payload: TelemetryPayload, deps: SendDeps): Promise<SendResult> {
  if (!deps.config.telemetry.enabled) return { sent: false, reason: "disabled" }; // off → zero egress
  const endpoint = deps.config.telemetry.endpoint;
  if (!endpoint) return { sent: false, reason: "no-endpoint" };
  try {
    const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { sent: true };
  } catch {
    return { sent: false, reason: "transport-error" }; // swallowed — a send failure never affects a turn
  }
}
