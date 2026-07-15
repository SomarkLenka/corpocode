import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";

describe("orchestrator Phase 2 config", () => {
  it("parses {} to complete defaults (every block carries .default())", () => {
    const cfg = configSchema.parse({});
    expect(cfg.orchestrator.swarm.attempts_per_task).toBe(2);
    expect(cfg.orchestrator.swarm.max_parallel_writers).toBe(3);
    expect(cfg.orchestrator.swarm.task_wallclock_ms).toBe(600_000);
    expect(cfg.orchestrator.swarm.run_wallclock_ms).toBe(14_400_000);
    expect(cfg.orchestrator.depgate.enabled).toBe(true);
    expect(cfg.orchestrator.depgate.registry_check).toBe(false);
    expect(cfg.orchestrator.sanitize.enabled).toBe(true);
  });

  it("caps attempts_per_task at 5 (inference-scaling hedge: small k only)", () => {
    expect(() =>
      configSchema.parse({ orchestrator: { swarm: { attempts_per_task: 6 } } }),
    ).toThrow();
  });
});
