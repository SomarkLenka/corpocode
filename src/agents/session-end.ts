// SessionEnd handler — the agent seam's cleanup. When a host (Claude Code) session ends, release the
// `claude` agent threads CorpoCode opened under it and drop their records, then run TTL + LRU eviction so
// the agent-sessions directory never grows without bound. Pure housekeeping: no model call, no injection.
//
// Ships dark with the rest of the seam: when agents are disabled (ctx.agents undefined) it is a no-op, so
// registering it changes nothing until the IntelligentRouter is switched on. Fail-open — a release/evict
// error is swallowed; cleanup is best-effort and must never break the end of a session.
import type { HookContext } from "../hooks/context";
import type { HookResponse } from "../hooks/response";
import type { SessionEndEnvelope } from "../hooks/envelope";
import { createSessionStore } from "./sessions";

export async function handleSessionEnd(envelope: SessionEndEnvelope, ctx: HookContext): Promise<HookResponse> {
  if (!ctx.agents) return {}; // agent seam disabled → nothing to clean up

  const store = createSessionStore({
    ttlMs: ctx.config.agents.session_ttl_ms,
    maxSessions: ctx.config.agents.max_sessions,
    cwd: ctx.repoRoot,
    env: ctx.env,
    logger: ctx.logger,
  });

  // Release just this host session's agent threads. The owning backend isn't recorded, so we release on
  // every registered backend — release() is fail-open, so a call to the wrong backend is a harmless no-op.
  const backends = ctx.agents.all();
  for (const rec of store.all().filter((r) => r.hostSessionId === envelope.session_id)) {
    await Promise.all(backends.map((b) => b.release(rec.claudeSessionId).catch(() => {})));
    store.remove(rec.key);
  }

  store.evict(); // TTL + LRU hygiene for every other host's still-live records
  return {};
}
