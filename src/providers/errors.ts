// Normalize any vendor SDK / transport error into a ProviderError with the correct kind and
// retryable flag, so downstream code never has to know which SDK threw. Shared by every adapter.
import { ProviderError, type ProviderKind } from "./types";

interface VendorErrorShape {
  name?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  message?: string;
  response?: { status?: number };
}

const NETWORK_CODES = ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN", "EPIPE"];

export function mapVendorError(err: unknown, providerId: ProviderKind): ProviderError {
  if (err instanceof ProviderError) return err;

  const e = (err ?? {}) as VendorErrorShape;
  const name = e.name ?? "";
  const code = e.code ?? "";
  const status = e.status ?? e.statusCode ?? e.response?.status;
  const message = e.message ?? String(err);

  if (name === "AbortError" || code === "ABORT_ERR") {
    return new ProviderError("timeout", providerId, message, true, err);
  }
  if (status === 401 || status === 403) {
    return new ProviderError("auth", providerId, message, false, err);
  }
  if (status === 429) {
    return new ProviderError("rate_limit", providerId, message, true, err);
  }
  if (status === 408) {
    return new ProviderError("timeout", providerId, message, true, err);
  }
  if (status === 404) {
    return new ProviderError("model_unavailable", providerId, message, false, err);
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderError("network", providerId, message, true, err);
  }
  if (code === "ETIMEDOUT") {
    return new ProviderError("timeout", providerId, message, true, err);
  }
  if (NETWORK_CODES.includes(code)) {
    return new ProviderError("network", providerId, message, true, err);
  }
  if (/api[_ -]?key|unauthor|authentication|invalid x-api-key/i.test(message)) {
    return new ProviderError("auth", providerId, message, false, err);
  }
  return new ProviderError("invalid_response", providerId, message, false, err);
}
