import { afterEach, describe, expect, it, vi } from "vitest";
import * as kernel from "../src/verified/generated/kernel.js";
import { BEND_NAT_MAX, nextBasisStep, remainingCount, shownCount } from "../src/verified/policy.js";
import { disclosureDecision } from "../src/core/disclosure.js";
import { buildCsr, chebyshevVectors } from "../src/core/heat.js";
import { revealFoveated, revealGroups } from "../src/core/render.js";
import type { Graph } from "../src/core/types.js";

afterEach(() => vi.restoreAllMocks());
const graph = (): Graph => ({
  nodes: [{ id: "a", name: "a", kind: "function", file: "a.ts", line: 1, sig: "a()", lang: "TypeScript" }],
  edges: [], anchors: [], files: ["a.ts"], byName: new Map(), byFile: new Map(),
});

describe("executed verified kernels", () => {
  it("preserves disclosure argument positions and decodes each result tag", () => {
    const decision = vi.spyOn(kernel, "disclosure");
    // Each argument has a distinct, nonconstant bit pattern across these probes.
    // This catches ABI permutations without re-enumerating the proved policy.
    const probes: { inputs: Parameters<typeof disclosureDecision>; tag: ReturnType<typeof disclosureDecision> }[] = [
      { inputs: [false, true, true, true, false], tag: "D" },
      { inputs: [true, false, true, false, false], tag: "S" },
      { inputs: [true, false, false, true, true], tag: "R" },
    ];
    for (const { inputs, tag } of probes) expect(disclosureDecision(...inputs)).toBe(tag);
    expect(decision.mock.calls).toEqual(probes.map(({ inputs }) => inputs));
  });

  it("preserves exact count ABI at zero, practical sizes and the backend limit", () => {
    // Numeric boundaries, not a Cartesian re-test of the accounting laws.
    const probes = [
      [0, BEND_NAT_MAX, 0, 0],
      [BEND_NAT_MAX, 0, 0, BEND_NAT_MAX],
      [100_000, 400, 400, 99_600],
      [2 ** 32, BEND_NAT_MAX, 2 ** 32, 0],
      [BEND_NAT_MAX, BEND_NAT_MAX, BEND_NAT_MAX, 0],
    ] as const;
    for (const [total, request, shown, remaining] of probes) {
      expect(shownCount(total, request)).toBe(shown);
      expect(remainingCount(total, request)).toBe(remaining);
    }
  });

  it("rejects non-natural and backend-overflow numeric inputs before execution", () => {
    const run = vi.spyOn(kernel, "shownCount");
    for (const bad of [-1, 0.5, NaN, Infinity, -Infinity, BEND_NAT_MAX + 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => shownCount(bad, 1)).toThrow(RangeError);
      expect(() => shownCount(1, bad)).toThrow(RangeError);
      expect(() => remainingCount(1, bad)).toThrow(RangeError);
      expect(() => nextBasisStep(1, bad)).toThrow(RangeError);
    }
    expect(run).not.toHaveBeenCalled();
    expect(() => disclosureDecision(1 as unknown as boolean, false, false, false, false)).toThrow(TypeError);
  });

  it("decodes exact predecessor commands without overflowing backend naturals", () => {
    expect(nextBasisStep(0, 10)).toEqual({ $: "Empty" });
    expect(nextBasisStep(1, 0)).toEqual({ $: "Done" });
    expect(nextBasisStep(1, 1)).toEqual({ $: "First" });
    // Only the minimum recurrence and maximum backend index need codec probes.
    for (const have of [2, BEND_NAT_MAX]) {
      expect(nextBasisStep(have, have)).toEqual({ $: "Next", at: have, previous: have - 1, older: have - 2 });
    }
  });

  it("production renderer decisions and count outputs call the generated kernel", () => {
    const decision = vi.spyOn(kernel, "disclosure");
    const shown = vi.spyOn(kernel, "shownCount");
    const remaining = vi.spyOn(kernel, "remainingCount");
    const fit = revealFoveated(graph(), new Float64Array([1]), { budget: 1000, header: "t" });
    expect(fit.revealedIds).toEqual(["a"]);
    expect(decision).toHaveBeenCalledWith(true, false, false, false, false);
    expect(shown).toHaveBeenCalledWith(1n, 1n);
    expect(remaining).toHaveBeenCalledWith(1n, 1n);
    shown.mockClear();
    revealGroups([{ label: "a", detail: "a()", mass: 1 }], { budget: 1000, header: "t" });
    expect(shown).toHaveBeenCalledWith(1n, 1n);
  });

  it("the heat engine executes each generated order command and then stops", () => {
    const step = vi.spyOn(kernel, "basisStep");
    const basis = chebyshevVectors(buildCsr(graph()), new Float64Array([1]), 3);
    expect(basis).toHaveLength(4);
    expect(step.mock.calls).toEqual([[1n, 3n], [2n, 3n], [3n, 3n], [4n, 3n]]);
  });
});
