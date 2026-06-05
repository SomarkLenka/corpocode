// anthropic-cli AgentBackend: each invoke is one `claude` agent loop. Read-only by default and ALWAYS
// spawned with `--bare` (no hooks/plugins) so a caretaker's agent can never re-trigger CorpoCode's own
// hooks — the mandatory recursion guard. Sessions are server-side in `claude`; CorpoCode persists only
// the returned session uuid (via the session store) so a later fresh hook process resumes with
// `--resume`. invoke() never throws: every failure resolves to { ok:false, error } (the In-flight tenet).
import { randomUUID } from "node:crypto";
import type {
  AgentBackend,
  AgentCall,
  AgentResult,
  AgentErrorKind,
  ModelRef,
  ToolPolicy,
} from "../backend";
import { spawnText, type SpawnText } from "../spawn";

export const DEFAULT_AGENT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TURNS = 6;
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export interface AnthropicCliAgentOptions {
  defaultModel?: ModelRef;
  repoRoot?: string;
  spawn?: SpawnText; // injected in tests so no real `claude` runs
  now?: () => number;
}

/** Translate a ToolPolicy into the `--allowedTools` list. Read-only by default; write stays off unless
 *  a task explicitly opts in. "none" yields an empty list (a pure completion with no tool loop). */
export function allowedTools(policy: ToolPolicy | undefined): string[] {
  if (policy === "none") return [];
  if (policy === undefined || policy === "read-only") return [...READ_ONLY_TOOLS];
  const tools: string[] = [];
  if (policy.read !== false) tools.push("Read");
  if (policy.glob !== false) tools.push("Glob");
  if (policy.grep !== false) tools.push("Grep");
  if (policy.write) tools.push("Write", "Edit");
  for (const m of policy.mcp ?? []) tools.push(m);
  return tools;
}

/** Build the `claude` argv for a call. Exported so the conformance suite can assert flag construction
 *  (ephemeral vs --session-id vs --resume, --bare present, read-only allow-list) without spawning. */
export function buildArgs(call: AgentCall, model: string, repoRoot: string | undefined): { args: string[]; newSessionId?: string } {
  const args = ["--print", "--output-format", "json", "--model", model, "--bare"];
  const tools = allowedTools(call.tools);
  if (tools.length) args.push("--allowedTools", tools.join(","));
  args.push("--max-turns", String(DEFAULT_MAX_TURNS));
  if (repoRoot) args.push("--add-dir", repoRoot);

  let newSessionId: string | undefined;
  const session = call.session ?? "ephemeral";
  if (session !== "ephemeral") {
    if (session.reuse) {
      args.push("--resume", session.reuse);
    } else if (session.persist) {
      newSessionId = randomUUID();
      args.push("--session-id", newSessionId);
    }
  }
  // The task is the system prompt; on a resumed session it is already bound, so only set it when fresh.
  if (!(typeof session === "object" && session.reuse)) {
    args.push("--append-system-prompt", call.task);
  }
  return { args, newSessionId };
}

/** Flatten inputs into the stdin payload the agent reasons over (file CONTENTS are not stuffed in —
 *  the agent reads them via its tools). */
function buildStdin(call: AgentCall): string {
  const parts: string[] = [];
  if (call.inputs?.transcript) parts.push(`TRANSCRIPT:\n${call.inputs.transcript}`);
  if (call.inputs?.reasoning) parts.push(`PRIOR REASONING:\n${call.inputs.reasoning}`);
  if (call.inputs?.decisions) parts.push(`PRIOR DECISIONS:\n${call.inputs.decisions}`);
  if (call.inputs?.files?.length) parts.push(`CANDIDATE FILES (read what you need):\n${call.inputs.files.join("\n")}`);
  return parts.join("\n\n") || "(no additional input)";
}

interface ClaudeJson {
  result?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Best-effort extraction of a JSON value from agent text (strips ``` fences). */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(body);
}

function mapSpawnError(err: unknown): { kind: AgentErrorKind; message: string; retryable: boolean } {
  const code = (err as { code?: string })?.code;
  if (code === "ENOENT") return { kind: "model_unavailable", message: "`claude` CLI not found on PATH", retryable: false };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "network", message, retryable: true };
}

export function createAnthropicCliAgent(opts: AnthropicCliAgentOptions = {}): AgentBackend {
  const run = opts.spawn ?? spawnText;
  const now = opts.now ?? (() => Date.now());

  async function invoke<T>(call: AgentCall<T>): Promise<AgentResult<T>> {
    const model: ModelRef = call.model ?? opts.defaultModel ?? { providerKey: "default", model: DEFAULT_AGENT_MODEL };
    const started = now();
    const zero = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, model: model.model };
    const { args, newSessionId } = buildArgs(call as AgentCall, model.model, opts.repoRoot);
    const stdin = buildStdin(call as AgentCall);
    const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { stdout } = await run("claude", args, stdin, controller.signal);
      clearTimeout(timer);
      const obj = JSON.parse(stdout) as ClaudeJson;
      const text = obj.result ?? "";
      const usage = {
        inputTokens: obj.usage?.input_tokens ?? 0,
        outputTokens: obj.usage?.output_tokens ?? 0,
        costUsd: obj.total_cost_usd ?? 0,
        latencyMs: now() - started,
        model: obj.model ?? model.model,
      };
      const sessionId = newSessionId ?? obj.session_id;
      const session = sessionId ? { id: sessionId, persisted: Boolean(newSessionId) } : undefined;

      if (obj.is_error) {
        return { ok: false, text, usage, model, session, error: { kind: "invalid_response", message: text || "claude reported is_error", retryable: false } };
      }
      if (call.schema) {
        try {
          return { ok: true, data: extractJson(text) as T, usage, model, session };
        } catch {
          return { ok: false, text, usage, model, session, error: { kind: "invalid_response", message: "agent did not return parseable JSON", retryable: true } };
        }
      }
      return { ok: true, text, usage, model, session };
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const error = aborted ? { kind: "timeout" as const, message: `agent exceeded ${timeoutMs}ms`, retryable: true } : mapSpawnError(err);
      return { ok: false, usage: { ...zero, latencyMs: now() - started }, model, error };
    }
  }

  return {
    id: "anthropic-cli",
    invoke,
    // The CLI has no explicit session-delete; releasing simply means CorpoCode stops resuming it (the
    // session store drops the record). Server-side retention is claude's own concern.
    release: async () => {},
    health: async () => {
      try {
        await run("claude", ["--version"], "", AbortSignal.timeout(5_000));
        return { up: true };
      } catch {
        return { up: false };
      }
    },
    ping: async () => {
      try {
        await run("claude", ["--version"], "", AbortSignal.timeout(5_000));
        return true;
      } catch {
        return false;
      }
    },
    shutdown: async () => {},
  };
}
