// Orchestrate backend provisioning. Factored out of `install` so it is a deliberate act, not a
// silent side effect — `corpocode install` calls it as its second half, and `corpocode provision`
// (or the /corpocode:setup skill) runs it on its own in the plugin channel.
import type { CorpoConfig } from "../config/schema";
import { loadSecrets, resolveApiKey } from "../config/secrets";
import { provisionGraphify, type GraphifyProvisionOptions } from "./backends/graphify";
import { provisionOpenViking, type OpenVikingProvisionOptions } from "./backends/openviking";
import type { ProvisionResult } from "./run";

export interface ProvisionOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  skipGraphify?: boolean;
  skipOpenViking?: boolean;
  graphifyOverrides?: Partial<GraphifyProvisionOptions>;
  openvikingOverrides?: Partial<OpenVikingProvisionOptions>;
}

export interface ProvisionReport {
  graphify?: ProvisionResult;
  openviking?: ProvisionResult;
}

export async function provision(config: CorpoConfig, opts: ProvisionOptions): Promise<ProvisionReport> {
  const env = opts.env ?? process.env;
  const report: ProvisionReport = {};

  // Phase 5: only provision a Python backend the config actually selects. A default (native) install
  // provisions nothing — no toolchain to fetch, no daemon to start.
  const wantGraphify = config.backends.knowledgeGraph === "graphify";
  const wantOpenViking = config.backends.contextStore === "openviking";

  if (wantGraphify && !opts.skipGraphify) {
    report.graphify = await provisionGraphify({
      repoRoot: opts.repoRoot,
      dryRun: opts.dryRun,
      ...opts.graphifyOverrides,
    });
  }

  if (wantOpenViking && !opts.skipOpenViking) {
    const secrets = loadSecrets(env);
    const providerKey = config.components.retrieval;
    const provider = config.providers[providerKey] ?? config.providers.default!;
    const apiKey = resolveApiKey({ kind: provider.kind, apiKeyRef: provider.apiKeyRef }, secrets, env);
    report.openviking = await provisionOpenViking({
      config,
      apiKey,
      dryRun: opts.dryRun,
      ...opts.openvikingOverrides,
    });
  }

  return report;
}
