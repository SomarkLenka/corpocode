// Selects the ContextStore implementation by config.backends.contextStore.
import type { CorpoConfig } from "../../config/schema";
import type { ContextStore } from "./types";
import { createOpenVikingAdapter, type OpenVikingAdapterOptions } from "./openviking-adapter";
import { createNativeContextStore } from "./native";

export function buildContextStore(
  config: CorpoConfig,
  opts: { openviking?: OpenVikingAdapterOptions } = {},
): ContextStore {
  switch (config.backends.contextStore) {
    case "openviking":
      return createOpenVikingAdapter(opts.openviking ?? {});
    case "native":
      return createNativeContextStore();
    default: {
      const unreachable: never = config.backends.contextStore;
      throw new Error(`unsupported contextStore backend: ${String(unreachable)}`);
    }
  }
}
