// Diffusion core validation: Chebyshev heat evaluation must match an
// independent Taylor-series implementation on random graphs, plus invariants
// (heat-kernel positivity, Bessel values).

import { describe, expect, it } from "vitest";
import { besselI, buildCsr, chebyshevVectors, chooseOrder, extendChebyshevVectors, heatField, heatAt, taylorReference, type Csr } from "../src/core/heat.js";
import type { Graph, NodeRec } from "../src/core/types.js";

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomGraph = (n: number, p: number, seed: number): Graph => {
  const rnd = mulberry32(seed);
  const nodes: NodeRec[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}@f${i % 5}`, name: `n${i}`, kind: "function", file: `f${i % 5}`, line: i, sig: `n${i}`, lang: "t",
  }));
  const edges: Graph["edges"] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < p) edges.push({ a: i, b: j, kind: "invokes", w: 0.2 + rnd() });
    }
  }
  return { nodes, edges, byName: new Map(), byFile: new Map(), anchors: [], files: [] };
};

// Frozen pre-optimization recurrence: exact parity is separate from the
// independent scaled-Taylor accuracy check below.
const legacyVectors = (csr: Csr, s: Float64Array, K: number): Float64Array[] => {
  const apply = (x: Float64Array) => {
    const inv = new Float64Array(csr.n);
    for (let i = 0; i < csr.n; i++) inv[i] = csr.deg[i]! > 0 ? 1 / Math.sqrt(csr.deg[i]!) : 0;
    const y = new Float64Array(csr.n);
    for (let i = 0; i < csr.n; i++) {
      let acc = 0;
      for (let p = csr.rowPtr[i]!; p < csr.rowPtr[i + 1]!; p++) acc += csr.w[p]! * inv[csr.col[p]!]! * x[csr.col[p]!]!;
      y[i] = -inv[i]! * acc;
    }
    return y;
  };
  const tk = [Float64Array.from(s)];
  if (K >= 1) tk[1] = apply(tk[0]!);
  for (let k = 2; k <= K; k++) {
    const mv = apply(tk[k - 1]!);
    const out = new Float64Array(csr.n);
    for (let i = 0; i < csr.n; i++) out[i] = 2 * mv[i]! - tk[k - 2]![i]!;
    tk[k] = out;
  }
  return tk;
};

describe("heat diffusion", () => {
  it("extends only missing orders and preserves exact recurrence prefixes", () => {
    for (const [n, p] of [[0, 0], [1, 0], [25, 0.2]]) {
      const csr = buildCsr(randomGraph(n!, p!, 7));
      const seed = Float64Array.from({ length: csr.n }, (_, i) => i % 2 ? 0 : 1);
      const basis = chebyshevVectors(csr, seed, 0);
      for (const order of [3, 21, 42, 98]) {
        const prefix = [...basis];
        expect(extendChebyshevVectors(csr, basis, order)).toBe(basis);
        prefix.forEach((vector, i) => expect(basis[i]).toBe(vector));
        expect(basis).toEqual(legacyVectors(csr, seed, order));
      }
      expect(extendChebyshevVectors(csr, basis, 2)).toBe(basis);
      expect(basis).toHaveLength(99);
    }
    expect(() => extendChebyshevVectors(buildCsr(randomGraph(0, 0, 1)), [], 2)).toThrow("empty Chebyshev basis");
  });

  it("demand-driven orders produce exactly the former eager heat fields", () => {
    const csr = buildCsr(randomGraph(36, 0.2, 9));
    const seed = Float64Array.from({ length: csr.n }, (_, i) => i === 2 ? 1 : 0);
    const full = chebyshevVectors(csr, seed, 98);
    for (const t of [0, 0.01, 0.5, 1.2, 2, 4, 8, 16, 24, 28, 32, 48, 64]) {
      expect(heatField(full.slice(0, chooseOrder(t) + 1), t, csr.n)).toEqual(heatField(full, t, csr.n));
    }
  });


  it("preserves every recurrence vector exactly, including empty and disconnected graphs", () => {
    for (const [n, p] of [[0, 0], [1, 0], [15, 0], [60, 0.08], [25, 1]]) {
      const csr = buildCsr(randomGraph(n!, p!, 42));
      const seed = Float64Array.from({ length: csr.n }, (_, i) => i % 3 === 0 ? 0.5 : 0);
      const before = seed.slice();
      for (const K of [0, 1, 2, 90]) {
        const got = chebyshevVectors(csr, seed, K);
        expect(got).toEqual(legacyVectors(csr, seed, K));
        expect(new Set(got.map((v) => v.buffer)).size).toBe(K + 1);
        expect(got[0]!.buffer).not.toBe(seed.buffer);
        const snapshot = got.map((v) => v.slice());
        for (const t of [0, 1, 8, 64]) heatField(got, t, csr.n);
        expect(got).toEqual(snapshot);
      }
      expect(seed).toEqual(before);
    }
  });

  it("does not retain normalization across CSR mutations or roots", () => {
    const csr = buildCsr(randomGraph(20, 0.2, 7));
    const seed = Float64Array.from({ length: csr.n }, (_, i) => i === 0 ? 1 : 0);
    const first = chebyshevVectors(csr, seed, 12);
    const snapshot = first.map((v) => v.slice());
    csr.deg[0]! *= 2;
    expect(chebyshevVectors(csr, seed, 12)).toEqual(legacyVectors(csr, seed, 12));
    const other = buildCsr(randomGraph(20, 0.2, 99));
    expect(chebyshevVectors(other, seed, 12)).toEqual(legacyVectors(other, seed, 12));
    expect(first).toEqual(snapshot);
  });
  it("besselI matches known values", () => {
    expect(besselI(0, 3)).toBeCloseTo(4.880792585865, 6);
    expect(besselI(1, 3)).toBeCloseTo(3.953370217403, 6);
    expect(besselI(5, 10)).toBeCloseTo(777.188286403, 3);
    expect(besselI(0, 0)).toBe(1);
    expect(besselI(3, 0)).toBe(0);
  });

  it("Chebyshev heat matches the Taylor reference at several times", () => {
    const g = randomGraph(60, 0.08, 42);
    const csr = buildCsr(g);
    const s = new Float64Array(60);
    s[7] = 1;
    s[23] = 0.5;
    for (const t of [0.5, 2, 8, 16]) {
      const got = heatAt(csr, s, t);
      const ref = taylorReference(csr, s, t);
      let maxDiff = 0;
      let maxRef = 0;
      for (let i = 0; i < 60; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(got[i]! - ref[i]!));
        maxRef = Math.max(maxRef, ref[i]!);
      }
      expect(maxRef).toBeGreaterThan(1e-6);
      expect(maxDiff).toBeLessThan(1e-8);
    }
  });

  it("heat fields are non-negative and the seed stays hottest at small t", () => {
    const g = randomGraph(40, 0.1, 7);
    const csr = buildCsr(g);
    const s = new Float64Array(40);
    s[3] = 1;
    const v = heatAt(csr, s, 1);
    for (const x of v) expect(x).toBeGreaterThanOrEqual(-1e-12);
    expect(v[3]!).toBeGreaterThan(0.3);
    // unreached isolated/seedless regions stay cold at small t
    let maxOther = 0;
    v.forEach((x, i) => { if (i !== 3) maxOther = Math.max(maxOther, x); });
    expect(maxOther).toBeLessThan(v[3]!);
  });

  it("dwell monotonicity: increasing t strictly widens the lit set", () => {
    const g = randomGraph(80, 0.05, 11);
    const csr = buildCsr(g);
    const s = new Float64Array(80);
    s[0] = 1;
    const lit = (t: number) => heatAt(csr, s, t).filter((x) => x > 0.02 * Math.max(...heatAt(csr, s, t))).length;
    expect(lit(1)).toBeLessThanOrEqual(lit(8));
  });
});
