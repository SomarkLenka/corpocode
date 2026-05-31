import type { TenetCheck } from "../../molar/types";
import { isSource } from "./patterns";

export const maintainabilityCheck: TenetCheck = {
  tenet: "M",
  name: "maintainability:isolated-and-honest",
  appliesTo: (file) => isSource(file.path),
  prompt:
    "Assess Maintainability (M): is this change isolated to the files it needs, with accurate " +
    "names that hold no surprises, magic values named, and no dead or commented-out code? Flag a " +
    "change that sprawls across unrelated files, names that lie (an isValid() that mutates, a " +
    "getUser() that creates), unexplained magic numbers/strings, and commented-out code kept " +
    "'just in case' (git remembers).",
};
