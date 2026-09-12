import { describe, expect, it } from "vitest";
import { assembleFactGraph, diffuseMass, SUBSTRATE_VERSION, type SnapshotFacts } from "../src/substrate.js";
import { buildCsr, forwardHeat } from "../src/core/heat.js";

const fact = (file: string, spec?: string): SnapshotFacts => ({ sha1: file, symbols: [], calls: [], literals: [], anchors: [], imports: spec ? [{ file, spec, line: 1 }] : [] });

describe("snapshot substrate v1", () => {
  it("assembles supplied facts without discovering the current repository", async () => {
    const graph = await assembleFactGraph(new Map([["a.ts", fact("a.ts", "./b.js")], ["b.ts", fact("b.ts")], ["alone.ts", fact("alone.ts")]]));
    expect(SUBSTRATE_VERSION).toBe(1);
    expect(graph.files).toEqual(["a.ts", "alone.ts", "b.ts"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.evidence?.strategy).toBe("relative-import");
    const source = new Float64Array([2, 3, 0]);
    for (const { time, mass } of diffuseMass(graph, source, [0, 0.5, 4, 16, 64])) {
      const reference = forwardHeat(buildCsr(graph), source, time);
      mass.forEach((value, i) => expect(value).toBeCloseTo(reference[i]!, 7));
      expect(mass.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 6);
      expect(mass[1]).toBe(3);
    }
    expect([...source]).toEqual([2, 3, 0]);
  });
  it("rejects invalid witnesses and numerical inputs", async () => {
    await expect(assembleFactGraph(new Map([["../escape.ts", fact("../escape.ts")]]))).rejects.toThrow("path");
    await expect(assembleFactGraph(new Map([["a.ts", fact("b.ts", "./c")]]))).rejects.toThrow("Witness");
    const graph = await assembleFactGraph(new Map([["a.ts", fact("a.ts")]]));
    expect(() => diffuseMass(graph, new Float64Array([-1]), [1])).toThrow("Mass");
    expect(() => diffuseMass(graph, new Float64Array([1]), [Infinity])).toThrow("scales");
  });
});
