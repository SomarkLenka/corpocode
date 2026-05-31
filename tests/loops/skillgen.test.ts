// Skill loop — mine memories into candidate memos, then promote reviewed memos into installed skills.
// Proves the Phase 3 §4 deliverable: skillgen writes candidates (never installs), and skillify promotes
// only valid memos, skipping any missing a name or description. Memory and provider are faked; the
// filesystem side uses temp dirs so the round-trip to disk is real.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSkillCandidates, renderMemo, slugify } from "../../src/loops/skillgen";
import { promoteCandidates, parseFrontmatter } from "../../src/loops/skillify";
import type { Provider, ChatInput, ChatOutput } from "../../src/providers/types";
import type { MemoryStore, ScoredMemory, MemoryKind } from "../../src/backends/memory/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function fakeMemory(mems: { kind: MemoryKind; text: string }[]): MemoryStore {
  return {
    id: "native",
    async recall(): Promise<ScoredMemory[]> {
      return mems.map((m, i) => ({ id: `m${i}`, kind: m.kind, text: m.text, createdAt: 0, score: 1 }));
    },
    async capture() {},
    async consolidate() {
      return { captured: 0, superseded: 0 };
    },
    async recordOutcome() {},
    async ping() {
      return true;
    },
  };
}

function fakeProvider(json: string): Provider {
  return {
    id: "anthropic",
    model: "fake",
    modelTier: "fast",
    async chat(_input: ChatInput): Promise<ChatOutput> {
      return {
        text: json,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        latencyMs: 1,
        providerId: "anthropic",
        model: "fake",
        finishReason: "stop",
      };
    },
    async ping() {
      return true;
    },
  };
}

describe("skillgen — mining candidates", () => {
  it("distills mistake/approach memories into candidate memos written for review (not installed)", async () => {
    const dir = tempDir("cc-cand-");
    const memory = fakeMemory([
      { kind: "mistake", text: "forgot to attach an error handler to a spawned child" },
      { kind: "approach", text: "always validate hook input with Zod before dispatch" },
    ]);
    const provider = fakeProvider(
      JSON.stringify({
        candidates: [
          { name: "Spawn Error Handling", description: "Attach an error handler to every child", body: "Always child.on('error', ...)." },
        ],
      }),
    );

    const res = await generateSkillCandidates({
      memory,
      provider,
      scope: { project: "p", workspaceCascade: false },
      dir,
    });

    expect(res.mined).toBe(2);
    expect(res.written).toBe(1);
    expect(res.names).toEqual(["spawn-error-handling"]);
    const memo = readFileSync(join(dir, "spawn-error-handling.md"), "utf8");
    const { fm, body } = parseFrontmatter(memo);
    expect(fm.name).toBe("spawn-error-handling");
    expect(fm.description).toContain("error handler");
    expect(body).toContain("child.on");
  });

  it("writes nothing when there are no mistake/approach memories", async () => {
    const dir = tempDir("cc-cand-");
    const res = await generateSkillCandidates({
      memory: fakeMemory([]),
      provider: fakeProvider("{}"),
      scope: { project: "p", workspaceCascade: false },
      dir,
    });
    expect(res).toEqual({ mined: 0, written: 0, names: [] });
    expect(existsSync(join(dir, "spawn-error-handling.md"))).toBe(false);
  });
});

describe("skillify — promoting candidates", () => {
  it("installs valid memos as SKILL.md and skips any missing a name or description", () => {
    const from = tempDir("cc-from-");
    const to = tempDir("cc-to-");
    writeFileSync(join(from, "good.md"), renderMemo({ name: "Good Skill", description: "do good", body: "the body" }, "good-skill"));
    writeFileSync(join(from, "bad.md"), "---\nname: NoDescription\n---\n\nbody only\n"); // missing description

    const res = promoteCandidates({ fromDir: from, toDir: to, removeAfter: true });

    expect(res.promoted).toEqual(["good-skill"]);
    expect(res.skipped).toEqual(["bad.md"]);
    expect(readFileSync(join(to, "good-skill", "SKILL.md"), "utf8")).toContain("description: do good");
    expect(existsSync(join(from, "good.md"))).toBe(false); // promoted memo consumed
    expect(existsSync(join(from, "bad.md"))).toBe(true); // invalid memo left in place
  });

  it("is a no-op when the candidates directory does not exist", () => {
    const res = promoteCandidates({ fromDir: join(tmpdir(), "cc-does-not-exist-xyz"), toDir: tempDir("cc-to-") });
    expect(res).toEqual({ promoted: [], skipped: [] });
  });
});

describe("helpers", () => {
  it("slugify produces kebab-case filesystem-safe names", () => {
    expect(slugify("My Cool Skill!")).toBe("my-cool-skill");
    expect(slugify("  ---  ")).toBe("");
  });
  it("parseFrontmatter reads name and description and returns the body", () => {
    const { fm, body } = parseFrontmatter("---\nname: x\ndescription: y\n---\n\nhello\n");
    expect(fm).toEqual({ name: "x", description: "y" });
    expect(body.trim()).toBe("hello");
  });
});
