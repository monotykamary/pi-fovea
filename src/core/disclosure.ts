import { disclosure } from "../verified/generated/kernel.js";

/** Boolean/tag codec for the compiled disclosure policy. D drops a candidate,
 * S counts prior disclosure, R admits it before ranking/formatting. */
export const disclosureDecision = (
  inScope: boolean,
  excluded: boolean,
  seen: boolean,
  repeat: boolean,
  nucleus: boolean,
): "D" | "S" | "R" => {
  if (typeof inScope !== "boolean" || typeof excluded !== "boolean" || typeof seen !== "boolean"
    || typeof repeat !== "boolean" || typeof nucleus !== "boolean") throw new TypeError("Expected Boolean disclosure inputs");
  switch (disclosure(inScope, excluded, seen, repeat, nucleus).$) {
    case "Drop": return "D";
    case "Suppress": return "S";
    case "Reveal": return "R";
    default: throw new Error("Invalid disclosure decision from verified kernel");
  }
};
