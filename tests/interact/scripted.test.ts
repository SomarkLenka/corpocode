// The scripted Interactor — CI's answers file and the tests' fake. Under test: matcher precedence
// and one-shot consumption, delegation resolving like the terminal would, the deliberate hard edge
// (no matching rule ⇒ default or pause), and the fail-open answers-file loader.
import { describe, it, expect } from "vitest";
import { createScriptedInteractor, loadAnswersFile, scriptedAnswersSchema } from "../../src/interact/scripted";
import type { Poll } from "../../src/interact/types";

function poll(over: Partial<Poll> = {}): Poll {
  return {
    id: "p1",
    concept: "auth-strategy",
    question: "How do users authenticate?",
    options: [
      { id: "a", label: "Sessions", findings: [] },
      { id: "b", label: "JWT", findings: [], recommended: true },
    ],
    allowFreeText: true,
    allowDelegate: true,
    ...over,
  };
}

describe("createScriptedInteractor — matching and consumption", () => {
  it("answers by option id, by exact label, and matches concept by substring", async () => {
    const ix = createScriptedInteractor({
      answers: [
        { concept: "auth", option: "Sessions" }, // exact label
        { poll: "p2", option: "b" }, // option id
      ],
    });
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", optionId: "a", source: "pilot" });
    await expect(ix.ask(poll({ id: "p2" }))).resolves.toEqual({ pollId: "p2", optionId: "b", source: "pilot" });
  });

  it("first unconsumed matching rule wins; a matcherless rule matches anything", async () => {
    const ix = createScriptedInteractor({
      answers: [
        { option: "a" }, // matches anything — must win the first poll
        { concept: "auth", option: "b" },
      ],
    });
    await expect(ix.ask(poll())).resolves.toMatchObject({ optionId: "a" });
    // The generic rule is spent, so the concept rule answers the second identical poll.
    await expect(ix.ask(poll({ id: "p2" }))).resolves.toMatchObject({ optionId: "b", source: "pilot" });
  });

  it("consumed rules are never reused — a third ask falls through to the default", async () => {
    const ix = createScriptedInteractor({ answers: [{ option: "a" }] });
    await ix.ask(poll());
    await expect(ix.ask(poll({ id: "p2", defaultOptionId: "b" }))).resolves.toEqual({ pollId: "p2", optionId: "b", source: "default" });
  });

  it("a rule whose poll id does not match is skipped without being consumed", async () => {
    const ix = createScriptedInteractor({ answers: [{ poll: "other", option: "a" }, { option: "b" }] });
    await expect(ix.ask(poll())).resolves.toMatchObject({ optionId: "b" });
    // The poll-scoped rule is still live for its own poll.
    await expect(ix.ask(poll({ id: "other" }))).resolves.toMatchObject({ optionId: "a" });
  });
});

describe("createScriptedInteractor — resolution details", () => {
  it("delegate resolves the recommended option as source 'delegated'", async () => {
    const ix = createScriptedInteractor({ answers: [{ delegate: true }] });
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", optionId: "b", source: "delegated" });
  });

  it("delegate falls back to the default option when nothing is recommended", async () => {
    const p = poll({ defaultOptionId: "a" });
    p.options = p.options.map((o) => ({ ...o, recommended: undefined }));
    const ix = createScriptedInteractor({ answers: [{ delegate: true }] });
    await expect(ix.ask(p)).resolves.toEqual({ pollId: "p1", optionId: "a", source: "delegated" });
  });

  it("freeText answers the poll in the script author's words", async () => {
    const ix = createScriptedInteractor({ answers: [{ freeText: "magic links only" }] });
    await expect(ix.ask(poll())).resolves.toEqual({ pollId: "p1", freeText: "magic links only", source: "pilot" });
  });

  it("freeText against a poll that forbids it degrades to the default, never fabricates", async () => {
    const ix = createScriptedInteractor({ answers: [{ freeText: "nope" }] });
    await expect(ix.ask(poll({ allowFreeText: false, defaultOptionId: "a" }))).resolves.toEqual({ pollId: "p1", optionId: "a", source: "default" });
  });

  it("an option name matching nothing degrades to the default", async () => {
    const ix = createScriptedInteractor({ answers: [{ option: "does-not-exist" }] });
    await expect(ix.ask(poll({ defaultOptionId: "b" }))).resolves.toEqual({ pollId: "p1", optionId: "b", source: "default" });
  });

  it("exhaustion with no default resolves null — the run pauses, CI must be explicit", async () => {
    const ix = createScriptedInteractor({ answers: [] });
    await expect(ix.ask(poll())).resolves.toBeNull();
  });

  it("say() reaches the injected output and is swallowed by default; close() is idempotent", async () => {
    const said: string[] = [];
    const ix = createScriptedInteractor({ answers: [] }, { output: (b) => said.push(b) });
    ix.say("phase: interrogation");
    expect(said).toEqual(["phase: interrogation"]);
    expect(() => createScriptedInteractor({ answers: [] }).say("into the void")).not.toThrow();
    await ix.close();
    await ix.close();
  });
});

describe("loadAnswersFile — fail-open loader", () => {
  it("parses a valid answers file", () => {
    const json = JSON.stringify({ answers: [{ concept: "auth", option: "b" }, { delegate: true }] });
    expect(loadAnswersFile("/x/answers.json", () => json)).toEqual({
      answers: [{ concept: "auth", option: "b" }, { delegate: true }],
    });
  });

  it("missing file, malformed JSON, and wrong shape all read as null without throwing", () => {
    expect(loadAnswersFile("/x/missing.json", () => null)).toBeNull();
    expect(loadAnswersFile("/x/bad.json", () => "{not json")).toBeNull();
    expect(loadAnswersFile("/x/shape.json", () => JSON.stringify({ answers: [{ delegate: "yes" }] }))).toBeNull();
    expect(loadAnswersFile("/x/shape2.json", () => JSON.stringify({ rules: [] }))).toBeNull();
  });

  it("really-missing file on disk reads as null via the default reader", () => {
    expect(loadAnswersFile("/definitely/not/a/real/path/answers.json")).toBeNull();
  });

  it("exports the schema so callers can validate inline scripts", () => {
    expect(scriptedAnswersSchema.safeParse({ answers: [] }).success).toBe(true);
    expect(scriptedAnswersSchema.safeParse({ answers: [{ option: 3 }] }).success).toBe(false);
  });
});
