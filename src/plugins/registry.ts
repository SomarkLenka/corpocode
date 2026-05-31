// Flattens discovered plugins into the two contribution lists the consumers actually read: the
// retrieval templates the planner can select, and the tenet checks the MOLAR-EDIT engine fans out.
// Built once and carried on the HookContext, so a hook reads contributions without re-scanning.
import type { TenetCheck } from "../molar/types";
import type { RetrievalTemplate } from "./types";
import { discoverPlugins, type DiscoverDeps, type DiscoveredPlugin } from "./discover";

export interface PluginContributions {
  plugins: DiscoveredPlugin[];
  templates: RetrievalTemplate[];
  tenets: TenetCheck[];
}

export const EMPTY_CONTRIBUTIONS: PluginContributions = { plugins: [], templates: [], tenets: [] };

export function loadPluginContributions(deps?: DiscoverDeps): PluginContributions {
  const plugins = discoverPlugins(deps);
  const templates: RetrievalTemplate[] = [];
  const tenets: TenetCheck[] = [];
  for (const { plugin } of plugins) {
    if (plugin.templates) templates.push(...plugin.templates);
    if (plugin.tenets) tenets.push(...plugin.tenets);
  }
  return { plugins, templates, tenets };
}
