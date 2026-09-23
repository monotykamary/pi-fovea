export type DisclosureDecision = { $: "Drop" } | { $: "Suppress" } | { $: "Reveal" };
export type BasisStep = { $: "Empty" } | { $: "Done" } | { $: "First" }
  | { $: "Next"; at: bigint; previous: bigint; older: bigint };
