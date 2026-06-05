// The AgentBackend seam: the single, backend-agnostic contract the IntelligentRouter calls to run a
// low-cost agentic model call. Two backends implement it side by side — `anthropic-cli` (the `claude`
// CLI agent loop) and, later and in-repo, `agent-engine` (the opencode-backed runtime) — chosen purely
// by config. The seam is deliberately "dumb": it executes one call and maintains session persistence;
// ALL reasoning, routing, fan-out, aggregation, and judging live above it in src/intelligence/.
//
// It is the broadened successor to Provider.chat(): a one-shot no-tools completion is just
// invoke({ tools: "none", schema }). Everything else (tool loops, fs, MCP, persistent sessions, model
// fan-out + aggregation) is additive. Like every external boundary in CorpoCode, invoke() NEVER throws
// — it resolves to { ok: false, error } so a hook is never broken (the In-flight tenet).
import type { Pingable } from "../types/common";
import type { ComponentName } from "../config/schema";

/**
 * The kind of agentic task — drives default model, tool posture, and which backend handles it. The
 * array is the single source of truth: config/schema.ts builds its Zod validator from it (so a typo'd
 * task_backends key is a config error), and the type is derived from it here.
 *   triage             — RouterRouter's minimal dumb-vs-smart gate
 *   rank               — router stage-2 categorization
 *   file-relevance     — "read this file/span, decide if it matters, cite lines"
 *   pre-write-guidance — architectural guidance before a write
 *   review             — a tenet review of a proposed approach or written code
 *   housekeeping       — git / documentation upkeep
 *   general            — anything else
 */
export const AGENT_TASK_KINDS = [
  "triage",
  "rank",
  "file-relevance",
  "pre-write-guidance",
  "review",
  "housekeeping",
  "general",
] as const;
export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];

/** The two interchangeable backends behind the seam. Source of truth for the config validator + registry. */
export const AGENT_BACKEND_KEYS = ["anthropic-cli", "agent-engine"] as const;
export type AgentBackendKey = (typeof AGENT_BACKEND_KEYS)[number];

/** A minimal JSON Schema object; validated with Zod at the call site, kept structural here. */
export type JsonSchema = Record<string, unknown>;

/** Tool posture for the agent loop. Read-only by default — this is CorpoCode's private workspace, but a
 *  caretaker still opts in explicitly to MCP/skill/write capability per task. */
export type ToolPolicy =
  | "none" // a pure completion, no tool loop
  | "read-only" // read, glob, grep (default)
  | { read?: boolean; glob?: boolean; grep?: boolean; mcp?: string[]; write?: boolean; addDirs?: string[] };

/** Session lifecycle, decided dynamically by the caller (the router), not fixed by component type. */
export type SessionSpec =
  | "ephemeral" // default: spawn → run → dispose, no persisted state
  | { reuse?: string; persist?: boolean; key?: string }; // continue a prior session.id, and/or keep it alive

/** How the call is executed: one model, or a fan-out across models reconciled by an aggregator session. */
export type CallStrategy =
  | "single"
  | {
      mode: "aggregate";
      fanout: ModelRef[] | number; // run across several models, or N copies of one
      aggregator?: { model?: ModelRef; task?: string; schema?: JsonSchema };
    };

/** A resolved (provider, model) pair. providerKey indexes config.providers; model is the concrete id. */
export interface ModelRef {
  providerKey: string;
  model: string;
}

export interface AgentInputs {
  transcript?: string; // a transcript slice / line-of-thought
  files?: string[]; // candidate file paths the agent may read (NOT their contents)
  reasoning?: string; // prior reasoning to continue from
  decisions?: string; // prior decisions / constraints
}

export interface AgentCall<T = unknown> {
  component: ComponentName; // for model resolution + log attribution
  taskKind: AgentTaskKind;
  task: string; // the instruction (resolved prompt)
  inputs?: AgentInputs;
  model?: ModelRef; // explicit override; else resolved from component → provider config
  effort?: "minimal" | "medium" | "high";
  schema?: JsonSchema; // when set → structured output, validated + retried; data is typed T
  tools?: ToolPolicy; // default "read-only"
  session?: SessionSpec; // default "ephemeral"
  strategy?: CallStrategy; // default "single"
  timeoutMs?: number; // hard cap; default per backend/component config
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number; // computed locally from pricing.ts — never trusted from the vendor
  latencyMs: number;
  model: string;
}

export type AgentErrorKind = "auth" | "rate_limit" | "timeout" | "invalid_response" | "network" | "model_unavailable";

export interface NormalizedError {
  kind: AgentErrorKind;
  message: string;
  retryable: boolean;
}

/** One tool/file the agent touched — for observability and the caller's review. */
export interface ToolCall {
  name: string;
  input?: string;
}

/** A per-branch output when strategy = aggregate (each branch's data/text + which model produced it). */
export interface Contribution<T = unknown> {
  model: ModelRef;
  ok: boolean;
  data?: T;
  text?: string;
}

export interface AgentResult<T = unknown> {
  ok: boolean;
  data?: T; // validated structured output when schema given …
  text?: string; // … otherwise raw assistant text
  usage: AgentUsage;
  model: ModelRef; // what actually ran (after resolution)
  trace?: ToolCall[];
  session?: { id: string; persisted: boolean }; // continue with { reuse: id } next call, or release(id)
  contributions?: Contribution<T>[]; // per-branch outputs + aggregator verdict, when strategy = aggregate
  error?: NormalizedError; // set when ok=false; the backend still RESOLVES (degraded), never rejects
}

/** A low-cost agentic model runtime. invoke() never throws; release/health/shutdown manage lifecycle. */
export interface AgentBackend extends Pingable {
  readonly id: "anthropic-cli" | "agent-engine";
  invoke<T = unknown>(call: AgentCall<T>): Promise<AgentResult<T>>;
  release(sessionId: string): Promise<void>;
  health(): Promise<{ up: boolean; version?: string }>;
  shutdown(): Promise<void>;
}
