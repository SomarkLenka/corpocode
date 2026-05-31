// Google Gemini adapter (default gemini-2.5-flash). Uses the SDK's native JSON mode via
// responseMimeType. Timeout is enforced by the runner's race even though this SDK call isn't
// passed an abort signal in older versions.
import type { Provider } from "./types";
import { ProviderError } from "./types";
import { makeProvider, type AdapterOptions } from "./base";
import type { RawChat, RawResult } from "./runner";
import { mapVendorError } from "./errors";

const PROVIDER_ID = "google" as const;
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";

function mapFinish(reason: unknown): "stop" | "length" | "error" {
  return reason === "MAX_TOKENS" ? "length" : "stop";
}

/** Normalize a Gemini generateContent result. Handles both the text() accessor and raw candidates. */
export function parseGoogleResponse(result: unknown, fallbackModel: string): RawResult {
  const resp = (result as { response?: unknown })?.response as
    | {
        text?: () => string;
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: unknown }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      }
    | undefined;
  const fromParts = (resp?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  const text = typeof resp?.text === "function" ? resp.text() : fromParts;
  return {
    text,
    inputTokens: resp?.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: resp?.usageMetadata?.candidatesTokenCount ?? 0,
    finishReason: mapFinish(resp?.candidates?.[0]?.finishReason),
    model: fallbackModel,
  };
}

function defaultRawChat(opts: AdapterOptions): RawChat {
  return async (input) => {
    if (!opts.apiKey) {
      throw new ProviderError("auth", PROVIDER_ID, "GEMINI_API_KEY is not configured", false);
    }
    try {
      // Vendor seam — loosely typed boundary, normalized immediately. (Justified boundary `any`.)
      const mod: any = await import("@google/generative-ai");
      const GoogleGenerativeAI = mod.GoogleGenerativeAI ?? mod.default;
      const genAI = new GoogleGenerativeAI(opts.apiKey);
      const model = genAI.getGenerativeModel({
        model: opts.model,
        systemInstruction: input.system || undefined,
        generationConfig: {
          temperature: input.temperature ?? 0,
          maxOutputTokens: input.maxTokens,
          responseMimeType: input.responseFormat === "json" ? "application/json" : undefined,
        },
      });
      const result = await model.generateContent({
        contents: input.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      });
      return parseGoogleResponse(result, opts.model);
    } catch (err) {
      throw mapVendorError(err, PROVIDER_ID);
    }
  };
}

export function createGoogleProvider(opts: AdapterOptions): Provider {
  const model = opts.model || DEFAULT_GOOGLE_MODEL;
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
