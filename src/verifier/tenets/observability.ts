import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const observabilityCheck: TenetCheck = {
  tenet: "O",
  name: "observability:metrics-and-readiness",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Observability (O): do critical paths emit a latency metric and a success/failure " +
    "signal, do readiness checks verify real downstream reachability rather than mere process " +
    "liveness, and do trace IDs propagate across every async/queue boundary? Flag a critical path " +
    "with no metric, a /health that returns 200 just because the process is up, and high-" +
    "cardinality metric labels.",
};
