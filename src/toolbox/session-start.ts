// SessionStart handler — re-run the deterministic gate so newly-added (or plugin-update-restored)
// skills/agents get gated automatically each session, off the prompt hot path. No LLM, no injection:
// it only maintains the gate + catalog, logs a summary, and always returns {}. Fully fail-open — a
// gate failure must never disrupt session start.
import type { HookContext } from "../hooks/context";
import type { HookResponse } from "../hooks/response";
import type { SessionStartEnvelope } from "../hooks/envelope";
import { claudeHome } from "../install/claude-paths";
import { catalogFile, toolboxRestoreDir } from "../config/paths";
import { defaultRoots, gateToolbox } from "./gate";

export async function handleSessionStart(envelope: SessionStartEnvelope, ctx: HookContext): Promise<HookResponse> {
  try {
    const tb = ctx.config.toolbox;
    if (tb.enabled && tb.gate_on_session_start) {
      const summary = gateToolbox({
        roots: defaultRoots({
          claudeHome: claudeHome(ctx.env),
          repoRoot: envelope.cwd ?? ctx.repoRoot,
          includePlugins: tb.gate_plugins,
        }),
        restoreDir: toolboxRestoreDir(ctx.env),
        catalogPath: catalogFile(ctx.env),
      });
      ctx.logger.log({
        event: "toolbox",
        session_id: envelope.session_id,
        component: "toolbox",
        trigger: "sessionstart",
        gated: summary.gated,
        skipped: summary.skipped,
      });
    }
  } catch {
    // gating is best-effort; never break session start
  }
  return {};
}
