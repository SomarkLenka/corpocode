import { describe, it, expect } from "vitest";
import { selectModelEffort } from "../../src/router/effort";
import { defaultConfig } from "../../src/config/load";

const cfg = defaultConfig();

describe("selectModelEffort", () => {
  it("maps trivial → router / minimal", () => {
    const c = selectModelEffort("trivial", cfg);
    expect(c.effort).toBe("minimal");
    expect(c.providerComponent).toBe("router");
  });

  it("maps medium → router / medium", () => {
    expect(selectModelEffort("medium", cfg).effort).toBe("medium");
  });

  it("maps hard → claude-opus-4 / high", () => {
    const c = selectModelEffort("hard", cfg);
    expect(c.effort).toBe("high");
    expect(c.model).toBe("claude-opus-4");
  });
});
