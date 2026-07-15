import { describe, expect, it } from "vitest";
import { sanitizeIngress } from "../../src/orchestrator/sanitize";

describe("sanitizeIngress", () => {
  it("redacts an Anthropic key with a stable placeholder", () => {
    const key = "sk-ant-abc123def456ghi789jkl0";
    const a = sanitizeIngress(`use ${key} here`);
    const b = sanitizeIngress(`and ${key} again`);
    expect(a.text).not.toContain(key);
    expect(a.redactions[0]!.kind).toBe("anthropic-key");
    const placeholder = a.redactions[0]!.placeholder;
    expect(placeholder).toMatch(/^\[REDACTED:anthropic-key:[0-9a-f]{8}\]$/);
    expect(b.text).toContain(placeholder); // same secret ⇒ same placeholder
  });

  it("redacts AWS keys, GitHub tokens, and private-key blocks", () => {
    const text = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_" + "a".repeat(36),
      "-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const r = sanitizeIngress(text);
    expect(r.redactions.map((x) => x.kind).sort()).toEqual(["aws-access-key", "github-token", "private-key-block"]);
    expect(r.text).not.toContain("AKIA");
  });

  it("strips hidden/bidi Unicode and counts it", () => {
    const r = sanitizeIngress("safe‮evil​ text"); // RLO override + zero-width space
    expect(r.strippedHiddenUnicode).toBe(2);
    expect(r.text).toBe("safeevil text");
  });

  it("passes clean text through byte-identical", () => {
    const r = sanitizeIngress("const x = 1; // fine");
    expect(r.text).toBe("const x = 1; // fine");
    expect(r.redactions).toEqual([]);
    expect(r.strippedHiddenUnicode).toBe(0);
  });
});
