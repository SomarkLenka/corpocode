// Classify a tool call as deny / allow / ask. The deterministic policy lists decide the confident
// cases for free; only the leftover "ask" cases consult the optional LLM soft-classifier, which may
// upgrade an uncertain command to allow or deny — and on any failure falls back to "ask" so the
// human decides. A false denial is its own harm, so the deny-list is narrow and the default is ask.
import { z } from "zod";
import type { Provider } from "../providers/types";
import type { Effort } from "../config/schema";
import { applyEffort } from "../providers/effort";
import { DEFAULT_POLICIES, type FilterPolicies } from "./policies";

export type FilterDecision = "deny" | "allow" | "ask";

export interface FilterClassification {
  decision: FilterDecision;
  reason: string;
  matched?: string;
}

/** Extract a shell command string from a tool input, or null for non-command tools. */
export function extractCommand(toolName: string, toolInput: Record<string, unknown>): string | null {
  // PowerShell/pwsh are shell command tools too — on Windows they carry the command the same way, so
  // they get the same deny/allow/ask treatment as Bash rather than slipping through ungated.
  if (toolName === "Bash" || toolName === "Shell" || toolName === "PowerShell" || toolName === "pwsh") {
    return typeof toolInput.command === "string" ? toolInput.command : null;
  }
  return null;
}

/** Deterministic, keyless classification from the policy lists. The confident, free first pass. */
export function classifyToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  policies: FilterPolicies = DEFAULT_POLICIES,
): FilterClassification {
  const command = extractCommand(toolName, toolInput);
  if (command !== null) {
    for (const re of policies.deny) {
      if (re.test(command)) return { decision: "deny", reason: "matches a deny-list pattern", matched: re.source };
    }
    for (const re of policies.allow) {
      if (re.test(command)) return { decision: "allow", reason: "matches an always-allow pattern", matched: re.source };
    }
    return { decision: "ask", reason: "no policy match — defer to the soft classifier / user" };
  }
  return { decision: "allow", reason: `${toolName} is not a command tool` };
}

const softSchema = z.object({
  decision: z.enum(["deny", "allow", "ask"]).default("ask"),
  reason: z.string().default(""),
});

const SOFT_PROMPT =
  "You are a safety classifier for shell commands run inside a coding session. Decide: deny " +
  "(clearly destructive or dangerous — wipes data, exfiltrates secrets, modifies the system), " +
  "allow (clearly safe — read-only inspection, a test/build/lint run), or ask (uncertain — let " +
  "the human decide). Default to ask when unsure. Respond with ONLY JSON {\"decision\":...,\"reason\":...}.";

/** The optional LLM pass for the soft "ask" cases. Best-effort: any failure stays at "ask". */
export async function softClassify(
  command: string,
  provider: Provider,
  effort?: Effort,
): Promise<FilterClassification> {
  try {
    const out = await provider.chat(
      applyEffort(
        {
          system: SOFT_PROMPT,
          responseFormat: "json",
          maxTokens: 150,
          timeoutMs: 6000,
          messages: [{ role: "user", content: command }],
        },
        effort,
      ),
    );
    const parsed = softSchema.safeParse(JSON.parse(out.text));
    if (!parsed.success) return { decision: "ask", reason: "soft classifier returned invalid output" };
    return { decision: parsed.data.decision, reason: parsed.data.reason || "LLM soft classification" };
  } catch {
    return { decision: "ask", reason: "soft classifier unavailable — defer to user" };
  }
}
