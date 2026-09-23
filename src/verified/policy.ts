import {
  shownCount as shown,
  remainingCount as remaining,
  basisStep,
} from "./generated/kernel.js";

// The pinned JS backend's immediate Nat bound, stricter than MAX_SAFE_INTEGER.
export const BEND_NAT_MAX = 2 ** 48 - 1;
const encode = (value: number): bigint => {
  if (!Number.isSafeInteger(value) || value < 0 || value > BEND_NAT_MAX) {
    throw new RangeError(`Expected a natural count <= ${BEND_NAT_MAX}, got ${value}`);
  }
  return BigInt(value);
};
const decode = (value: bigint): number => {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(BEND_NAT_MAX)) {
    throw new RangeError("Invalid Nat from verified kernel");
  }
  return Number(value);
};

export const shownCount = (total: number, requested: number): number => decode(shown(encode(total), encode(requested)));
export const remainingCount = (total: number, requested: number): number => decode(remaining(encode(total), encode(requested)));

export type BasisStep = { $: "Empty" } | { $: "Done" } | { $: "First" }
  | { $: "Next"; at: number; previous: number; older: number };

/** Trusted numeric codec only. Admission, next index and predecessors all
 * come from the executable Bend kernel; there is no handwritten fallback. */
export const nextBasisStep = (have: number, order: number): BasisStep => {
  const step = basisStep(encode(have), encode(order));
  switch (step.$) {
    case "Empty": case "Done": case "First": return step;
    case "Next": return { $: "Next", at: decode(step.at), previous: decode(step.previous), older: decode(step.older) };
    default: throw new Error("Invalid basis command from verified kernel");
  }
};
