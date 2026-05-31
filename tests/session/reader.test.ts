import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReader } from "../../src/session/reader";
import type { ChatInput, ChatOutput, Provider } from "../../src/providers/types";

const jsonl = (rows: object[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function fakeProvider(responses: object[]): { provider: Provider; inputs: ChatInput[] } {
  const inputs: ChatInput[] = [];
  let i = 0;
  const provider: Provider = {
    id: "anthropic",
    model: "test",
    modelTier: "fast",
    async chat(input) {
      inputs.push(input);
      const body = responses[Math.min(i, responses.length - 1)] ?? {};
      i++;
      const out: ChatOutput = {
        text: JSON.stringify(body),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        providerId: "anthropic",
        model: "test",
        finishReason: "stop",
      };
      return out;
    },
    async ping() {
      return true;
    },
  };
  return { provider, inputs };
}

describe("session reader", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let transcript: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cc-sess-"));
    env = { CORPOCODE_HOME: home };
    transcript = join(home, "transcript.jsonl");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("keeps earlier intent across a later terse prompt", async () => {
    const { provider, inputs } = fakeProvider([
      { intent: "implement JWT auth", entities: ["auth.ts", "verifyToken"], openQuestions: [], recentDecisions: [] },
      { intent: "", entities: [], openQuestions: [], recentDecisions: [] },
    ]);
    const reader = createSessionReader({ provider, env });

    writeFileSync(
      transcript,
      jsonl([
        { role: "user", content: "implement JWT auth in auth.ts" },
        { role: "assistant", content: "I'll add a verifyToken function" },
      ]),
    );
    const s1 = await reader.lineOfThought("sess", transcript);
    expect(s1.intent).toBe("implement JWT auth");

    appendFileSync(transcript, jsonl([{ role: "user", content: "now fix it" }]));
    const s2 = await reader.lineOfThought("sess", transcript);
    expect(s2.intent).toBe("implement JWT auth"); // carried forward despite the terse turn
    expect(inputs).toHaveLength(2);
  });

  it("feeds only the new transcript slice to the model (flat cost)", async () => {
    const { provider, inputs } = fakeProvider([
      { intent: "x", entities: [], openQuestions: [], recentDecisions: [] },
    ]);
    const reader = createSessionReader({ provider, env });
    writeFileSync(transcript, jsonl([{ role: "user", content: "first line about auth" }]));
    await reader.lineOfThought("sess", transcript);
    appendFileSync(transcript, jsonl([{ role: "user", content: "second line about cache" }]));
    await reader.lineOfThought("sess", transcript);

    const secondCall = inputs[1]!.messages[0]!.content;
    expect(secondCall).toContain("second line about cache");
    expect(secondCall).not.toContain("first line about auth");
  });

  it("resumes from the persisted offset in a fresh reader instance (separate process)", async () => {
    writeFileSync(transcript, jsonl([{ role: "user", content: "alpha line" }]));
    const a = fakeProvider([{ intent: "i", entities: [], openQuestions: [], recentDecisions: [] }]);
    await createSessionReader({ provider: a.provider, env }).lineOfThought("sess", transcript);

    appendFileSync(transcript, jsonl([{ role: "user", content: "beta line" }]));
    const b = fakeProvider([{ intent: "i2", entities: [], openQuestions: [], recentDecisions: [] }]);
    await createSessionReader({ provider: b.provider, env }).lineOfThought("sess", transcript);

    expect(b.inputs).toHaveLength(1);
    expect(b.inputs[0]!.messages[0]!.content).toContain("beta line");
    expect(b.inputs[0]!.messages[0]!.content).not.toContain("alpha line");
  });

  it("does not call the model when there is no new transcript content", async () => {
    const { provider, inputs } = fakeProvider([
      { intent: "i", entities: [], openQuestions: [], recentDecisions: [] },
    ]);
    const reader = createSessionReader({ provider, env });
    writeFileSync(transcript, jsonl([{ role: "user", content: "only line" }]));
    await reader.lineOfThought("sess", transcript);
    const s2 = await reader.lineOfThought("sess", transcript);
    expect(inputs).toHaveLength(1);
    expect(s2.intent).toBe("i");
  });

  it("infers a file purpose when the file is in play, else null", async () => {
    const { provider } = fakeProvider([
      { intent: "implement auth", entities: ["auth.ts"], openQuestions: [], recentDecisions: [] },
    ]);
    const reader = createSessionReader({ provider, env });
    writeFileSync(transcript, jsonl([{ role: "user", content: "work on auth.ts" }]));
    await reader.lineOfThought("sess", transcript);
    expect(await reader.filePurpose("sess", "src/auth.ts")).toContain("implement auth");
    expect(await reader.filePurpose("sess", "unrelated.ts")).toBeNull();
  });

  it("derives retrieval cues from the line of thought", async () => {
    const { provider } = fakeProvider([
      { intent: "fix cache bug", entities: ["cache.ts", "getValue"], openQuestions: [], recentDecisions: [] },
    ]);
    const reader = createSessionReader({ provider, env });
    writeFileSync(transcript, jsonl([{ role: "user", content: "cache bug" }]));
    await reader.lineOfThought("sess", transcript);
    const cues = await reader.retrievalCues("sess");
    expect(cues.query).toContain("fix cache bug");
    expect(cues.files).toContain("cache.ts");
  });
});
