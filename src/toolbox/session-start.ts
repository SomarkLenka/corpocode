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
import { pruneOldSessions } from "../session/prune";

export async function handleSessionStart(envelope: SessionStartEnvelope, ctx: HookContext): Promise<HookResponse> {
  const cwd = envelope.cwd ?? ctx.repoRoot;

  // Session housekeeping: GC the per-session state folders (reader cache, decision cache, flow cursor)
  // left behind by sessions idle past the TTL, so `.corpocode/sessions/` doesn't grow without bound.
  // Independent of gating and best-effort — its own try so a prune hiccup can't cost the gate, or vice versa.
  try {
    const pruned = pruneOldSessions({ cwd, env: ctx.env });
    if (pruned > 0) {
      ctx.logger.log({ event: "session_prune", session_id: envelope.session_id, component: "session", trigger: "sessionstart", pruned });
    }
  } catch {
    // pruning is best-effort; never break session start
  }

  try {
    const tb = ctx.config.toolbox;
    if (tb.enabled && tb.gate_on_session_start) {
      const summary = gateToolbox({
        roots: defaultRoots({
          claudeHome: claudeHome(ctx.env),
          repoRoot: cwd,
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
