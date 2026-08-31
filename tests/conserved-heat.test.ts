import { describe, expect, it } from "vitest";
import {
  buildCsr,
  excess,
  focusField,
  forwardHeat,
  taylorReference,
} from "../src/core/heat.js";
import type { Csr } from "../src/core/heat.js";
import type { Graph, NodeRec } from "../src/core/types.js";

const graphFromEdges = (n: number, edges: Array<[number, number, number]>): Graph => {
  const nodes: NodeRec[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}@f`, name: `n${i}`, kind: "function", file: "f", line: i + 1, sig: `n${i}`, lang: "t",
  }));
  return {
    nodes,
    edges: edges.map(([a, b, w]) => ({ a, b, w, kind: "invokes" })),
    byName: new Map(),
    byFile: new Map(),
    anchors: [],
    files: [],
  };
};

const sum = (xs: Float64Array): number => {
  let total = 0;
  for (const x of xs) total += x;
  return total;
};

const maxDifference = (a: Float64Array, b: Float64Array): number => {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
};

const forwardReference = (csr: Csr, a: Float64Array, t: number): Float64Array => {
  const seed = new Float64Array(csr.n);
  for (let i = 0; i < csr.n; i++) {
    if (csr.deg[i]! > 0) seed[i] = a[i]! / Math.sqrt(csr.deg[i]!);
  }
  const symmetric = taylorReference(csr, seed, t);
  const out = new Float64Array(csr.n);
  for (let i = 0; i < csr.n; i++) {
    out[i] = csr.deg[i]! > 0 ? Math.sqrt(csr.deg[i]!) * symmetric[i]! : a[i]!;
  }
  return out;
};

const focusReference = (csr: Csr, a: Float64Array, t: number): Float64Array => {
  const seed = new Float64Array(csr.n);
  for (let i = 0; i < csr.n; i++) {
    if (csr.deg[i]! > 0) seed[i] = Math.sqrt(csr.deg[i]!) * a[i]!;
  }
  const symmetric = taylorReference(csr, seed, t);
  const out = new Float64Array(csr.n);
  for (let i = 0; i < csr.n; i++) {
    out[i] = csr.deg[i]! > 0 ? symmetric[i]! / Math.sqrt(csr.deg[i]!) : a[i]!;
  }
  return out;
};

describe("degree-corrected conserved heat", () => {
  it("conserves forward mass at every diffusion time", () => {
    const csr = buildCsr(graphFromEdges(6, [
      [0, 1, 0.5], [1, 2, 2], [2, 3, 1.25], [3, 4, 3], [4, 5, 0.75], [1, 5, 0.4],
    ]));
    const a = Float64Array.from([1, 0, 0.25, 0, 1, 0]);
    for (const t of [0, 0.5, 2, 8, 32]) {
      expect(sum(forwardHeat(csr, a, t))).toBeCloseTo(sum(a), 8);
    }
  });

  it("converges to degree-proportional stationary mass", () => {
    const csr = buildCsr(graphFromEdges(4, [
      [0, 1, 1], [1, 2, 3], [2, 3, 2],
    ]));
    const a = Float64Array.from([1, 0, 0, 1]);
    const got = forwardHeat(csr, a, 64);
    const totalDegree = sum(csr.deg);
    for (let i = 0; i < csr.n; i++) {
      expect(got[i]!).toBeCloseTo(sum(a) * csr.deg[i]! / totalDegree, 7);
    }
  });

  it("has the analytic forward and focus behavior on a star", () => {
    const leaves = 5;
    const edges: Array<[number, number, number]> = [];
    for (let leaf = 1; leaf <= leaves; leaf++) edges.push([0, leaf, 1]);
    const csr = buildCsr(graphFromEdges(leaves + 1, edges));
    const a = new Float64Array(leaves + 1);
    a[0] = 1;
    const t = 0.7;
    const decay = Math.exp(-2 * t);

    const p = forwardHeat(csr, a, t);
    expect(p[0]!).toBeCloseTo((1 + decay) / 2, 9);
    for (let leaf = 1; leaf <= leaves; leaf++) {
      expect(p[leaf]!).toBeCloseTo((1 - decay) / (2 * leaves), 9);
    }

    const f = focusField(csr, a, t);
    expect(f[0]!).toBeCloseTo((1 + decay) / 2, 9);
    for (let leaf = 1; leaf <= leaves; leaf++) {
      expect(f[leaf]!).toBeCloseTo((1 - decay) / 2, 9);
    }
    const ranked = excess(f, csr.deg);
    expect(ranked[0]!).toBeCloseTo(decay / 2, 9);
    for (let leaf = 1; leaf <= leaves; leaf++) expect(ranked[leaf]!).toBe(0);
  });

  it("retains mass and focus on isolated singleton components", () => {
    const csr = buildCsr(graphFromEdges(4, [[0, 1, 1]]));
    const a = Float64Array.from([1, 0, 2, 0.5]);
    for (const t of [0, 1, 16, 64]) {
      const p = forwardHeat(csr, a, t);
      const f = focusField(csr, a, t);
      expect(p[2]).toBe(2);
      expect(p[3]).toBe(0.5);
      expect(f[2]).toBe(2);
      expect(f[3]).toBe(0.5);
      expect(sum(p)).toBeCloseTo(sum(a), 9);
    }
    expect(Array.from(excess(Float64Array.from([2, 0.5]), new Float64Array(2)))).toEqual([0, 0]);
  });

  it("matches the independent scaled-Taylor reference", () => {
    const csr = buildCsr(graphFromEdges(9, [
      [0, 1, 0.4], [1, 2, 1.7], [2, 3, 0.8], [3, 4, 2.2], [4, 5, 0.3],
      [5, 6, 1.1], [6, 7, 0.9], [7, 8, 1.4], [0, 5, 0.6], [1, 7, 1.3], [2, 8, 0.5],
    ]));
    const a = Float64Array.from([1, 0, 0.25, 0, 0, 1, 0, 0.5, 0]);
    for (const t of [0.5, 2, 8, 16]) {
      expect(maxDifference(forwardHeat(csr, a, t), forwardReference(csr, a, t))).toBeLessThan(1e-8);
      expect(maxDifference(focusField(csr, a, t), focusReference(csr, a, t))).toBeLessThan(1e-8);
    }
  });
});
