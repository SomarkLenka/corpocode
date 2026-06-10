// The heart of the plumbing, and the single most important safety property of the whole system:
// CorpoCode runs inside another agent's loop, so a crash or non-zero exit could break the host's
// turn. The entire flow is wrapped so that ANY unhandled error degrades to doing nothing — an
// empty response and a clean exit. A buggy CorpoCode must fail open, never disruptive.
import { loadConfig } from "../config/load";
import type { CorpoConfig } from "../config/schema";
import { nullLogger, type Logger } from "../log/ndjson";
import { flowLoggerFromConfig, type FlowLogger } from "../log/flow";
import {
  ENVELOPE_SCHEMAS,
  baseEnvelope,
  isHookName,
  notificationSchema,
  postToolUseSchema,
  preCompactSchema,
  preToolUseSchema,
  sessionEndSchema,
  sessionStartSchema,
  stopSchema,
  subagentStartSchema,
  subagentStopSchema,
  userPromptSubmitSchema,
  type BaseEnvelope,
} from "./envelope";
import { emptyResponse, type HookResponse } from "./response";
import { isPlatformId, serializeForPlatform, type PlatformId } from "./platform-output";
import { buildContext, type HookContext } from "./context";
import { buildHandlers, type Handler, type HandlerMap } from "./handlers";

export interface DispatchDeps {
  loadConfig?: () => CorpoConfig;
  handlers?: Partial<HandlerMap>;
  makeContext?: (config: CorpoConfig, base: BaseEnvelope) => HookContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  flow?: FlowLogger;
  hookTimeoutMs?: number;
  platform?: PlatformId; // which platform's stdout envelope to emit (default claude-code)
}

// Defense in depth: errors fail open, but a HANG would also break the host turn. An overall
// budget guarantees a hook returns even if a backend wedges. Individual calls have tighter
// timeouts; this is the backstop.
const DEFAULT_HOOK_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook handler exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Typed structurally as just `{ parse }` so a Zod schema whose input type differs from its output
// type (e.g. fields with `.default()`) still slots in cleanly and infers T from the parsed output.
async function runTyped<T>(
  hookEventName: string,
  schema: { parse: (data: unknown) => T },
  parsed: unknown,
  handler: Handler<T> | undefined,
  ctx: HookContext,
  serialize: (r: HookResponse) => string,
  flow: FlowLogger,
): Promise<string> {
  // Compute the response first (empty when there's no handler), then record the flow block BEFORE
  // returning, so EVERY hook surface — even handler-less ones — diffs the transcript exactly once.
  const response: HookResponse = handler ? await handler(schema.parse(parsed), ctx) : {};
  flow.record(hookEventName, parsed, response);
  if (!handler) return emptyResponse();
  // Stamp the hook name so hookSpecificOutput always carries the hookEventName Claude Code requires —
  // no handler can forget it. Handlers may override (the router already sets UserPromptSubmit).
  return serialize({ ...response, hookEventName: response.hookEventName ?? hookEventName });
}

/**
 * Validate stdin against the matching envelope, route to the handler, and serialize the response.
 * Never throws — every failure path returns an empty response so the host turn proceeds untouched.
 */
export async function dispatchHook(hookName: string, rawStdin: string, deps: DispatchDeps = {}): Promise<string> {
  const logger = deps.logger ?? nullLogger();
  try {
    if (!isHookName(hookName)) return emptyResponse();
    // Strip a leading BOM some shells/encoders prepend to piped stdin before parsing.
    const parsed: unknown = JSON.parse(rawStdin.replace(/^﻿/, ""));
    const base = baseEnvelope.parse(parsed);
    const config = (deps.loadConfig ?? (() => loadConfig({ env: deps.env })))();
    const handlers = deps.handlers ?? buildHandlers();
    const flow = deps.flow ?? flowLoggerFromConfig(config, { cwd: base.cwd, env: deps.env });

    // Which platform this hook runs under: explicit dep, else CORPOCODE_PLATFORM (set by the shim),
    // else Claude Code. An unknown value degrades to Claude Code rather than failing. Resolved before
    // the context so platform-aware handlers (e.g. auto-delegation) can read it.
    const envPlatform = (deps.env ?? process.env).CORPOCODE_PLATFORM;
    const platform: PlatformId =
      deps.platform ?? (envPlatform && isPlatformId(envPlatform) ? envPlatform : "claude-code");

    const makeContext =
      deps.makeContext ??
      ((c: CorpoConfig, b: BaseEnvelope) =>
        buildContext(c, { env: deps.env, repoRoot: b.cwd, logger: deps.logger, platform, sessionId: b.session_id }));
    const ctx = makeContext(config, base);

    const serialize = (r: HookResponse): string => serializeForPlatform(r, platform);

    const route = (): Promise<string> => {
      switch (hookName) {
        case "UserPromptSubmit":
          return runTyped(hookName, userPromptSubmitSchema, parsed, handlers.UserPromptSubmit, ctx, serialize, flow);
        case "PreToolUse":
          return runTyped(hookName, preToolUseSchema, parsed, handlers.PreToolUse, ctx, serialize, flow);
        case "PostToolUse":
          return runTyped(hookName, postToolUseSchema, parsed, handlers.PostToolUse, ctx, serialize, flow);
        case "Stop":
          return runTyped(hookName, stopSchema, parsed, handlers.Stop, ctx, serialize, flow);
        case "SubagentStart":
          return runTyped(hookName, subagentStartSchema, parsed, handlers.SubagentStart, ctx, serialize, flow);
        case "SubagentStop":
          return runTyped(hookName, subagentStopSchema, parsed, handlers.SubagentStop, ctx, serialize, flow);
        case "SessionStart":
          return runTyped(hookName, sessionStartSchema, parsed, handlers.SessionStart, ctx, serialize, flow);
        case "SessionEnd":
          return runTyped(hookName, sessionEndSchema, parsed, handlers.SessionEnd, ctx, serialize, flow);
        case "Notification":
          return runTyped(hookName, notificationSchema, parsed, handlers.Notification, ctx, serialize, flow);
        case "PreCompact":
          return runTyped(hookName, preCompactSchema, parsed, handlers.PreCompact, ctx, serialize, flow);
        default: {
          const unreachable: never = hookName;
          void unreachable;
          return Promise.resolve(emptyResponse());
        }
      }
    };

    return await withTimeout(route(), deps.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
  } catch (err) {
    // Record it, but never surface it to the host.
    try {
      logger.log({
        event: "hook_error",
        component: "dispatch",
        hook: hookName,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // even logging the failure must not throw
    }
    // Opt-in stderr diagnostics: stderr on a 0-exit hook is shown to the user by the host but does
    // not break the turn, so this is safe to surface only when explicitly debugging.
    if (deps.env?.CORPOCODE_DEBUG ?? process.env.CORPOCODE_DEBUG) {
      try {
        process.stderr.write(
          `[corpocode] ${hookName} failed open: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
      } catch {
        // nothing more we can do
      }
    }
    return emptyResponse();
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** CLI entry for `corpocode hook <name> [--platform <id>]`: read stdin, dispatch, write stdout. */
export async function runHook(hookName: string, platform?: string): Promise<void> {
  let out = emptyResponse();
  try {
    const deps: DispatchDeps = platform && isPlatformId(platform) ? { platform } : {};
    out = await dispatchHook(hookName, await readStdin(), deps);
  } catch {
    out = emptyResponse();
  }
  try {
    process.stdout.write(out);
  } catch {
    // nothing more we can safely do
  }
}

// Keep the schema map exported-adjacent so callers can introspect supported hooks.
export { ENVELOPE_SCHEMAS };
