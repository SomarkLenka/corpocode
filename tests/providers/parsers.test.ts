import { describe, it, expect } from "vitest";
import { parseAnthropicResponse } from "../../src/providers/anthropic";
import { parseOpenAiResponse } from "../../src/providers/openai";
import { parseGoogleResponse } from "../../src/providers/google";
import { parseOllamaResponse } from "../../src/providers/ollama";
import { parseClaudeCliResponse, buildCliPrompt } from "../../src/providers/anthropic-cli";

describe("vendor response parsers", () => {
  it("anthropic: concatenates text blocks and maps stop_reason", () => {
    const r = parseAnthropicResponse(
      {
        content: [
          { type: "text", text: "hi" },
          { type: "thinking", text: "ignored" },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
        stop_reason: "end_turn",
        model: "claude-haiku-4-5-20251001",
      },
      "fallback",
    );
    expect(r.text).toBe("hi");
    expect(r.inputTokens).toBe(5);
    expect(r.outputTokens).toBe(7);
    expect(r.finishReason).toBe("stop");
    expect(r.model).toBe("claude-haiku-4-5-20251001");
  });

  it("anthropic: max_tokens → length", () => {
    expect(parseAnthropicResponse({ stop_reason: "max_tokens" }, "m").finishReason).toBe("length");
  });

  it("openai: reads choice content and usage", () => {
    const r = parseOpenAiResponse(
      {
        choices: [{ message: { content: "yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
        model: "gpt-5-nano",
      },
      "fb",
    );
    expect(r.text).toBe("yo");
    expect(r.inputTokens).toBe(3);
    expect(r.outputTokens).toBe(4);
  });

  it("google: via text() accessor", () => {
    const r = parseGoogleResponse(
      {
        response: {
          text: () => "g",
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 6 },
          candidates: [{ finishReason: "STOP" }],
        },
      },
      "gemini",
    );
    expect(r.text).toBe("g");
    expect(r.inputTokens).toBe(2);
    expect(r.outputTokens).toBe(6);
  });

  it("google: via candidate parts", () => {
    const r = parseGoogleResponse(
      { response: { candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] } },
      "gemini",
    );
    expect(r.text).toBe("ab");
  });

  it("ollama: reads message content and eval counts", () => {
    const r = parseOllamaResponse(
      { message: { content: "ok" }, prompt_eval_count: 8, eval_count: 9, model: "qwen" },
      "fb",
    );
    expect(r.text).toBe("ok");
    expect(r.inputTokens).toBe(8);
    expect(r.outputTokens).toBe(9);
  });

  it("claude-cli: parses the result envelope", () => {
    const r = parseClaudeCliResponse(
      JSON.stringify({ result: "done", usage: { input_tokens: 1, output_tokens: 2 }, model: "claude-haiku-4-5" }),
      "fb",
    );
    expect(r.text).toBe("done");
    expect(r.inputTokens).toBe(1);
    expect(r.outputTokens).toBe(2);
  });

  it("claude-cli: builds a flat prompt", () => {
    expect(buildCliPrompt("sys", [{ role: "user", content: "hi" }])).toBe("sys\n\nuser: hi");
  });
});
