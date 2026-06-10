// Anthropic-via-CLI adapter: shells out to the user's installed `claude` binary instead of using
// an API key, serving people who already pay for a Claude subscription. No auth to configure;
// `claude --print --output-format json` returns a parseable result object.
import { spawn } from "node:child_process";
import type { Provider } from "./types";
import { ProviderError } from "./types";
import { jsonSystemPrompt, makeProvider, type AdapterOptions } from "./base";
import type { RawChat, RawResult } from "./runner";
import { mapVendorError } from "./errors";

const PROVIDER_ID = "anthropic-cli" as const;
export const DEFAULT_ANTHROPIC_CLI_MODEL = "claude-haiku-4-5";

/** Flatten the chat input into a single prompt string for `claude --print`. */
export function buildCliPrompt(system: string, messages: { role: string; content: string }[]): string {
  const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return system ? `${system}\n\n${convo}` : convo;
}

/** Parse `claude --output-format json` stdout into a RawResult. Exported for direct unit testing. */
export function parseClaudeCliResponse(stdout: string, fallbackModel: string): RawResult {
  const obj = JSON.parse(stdout) as {
    result?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
    is_error?: boolean;
  };
  return {
    text: obj.result ?? "",
    inputTokens: obj.usage?.input_tokens ?? 0,
    outputTokens: obj.usage?.output_tokens ?? 0,
    finishReason: obj.is_error ? "error" : "stop",
    model: obj.model ?? fallbackModel,
  };
}

/**
 * The argv for a one-shot `claude --print` call. `--bare` (skip hooks/LSP/plugins) is the MANDATORY
 * recursion guard: this provider is invoked from inside a `claude` hook on every caretaker call, so a
 * spawned `claude` that re-fired CorpoCode's hooks would recurse and hang the host turn. The agent
 * backend applies the same guard (src/agents/backends/anthropic-cli.ts). Exported for regression testing.
 */
export function buildCliArgs(model: string): string[] {
  return ["--print", "--bare", "--output-format", "json", "--model", model];
}

interface SpawnResult {
  stdout: string;
}

/** Spawn a process, feed it stdin, collect stdout. Rejects on non-zero exit or spawn failure. */
function spawnText(cmd: string, args: string[], stdin: string, signal: AbortSignal): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err); // e.g. ENOENT when the claude binary is absent
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve({ stdout });
      } else {
        reject(Object.assign(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`), { code }));
      }
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function defaultRawChat(opts: AdapterOptions): RawChat {
  return async (input, signal) => {
    const prompt = buildCliPrompt(jsonSystemPrompt(input), input.messages);
    const args = buildCliArgs(opts.model);
    try {
      const { stdout } = await spawnText("claude", args, prompt, signal);
      return parseClaudeCliResponse(stdout, opts.model);
    } catch (err) {
      // A missing CLI surfaces as ENOENT → model_unavailable, which doctor reports clearly.
      if ((err as { code?: string })?.code === "ENOENT") {
        throw new ProviderError("model_unavailable", PROVIDER_ID, "`claude` CLI not found on PATH", false, err);
      }
      throw mapVendorError(err, PROVIDER_ID);
    }
  };
}

export function createAnthropicCliProvider(opts: AdapterOptions): Provider {
  const model = opts.model || DEFAULT_ANTHROPIC_CLI_MODEL;
  return makeProvider({
    id: PROVIDER_ID,
    model,
    modelTier: "fast",
    rawChat: opts.rawChat ?? defaultRawChat({ ...opts, model }),
    rawPing: opts.rawPing,
    retry: opts.retry,
    now: opts.now,
    sleep: opts.sleep,
    random: opts.random,
  });
}
