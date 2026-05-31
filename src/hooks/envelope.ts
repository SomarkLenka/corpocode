// Zod schemas for each hook payload CorpoCode handles. Validating before any handler runs means a
// malformed envelope produces a clean, controlled exit rather than an exception inside a handler.
// `.passthrough()` keeps unknown fields so a newer host that adds payload fields never breaks us.
import { z } from "zod";

const baseEnvelope = z
  .object({
    session_id: z.string(),
    transcript_path: z.string(),
    cwd: z.string().optional(),
    hook_event_name: z.string().optional(),
  })
  .passthrough();

export const userPromptSubmitSchema = baseEnvelope.extend({
  prompt: z.string(),
});

export const preToolUseSchema = baseEnvelope.extend({
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).default({}),
});

export const postToolUseSchema = baseEnvelope.extend({
  tool_name: z.string(),
  tool_input: z.record(z.unknown()).default({}),
  tool_response: z.unknown().optional(),
});

export const stopSchema = baseEnvelope.extend({
  stop_hook_active: z.boolean().optional(),
});

export const subagentStartSchema = baseEnvelope.extend({
  subagent_type: z.string().optional(),
});

export const sessionStartSchema = baseEnvelope.extend({
  source: z.string().optional(), // e.g. "startup" | "resume" | "clear"
});

export const ENVELOPE_SCHEMAS = {
  UserPromptSubmit: userPromptSubmitSchema,
  PreToolUse: preToolUseSchema,
  PostToolUse: postToolUseSchema,
  Stop: stopSchema,
  SubagentStart: subagentStartSchema,
  SessionStart: sessionStartSchema,
} as const;

export type HookName = keyof typeof ENVELOPE_SCHEMAS;

export function isHookName(name: string): name is HookName {
  return Object.prototype.hasOwnProperty.call(ENVELOPE_SCHEMAS, name);
}

export { baseEnvelope };
export type BaseEnvelope = z.infer<typeof baseEnvelope>;
export type UserPromptSubmitEnvelope = z.infer<typeof userPromptSubmitSchema>;
export type PreToolUseEnvelope = z.infer<typeof preToolUseSchema>;
export type PostToolUseEnvelope = z.infer<typeof postToolUseSchema>;
export type StopEnvelope = z.infer<typeof stopSchema>;
export type SubagentStartEnvelope = z.infer<typeof subagentStartSchema>;
export type SessionStartEnvelope = z.infer<typeof sessionStartSchema>;
