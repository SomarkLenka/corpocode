import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const atomicityCheck: TenetCheck = {
  tenet: "A",
  name: "atomicity:one-thing-per-unit",
  appliesTo: (file) => isSource(file.path),
  promptId: "verifier-atomicity",
};
