// Deny / always-allow patterns for tool-call classification. In Phase 1 these inform an ADVISORY
// log line only — the filter never sets a permission decision. Phase 2 gives them teeth.
export interface FilterPolicies {
  deny: RegExp[]; // destructive commands that should be blocked (Phase 2)
  allow: RegExp[]; // read-only / common test runners that should never prompt
}

export const DEFAULT_POLICIES: FilterPolicies = {
  deny: [
    /rm\s+-[rf]*r[rf]*\s+[~/]/i, // rm -rf ~ , rm -rf / , rm -fr /etc, …
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    />\s*\/etc\//i, // writing into /etc
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // classic fork bomb
    /\bchmod\s+-R\s+777\s+\//i,
  ],
  allow: [
    /^\s*(ls|cat|pwd|echo|head|tail|wc|which|grep|rg|find)\b/i,
    /^\s*git\s+(status|diff|log|show|branch)\b/i,
    /\b(npm|pnpm|yarn)\s+(run\s+)?(test|lint|typecheck|build)\b/i,
    /\b(vitest|jest|pytest|go\s+test|cargo\s+test)\b/i,
  ],
};
