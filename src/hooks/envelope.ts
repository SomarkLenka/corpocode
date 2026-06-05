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
  last_assistant_message: z.string().optional(),
});

export const subagentStartSchema = baseEnvelope.extend({
  subagent_type: z.string().optional(),
  agent_type: z.string().optional(),
});

export const subagentStopSchema = baseEnvelope.extend({
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});

export const sessionStartSchema = baseEnvelope.extend({
  source: z.string().optional(), // e.g. "startup" | "resume" | "clear" | "compact"
  model: z.string().optional(),
});

export const sessionEndSchema = baseEnvelope.extend({
  reason: z.string().optional(), // e.g. "clear" | "resume" | "logout" | "other"
});

export const notificationSchema = baseEnvelope.extend({
  message: z.string().optional(),
  title: z.string().optional(),
  notification_type: z.string().optional(), // e.g. "permission_prompt" | "idle_prompt"
});

export const preCompactSchema = baseEnvelope.extend({
  trigger: z.string().optional(), // "manual" | "auto"
  custom_instructions: z.string().optional(),
});

export const ENVELOPE_SCHEMAS = {
  UserPromptSubmit: userPromptSubmitSchema,
  PreToolUse: preToolUseSchema,
  PostToolUse: postToolUseSchema,
  Stop: stopSchema,
  SubagentStart: subagentStartSchema,
  SubagentStop: subagentStopSchema,
  SessionStart: sessionStartSchema,
  SessionEnd: sessionEndSchema,
  Notification: notificationSchema,
  PreCompact: preCompactSchema,
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
export type SubagentStopEnvelope = z.infer<typeof subagentStopSchema>;
export type SessionStartEnvelope = z.infer<typeof sessionStartSchema>;
export type SessionEndEnvelope = z.infer<typeof sessionEndSchema>;
export type NotificationEnvelope = z.infer<typeof notificationSchema>;
export type PreCompactEnvelope = z.infer<typeof preCompactSchema>;
