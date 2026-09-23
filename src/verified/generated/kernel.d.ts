// Generated ABI; see proofs/kernel-abi.json.
export type DisclosureDecision = { $: "Drop" } | { $: "Suppress" } | { $: "Reveal" };
export type BasisStep = { $: "Empty" } | { $: "Done" } | { $: "First" }
  | { $: "Next"; at: bigint; previous: bigint; older: bigint };

export declare function disclosure(scope: boolean, excluded: boolean, seen: boolean, repeat: boolean, nucleus: boolean): DisclosureDecision;
export declare function shownCount(total: bigint, requested: bigint): bigint;
export declare function remainingCount(total: bigint, requested: bigint): bigint;
export declare function basisStep(have: bigint, order: bigint): BasisStep;
