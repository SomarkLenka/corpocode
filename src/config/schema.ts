// The authoritative shape of ~/.corpocode/config.json, enforced by Zod. This is the single
// place a malformed config is caught with a clear error before any component runs.
//
// Every block carries `.default(...)` so `configSchema.parse({})` yields a complete, valid
// config — which is exactly what a fresh `corpocode install` writes and what `load.ts` uses
// to fill defaults for a partial file. The schema deliberately covers blocks Phase 1 does not
// yet exercise (compaction, retrieval, git, …) so later phases never have to migrate the file
// format. Unknown keys are stripped (Zod's default), not rejected, so a newer config read by
// an older binary degrades gracefully rather than failing (the In-flight tenet).
import { z } from "zod";
import { AGENT_TASK_KINDS, AGENT_BACKEND_KEYS } from "../agents/backend";

/** Zod validators for the agent seam's task kinds + backend keys, built from their single source of
 *  truth in agents/backend.ts so the config and the code can never drift. */
export const agentTaskKindSchema = z.enum(AGENT_TASK_KINDS);
export const agentBackendKeySchema = z.enum(AGENT_BACKEND_KEYS);

/** The canonical list of provider kinds — the single source of truth re-exported by providers/types.ts. */
export const providerKindSchema = z.enum([
  "anthropic",
  "anthropic-cli",
  "google",
  "openai",
  "openrouter",
  "ollama",
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** Components that resolve a provider from the registry. */
export const componentNameSchema = z.enum([
  "router",
  "retrieval",
  "compactor",
  "filter",
  "verifier",
  "toolbox",
]);
export type ComponentName = z.infer<typeof componentNameSchema>;

export const effortSchema = z.enum(["minimal", "medium", "high"]);
export type Effort = z.infer<typeof effortSchema>;

export const difficultySchema = z.enum(["trivial", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export const tenetSchema = z.enum(["M", "O", "L", "A", "R", "E", "D", "I", "T"]);
export type Tenet = z.infer<typeof tenetSchema>;

/** One named provider configuration. Secrets are referenced by name, never inlined. */
export const providerConfigSchema = z.object({
  kind: providerKindSchema,
  model: z.string().min(1),
  host: z.string().optional(), // ollama loopback / custom host
  baseUrl: z.string().optional(), // openrouter / OpenAI-compatible base URL override
  apiKeyRef: z.string().optional(), // name of a key in ~/.corpocode/secrets
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

const componentsSchema = z
  .object({
    router: z.string().default("default"),
    retrieval: z.string().default("default"),
    compactor: z.string().default("default"),
    filter: z.string().default("default"),
    verifier: z.string().default("default"),
    toolbox: z.string().default("default"),
  })
  .default({});

const effortChoiceSchema = z.object({
  component: z.string().optional(),
  model: z.string().optional(),
  effort: effortSchema,
});

export const configSchema = z
  .object({
    // Config schema generation. A config that predates this field defaults to 1; because each block
    // carries `.default(...)` and Zod strips unknown keys, an old config that never set the newer
    // blocks (or carries a now-removed legacy key) still loads cleanly — an upgrade never breaks a
    // user who has not touched their config (Phase 4 §1).
    version: z.number().int().positive().default(1),
    // Default to the keyless `anthropic-cli` provider: it shells out to the user's installed `claude`
    // CLI (their existing login/subscription), so CorpoCode's cheap-model calls work with NO API key to
    // configure. `cheap_local` is a ready-to-use local alternative — repoint any component at it to run
    // that component's calls on ollama instead.
    providers: z
      .record(providerConfigSchema)
      .default({
        default: { kind: "anthropic-cli", model: "claude-haiku-4-5" },
        cheap_local: { kind: "ollama", model: "qwen2.5-coder:7b", host: "http://localhost:11434" },
      }),
    components: componentsSchema,
    compaction: z
      .object({ backend: z.enum(["openviking", "memdir"]).default("openviking") })
      .default({}),
    sliding_window: z
      .object({
        preserved_turns: z.number().int().nonnegative().default(6),
        preserved_tool_outputs: z.number().int().nonnegative().default(4),
      })
      .default({}),
    router: z
      .object({
        heuristic_candidate_limit_files: z.number().int().positive().default(10),
        trivial_early_exit: z.boolean().default(true),
      })
      .default({}),
    retrieval: z
      .object({
        max_checklist_items: z.number().int().positive().default(6),
        per_item_timeout_ms: z.number().int().positive().default(15000),
        max_parallel_instances: z.number().int().positive().default(6),
        package_token_budget: z.number().int().positive().default(1500),
        coherence_pass: z.boolean().default(false),
      })
      .default({}),
    molar_edit: z
      .object({
        active_tenets: z.array(tenetSchema).default(["M", "O", "L", "A", "R", "E", "D", "I", "T"]),
        strictness: z.record(z.string()).default({ A: "strict", R: "off_for_non_ui" }),
        verify_on_edit: z.boolean().default(true),
        review_on_breakpoint: z.boolean().default(true),
      })
      .default({}),
    effort: z
      .object({
        difficulty_to_model: z.record(effortChoiceSchema).default({
          trivial: { component: "router", effort: "minimal" },
          medium: { component: "router", effort: "medium" },
          hard: { model: "claude-opus-4", effort: "high" },
        }),
      })
      .default({}),
    git: z
      .object({
        enabled: z.boolean().default(true),
        mode: z.enum(["suggest", "auto"]).default("suggest"),
        branch_management: z.boolean().default(true),
        trace_branch: z.string().default("corpocode/trace"),
        clean_branch: z.string().default("corpocode/clean"),
        commit_per_write: z.boolean().default(true),
        promote_on: z
          .array(z.enum(["verifier_clean", "unit_boundary", "tests_passed"]))
          .default(["verifier_clean", "unit_boundary"]),
      })
      .default({}),
    delegation: z
      .object({
        // Act on the categorizer's `delegate_to`. suggest (default) only recommends; auto upgrades to
        // a directive, but only on a platform whose subagent mechanism the model can be pointed at.
        enabled: z.boolean().default(true),
        mode: z.enum(["suggest", "auto"]).default("suggest"),
      })
      .default({}),
    // Gate the user's skills/agents (strip their "when to use" from the main model's context) and hand
    // them back by name when a cheap classifier judges them relevant. gate_* control the deterministic
    // rewrite; route_on_heavy_coding controls the PreToolUse subagent recommendation.
    toolbox: z
      .object({
        enabled: z.boolean().default(true),
        max_skills: z.number().int().nonnegative().default(4),
        max_agents: z.number().int().nonnegative().default(2),
        gate_on_session_start: z.boolean().default(true),
        gate_plugins: z.boolean().default(true),
        route_on_heavy_coding: z.boolean().default(true),
      })
      .default({}),
    backends: z
      .object({
        // Native by default since Phase 5 — no Python toolchain, no daemon. The graphify and OpenViking
        // adapters remain fully selectable for anyone who deliberately wants them.
        knowledgeGraph: z.enum(["graphify", "native"]).default("native"),
        contextStore: z.enum(["openviking", "native"]).default("native"),
        memoryStore: z.literal("native").default("native"),
      })
      .default({}),
    // The IntelligentRouter's agent seam. OFF by default — the orchestration layer ships dark and is
    // proven in isolation before any handler consumes it (Phase 4). `task_backends` maps a task kind to
    // a backend; unmapped kinds use `default_backend`. Keys/values are validated against the seam's
    // single source of truth, so a typo is a config error, not a confusing runtime fallback.
    agents: z
      .object({
        enabled: z.boolean().default(false),
        default_backend: agentBackendKeySchema.default("anthropic-cli"),
        task_backends: z.record(agentTaskKindSchema, agentBackendKeySchema).default({}),
        max_parallel: z.number().int().positive().default(3), // each agent is a full process
        session_ttl_ms: z.number().int().positive().default(1_800_000), // 30 min before a session is evictable
        max_sessions: z.number().int().positive().default(50), // LRU bound on persisted agent sessions
        router_router: z.boolean().default(true), // the triage gate; false routes everything to the full router
        // bug-hunt action-pattern (IntelligentRouter Phase 1). Only consulted when `enabled` above is on.
        // See docs/superpowers/specs/2026-07-02-bug-hunt-action-pattern-design.md.
        bug_hunt: z
          .object({
            enabled: z.boolean().default(true), // per-pattern off switch (within agents.enabled)
            max_files: z.number().int().positive().default(3), // fan-out cap = top candidate files investigated
            per_agent_ms: z.number().int().positive().default(10_000), // per-agent timeout (the primary bound)
            deadline_ms: z.number().int().positive().default(30_000), // overall race backstop
            confidence_floor: z.number().min(0).max(1).default(0.5), // judge drops survivors below this
            max_injected_tokens: z.number().int().positive().default(800), // synthesis truncation budget
          })
          .default({}),
      })
      .default({}),
    // Off by default — the foundation of the privacy posture. When enabled, only the whitelisted
    // aggregate fields in src/telemetry/whitelist.ts are ever transmitted, to `endpoint`, batched.
    telemetry: z
      .object({
        enabled: z.boolean().default(false),
        endpoint: z.string().url().optional(),
      })
      .default({}),
    // Not in the original prose config example but required by §3/§12 ("disabling logging
    // makes calls no-ops"). Kept as its own block so the knob is discoverable.
    //  - `transcript_flow` writes a second, human-readable log (corpocode-flow.log) that interleaves
    //    the transcript delta with each hook's output, so the hook flow can be read top-to-bottom.
    //    Gated by `enabled` too: disabling logging disables both. On by default — it's a local debug
    //    aid and carries no data off the machine.
    logging: z
      .object({
        enabled: z.boolean().default(true),
        transcript_flow: z.boolean().default(true),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    // Cross-field check: every component must point at a provider that actually exists, so a
    // typo'd provider key is a clear config error rather than a confusing runtime failure.
    for (const [component, key] of Object.entries(cfg.components)) {
      if (!(key in cfg.providers)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", component],
          message: `component "${component}" references unknown provider "${key}"`,
        });
      }
    }
  });

export type CorpoConfig = z.infer<typeof configSchema>;
