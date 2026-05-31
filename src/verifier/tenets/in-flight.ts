import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const inFlightCheck: TenetCheck = {
  tenet: "I",
  name: "in-flight:timeout-retry-fallback",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess In-flight (I): does every external call (HTTP, DB, queue, cache) have a timeout, a " +
    "bounded and jittered retry, and a defined fallback, and does the code keep flying when a " +
    "dependency is down instead of crashing? Flag an await with no timeout, unbounded/unjittered " +
    "retries, a cache miss that hard-fails the request, and 'crash and let the orchestrator " +
    "restart' used as the recovery plan.",
};
