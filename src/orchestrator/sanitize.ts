// One choke point for context entering worker briefs: secrets become stable hash-keyed
// placeholders (referencable without being readable); hidden/bidi Unicode — the "Rules File
// Backdoor" smuggling channel — is stripped. Pure; callers decide where to apply it.
import { createHash } from "node:crypto";

interface SecretRule {
  kind: string;
  re: RegExp;
}

// Order matters: the private-key block must run before generic patterns can nibble at it.
const SECRET_RULES: SecretRule[] = [
  { kind: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "openai-key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{25,}/g },
];

// Zero-width chars, bidi controls, word joiners, BOM — escaped, never literal, so the
// source file itself can't smuggle them.
const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export interface SanitizeResult {
  text: string;
  redactions: Array<{ kind: string; placeholder: string }>;
  strippedHiddenUnicode: number;
}

export function sanitizeIngress(raw: string): SanitizeResult {
  const redactions: Array<{ kind: string; placeholder: string }> = [];
  let text = raw;

  for (const rule of SECRET_RULES) {
    text = text.replace(rule.re, (hit) => {
      const digest = createHash("sha1").update(hit).digest("hex").slice(0, 8);
      const placeholder = `[REDACTED:${rule.kind}:${digest}]`;
      if (!redactions.some((r) => r.placeholder === placeholder)) {
        redactions.push({ kind: rule.kind, placeholder });
      }
      return placeholder;
    });
  }

  let strippedHiddenUnicode = 0;
  text = text.replace(HIDDEN_UNICODE, () => {
    strippedHiddenUnicode += 1;
    return "";
  });

  return { text, redactions, strippedHiddenUnicode };
}
