// Plugin API (Phase 4 §3) — discovery is fail-open and apiVersion-gated, and the two seams are actually
// exercised: a contributed template is selectable by the planner, and a contributed tenet check runs in
// the verifier fan-out. Everything is injected, so no real package resolution or filesystem is touched.
import { describe, it, expect } from "vitest";
import { discoverPlugins, validatePlugin } from "../../src/plugins/discover";
import { loadPluginContributions } from "../../src/plugins/registry";
import { planChecklist } from "../../src/retrieval/planner";
import { createMolarEditEngine } from "../../src/molar/engine";
import { configSchema } from "../../src/config/schema";
import type { CorpoPlugin } from "../../src/plugins/types";
import type { TenetCheck } from "../../src/molar/types";
import type { Provider, ChatInput, ChatOutput } from "../../src/providers/types";
import type { RetrievalCues } from "../../src/session/types";

const templatePlugin: CorpoPlugin = {
  apiVersion: 1,
  name: "corpocode-template-demo",
  templates: [
    {
      type: "demo-moment",
      build: (_cues: RetrievalCues, _prompt: string) => [
        { kind: "mem_recall", label: "demo", priority: 0.9, query: "demo", limit: 1 },
      ],
    },
  ],
};

const PLUGIN_MARK = "PLUGINMARK";
const tenetPlugin: CorpoPlugin = {
  apiVersion: 1,
  name: "corpocode-tenet-demo",
  tenets: [{ tenet: "M", name: "plugin:demo", appliesTo: () => true, prompt: PLUGIN_MARK }],
};

describe("plugin discovery", () => {
  it("discovers convention-named packages and aggregates their contributions", () => {
    const loaded = discoverPlugins({
      scanDirs: ["/fake"],
      listPackages: () => ["corpocode-template-demo", "corpocode-tenet-demo"],
      loader: (name) => (name === "corpocode-template-demo" ? templatePlugin : tenetPlugin),
    });
    expect(loaded.map((p) => p.name)).toEqual(["corpocode-template-demo", "corpocode-tenet-demo"]);

    const contributions = loadPluginContributions({
      scanDirs: ["/fake"],
      listPackages: () => ["corpocode-template-demo", "corpocode-tenet-demo"],
      loader: (name) => (name === "corpocode-template-demo" ? templatePlugin : tenetPlugin),
    });
    expect(contributions.templates).toHaveLength(1);
    expect(contributions.tenets).toHaveLength(1);
  });

  it("declines a plugin built for an incompatible apiVersion", () => {
    expect(validatePlugin({ apiVersion: 2, name: "corpocode-tenet-future" })).toBeNull();
    expect(validatePlugin({ name: "no-version" })).toBeNull();
    expect(validatePlugin(validatePlugin(templatePlugin))).toEqual(templatePlugin);
  });

  it("skips a plugin that throws while loading rather than crashing (fail-open)", () => {
    const logs: string[] = [];
    const loaded = discoverPlugins({
      scanDirs: ["/fake"],
      listPackages: () => ["corpocode-tenet-broken", "corpocode-tenet-demo"],
      loader: (name) => {
        if (name === "corpocode-tenet-broken") throw new Error("bad import");
        return tenetPlugin;
      },
      log: (m) => logs.push(m),
    });
    expect(loaded.map((p) => p.name)).toEqual(["corpocode-tenet-demo"]); // the good one still loads
    expect(logs.some((l) => l.includes("corpocode-tenet-broken"))).toBe(true);
  });
});

describe("contributed template is selectable by the planner", () => {
  const provider = {} as Provider; // not used: a matching template short-circuits the LLM path

  it("selects a plugin template for its moment type", async () => {
    const items = await planChecklist(
      { type: "demo-moment", prompt: "p", cues: { query: "", files: [] }, maxItems: 6 },
      { provider, templates: templatePlugin.templates! },
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("demo");
  });

  it("never lets a plugin override a built-in moment type", async () => {
    const override = [{ type: "code-edit", build: () => [{ kind: "mem_recall" as const, label: "HIJACK", priority: 1, query: "x", limit: 1 }] }];
    const items = await planChecklist(
      { type: "code-edit", prompt: "p", cues: { query: "", files: [] }, maxItems: 6 },
      { provider, templates: override },
    );
    expect(items.every((i) => i.label !== "HIJACK")).toBe(true); // built-in code-edit won
  });
});

describe("contributed tenet runs in the verifier fan-out", () => {
  // A fake provider that tags its verdict by whether the plugin's prompt marker is present, so we can
  // see the plugin check specifically ran.
  const provider: Provider = {
    id: "anthropic",
    model: "fake",
    modelTier: "fast",
    async chat(input: ChatInput): Promise<ChatOutput> {
      const fromPlugin = input.system.includes(PLUGIN_MARK);
      return {
        text: JSON.stringify({ ok: false, severity: "warn", message: fromPlugin ? "from-plugin" : "from-builtin", confidence: 0.9 }),
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
  const readFile = () => "export function f() {}";
  const extraChecks: TenetCheck[] = tenetPlugin.tenets!;

  it("runs the plugin check when its tenet is active", async () => {
    const config = configSchema.parse({ molar_edit: { active_tenets: ["M"] } });
    const engine = createMolarEditEngine({ provider, config, readFile, extraChecks });
    const findings = await engine.verify(["src/x.ts"]);
    expect(findings).toHaveLength(2); // built-in M + plugin M
    expect(findings.some((f) => f.message === "from-plugin")).toBe(true);
  });

  it("does not run the plugin check when its tenet is disabled", async () => {
    const config = configSchema.parse({ molar_edit: { active_tenets: ["O"] } }); // M (and the plugin) off
    const engine = createMolarEditEngine({ provider, config, readFile, extraChecks });
    const findings = await engine.verify(["src/x.ts"]);
    expect(findings.some((f) => f.message === "from-plugin")).toBe(false);
  });
});
