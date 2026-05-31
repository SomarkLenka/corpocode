import { describe, it, expect } from "vitest";
import { mapVendorError } from "../../src/providers/errors";
import { ProviderError, type ProviderErrorKind } from "../../src/providers/types";

const cases: Array<[Record<string, unknown>, ProviderErrorKind, boolean]> = [
  [{ status: 401 }, "auth", false],
  [{ status: 403 }, "auth", false],
  [{ status: 429 }, "rate_limit", true],
  [{ status: 408 }, "timeout", true],
  [{ status: 404 }, "model_unavailable", false],
  [{ status: 500 }, "network", true],
  [{ status: 503 }, "network", true],
  [{ name: "AbortError" }, "timeout", true],
  [{ code: "ECONNREFUSED" }, "network", true],
  [{ code: "ETIMEDOUT" }, "timeout", true],
  [{ message: "invalid x-api-key provided" }, "auth", false],
  [{ message: "something unexpected" }, "invalid_response", false],
];

describe("mapVendorError", () => {
  it.each(cases)("maps %o → kind %s (retryable=%s)", (err, kind, retryable) => {
    const pe = mapVendorError(err, "anthropic");
    expect(pe).toBeInstanceOf(ProviderError);
    expect(pe.kind).toBe(kind);
    expect(pe.retryable).toBe(retryable);
    expect(pe.providerId).toBe("anthropic");
  });

  it("passes an existing ProviderError through unchanged", () => {
    const orig = new ProviderError("rate_limit", "openai", "x", true);
    expect(mapVendorError(orig, "openai")).toBe(orig);
  });

  it("reads a nested response.status", () => {
    expect(mapVendorError({ response: { status: 429 } }, "google").kind).toBe("rate_limit");
  });
});
