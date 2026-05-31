// Auto-delegation: act on the categorizer's `delegate_to`. A hook can't itself spawn a subagent —
// the main model owns that — so "auto" means CorpoCode escalates from a soft suggestion to a direct
// instruction, and only where it can land: when delegation is enabled, the configured mode is "auto",
// AND the host platform actually exposes a subagent mechanism. Everywhere else it degrades to a
// suggestion. The decision is one pure function so it is trivially testable across the matrix.
import type { CorpoConfig } from "../config/schema";
import type { PlatformId } from "../hooks/platform-output";
import { platformSupportsSubagents } from "../hooks/platform-output";

export interface DelegationDirective {
  delegateTo: string;
  mode: "suggest" | "auto";
  text: string;
}

export function planDelegation(
  delegateTo: string | undefined,
  config: CorpoConfig,
  platform: PlatformId,
): DelegationDirective | null {
  if (!delegateTo || !config.delegation.enabled) return null;
  const auto = config.delegation.mode === "auto" && platformSupportsSubagents(platform);
  return auto
    ? {
        delegateTo,
        mode: "auto",
        text:
          `This moment fits the \`${delegateTo}\` subagent. Delegate it: spawn \`${delegateTo}\` with the ` +
          "task above and let it do the work, rather than handling it inline.",
      }
    : {
        delegateTo,
        mode: "suggest",
        text: `Consider delegating this to the \`${delegateTo}\` subagent.`,
      };
}
