// Incremental session reader. Reads the transcript at transcript_path and distills a ThoughtState
// with ONE cheap-model pass over only the NEW slice since the last read — so per-hook cost and
// latency stay flat no matter how long the session runs. The distilled state + byte offset are
// persisted per session, so this incrementality holds across separate `corpocode hook` processes.
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ensureDir, sessionStateFile, sessionsDir } from "../config/paths";
import type { Provider } from "../providers/types";
import type { TranscriptMessage } from "../compactor/types";
import type { RetrievalCues, SessionReader, ThoughtState } from "./types";
import { resolvePrompt, type PromptResolver } from "../prompts/resolve";

const MAX_ACCUMULATED = 20; // cap carried-forward entities/decisions so state can't grow unbounded

// Runtime shape for validating the model's JSON (the TS interface lives in types.ts; this is the
// parse boundary). A malformed distillation falls back to the prior state rather than breaking.
const thoughtStateSchema = z.object({
  intent: z.string().default(""),
  approach: z.string().optional(),
  openQuestions: z.array(z.string()).default([]),
  recentDecisions: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
});

export interface SessionReaderOptions {
  provider: Provider;
  cwd?: string; // project root; the per-session cache lives under <cwd>/.corpocode/sessions
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  prompts?: PromptResolver; // editable "session-reader" prompt; falls back to the built-in default
}

interface CachedSession {
  state: ThoughtState;
  offset: number;
}

function emptyState(): ThoughtState {
  return { intent: "", openQuestions: [], recentDecisions: [], entities: [] };
}

function dedupeCap(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.trim()))].slice(-MAX_ACCUMULATED);
}

/** Read only the bytes appended since `offset`. Handles a rotated/truncated file by restarting. */
export function readSlice(file: string, offset: number): { text: string; newOffset: number } {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { text: "", newOffset: offset }; // transcript not present yet
  }
  const start = size < offset ? 0 : offset;
  if (size <= start) return { text: "", newOffset: size };
  const length = size - start;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return { text: buf.toString("utf8"), newOffset: size };
  } finally {
    closeSync(fd);
  }
}

/** Tolerantly extract role/content from transcript JSONL lines (Claude Code & simple shapes). */
export function parseTranscriptSlice(text: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = extractMessage(obj);
    if (message) out.push(message);
  }
  return out;
}

function extractMessage(obj: unknown): TranscriptMessage | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const wrapped = (o.message ?? o) as Record<string, unknown>;
  const roleRaw = String(wrapped.role ?? o.type ?? "");
  const role: TranscriptMessage["role"] =
    roleRaw === "assistant" ? "assistant" : roleRaw === "system" ? "system" : roleRaw === "tool" ? "tool" : "user";
  const content = coerceContent(wrapped.content ?? o.text ?? o.content);
  if (!content) return null;
  return { role, content };
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { text?: unknown; content?: unknown };
        return typeof p.text === "string" ? p.text : typeof p.content === "string" ? p.content : "";
      })
      .join("");
  }
  return "";
}

function formatMessages(messages: TranscriptMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function looksLikePath(s: string): boolean {
  return /[\\/.]/.test(s) && /\.[a-z0-9]+$/i.test(s);
}

export function createSessionReader(opts: SessionReaderOptions): SessionReader {
  const env = opts.env;
  const cwd = opts.cwd;

  const loadCache = (sessionId: string): CachedSession => {
    try {
      const parsed = JSON.parse(readFileSync(sessionStateFile(sessionId, cwd, env), "utf8")) as CachedSession;
      if (parsed && parsed.state && typeof parsed.offset === "number") return parsed;
    } catch {
      // missing/corrupt → fresh
    }
    return { state: emptyState(), offset: 0 };
  };

  const saveCache = (sessionId: string, cache: CachedSession): void => {
    try {
      ensureDir(sessionsDir(cwd, env));
      writeFileSync(sessionStateFile(sessionId, cwd, env), JSON.stringify(cache));
    } catch {
      // Persisting the cache is best-effort; a write failure must not break the hook.
    }
  };

  const mergeState = (prior: ThoughtState, next: ThoughtState): ThoughtState => ({
    intent: next.intent.trim() || prior.intent,
    approach: next.approach ?? prior.approach,
    openQuestions: dedupeCap(next.openQuestions.length ? next.openQuestions : prior.openQuestions),
    recentDecisions: dedupeCap([...prior.recentDecisions, ...next.recentDecisions]),
    entities: dedupeCap([...prior.entities, ...next.entities]),
  });

  const systemPrompt = (): string =>
    opts.prompts ? opts.prompts.resolve("session-reader") : resolvePrompt("session-reader", {}, { cwd, env });

  const distill = async (prior: ThoughtState, messages: TranscriptMessage[]): Promise<ThoughtState> => {
    try {
      const out = await opts.provider.chat({
        system: systemPrompt(),
        responseFormat: "json",
        maxTokens: 500,
        messages: [
          {
            role: "user",
            content: `PRIOR_STATE:\n${JSON.stringify(prior)}\n\nNEW_TRANSCRIPT:\n${formatMessages(messages)}`,
          },
        ],
      });
      const parsed = thoughtStateSchema.safeParse(JSON.parse(out.text));
      return parsed.success ? parsed.data : prior; // graceful fallback (never break a turn)
    } catch {
      return prior;
    }
  };

  return {
    async lineOfThought(sessionId, transcriptPath) {
      const cache = loadCache(sessionId);
      const { text, newOffset } = readSlice(transcriptPath, cache.offset);
      if (!text.trim()) return cache.state; // no new content → flat, no model call

      const messages = parseTranscriptSlice(text);
      if (messages.length === 0) {
        saveCache(sessionId, { state: cache.state, offset: newOffset });
        return cache.state;
      }
      const merged = mergeState(cache.state, await distill(cache.state, messages));
      saveCache(sessionId, { state: merged, offset: newOffset });
      return merged;
    },

    async filePurpose(sessionId, file) {
      const { state } = loadCache(sessionId);
      const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
      const haystack = [state.intent, state.approach ?? "", ...state.entities, ...state.recentDecisions]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(base) || haystack.includes(file.toLowerCase())) {
        return state.intent ? `In service of: ${state.intent}` : "Referenced in the current line of thought";
      }
      return null; // not obvious → caller asks the user
    },

    async retrievalCues(sessionId) {
      const { state } = loadCache(sessionId);
      const files = state.entities.filter(looksLikePath);
      const query = [state.intent, ...state.entities].filter(Boolean).join(" ").trim();
      const cues: RetrievalCues = { query, files };
      return cues;
    },
  };
}
