import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const extensibilityCheck: TenetCheck = {
  tenet: "E",
  name: "extensibility:swappable-behind-a-seam",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Extensibility (E): is new behavior placed behind an abstraction that can be swapped, " +
    "with core logic separated from the concrete implementation, so an alternative can be added " +
    "without editing call sites? Flag a concrete vendor or implementation hard-wired into " +
    "business logic where an interface seam belongs.",
};
