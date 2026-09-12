// Renderer unit tests: budget hardness under a huge glow periphery, tier
// boundaries, and the delta disclosure bookkeeping.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { revealFoveated, revealGroups, tokenEstimate, type GroupLine } from "../src/core/render.js";
import { buildCsr, heatAt } from "../src/core/heat.js";
import type { Graph, NodeRec } from "../src/core/types.js";

// One hub symbol fanning out to many files: after diffusion the hub is hot,
// a handful of neighbours warm, and the long tail collapses to glow lines.
const fanGraph = (files: number): Graph => {
  const nodes: NodeRec[] = [{ id: "hub@src/hub.ts", name: "hub", kind: "function", file: "src/hub.ts", line: 1, sig: "export function hub()", lang: "TypeScript" }];
  const edges: Graph["edges"] = [];
  for (let f = 0; f < files; f++) {
    const file = `src/mod${f}.ts`;
    nodes.push({ id: `file:${file}`, name: `mod${f}.ts`, kind: "file", file, line: 0, sig: file, lang: "TypeScript" });
    for (let s = 0; s < 3; s++) {
      const idx = nodes.length;
      nodes.push({ id: `helper${s}@${file}`, name: `helper${s}Mod${f}`, kind: "function", file, line: 3 + s, sig: `function helper${s}Mod${f}() { ... }`, lang: "TypeScript" });
      edges.push({ a: 0, b: idx, kind: "invokes", w: f < 3 ? 0.8 : 0.25 });
    }
  }
  return { nodes, edges, byName: new Map(), byFile: new Map(), anchors: [], files: [] };
};

describe("revealFoveated", () => {
  for (const files of [8, 40, 90]) {
    for (const B of [300, 800, 2000]) {
      it(`never exceeds budget (${files} files, B=${B})`, () => {
        const g = fanGraph(files);
        const csr = buildCsr(g);
        const s = new Float64Array(g.nodes.length);
        s[0] = 1;
        const field = heatAt(csr, s, 3);
        const fit = revealFoveated(g, field, { header: "t", budget: B });
        expect(fit.tokens).toBeLessThanOrEqual(B);
        expect(tokenEstimate(fit.text)).toBeLessThanOrEqual(B);
      });
    }
  }

  it("renders the hot hub with its signature and marks warmer tiers", () => {
    const g = fanGraph(10);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const fit = revealFoveated(g, heatAt(csr, s, 2), { header: "t", budget: 4000 });
    expect(fit.text).toContain("▲ src/hub.ts:1  export function hub()");
    expect(fit.revealedIds).toContain("hub@src/hub.ts");
  });


  it("labels direct graph relationships from the focus", () => {
    const nodes: NodeRec[] = [
      { id: "focus@src/focus.ts", name: "focus", kind: "function", file: "src/focus.ts", line: 5, sig: "function focus()", lang: "TypeScript" },
      { id: "callee@src/callee.ts", name: "callee", kind: "function", file: "src/callee.ts", line: 10, sig: "function callee()", lang: "TypeScript" },
      { id: "caller@src/caller.ts", name: "caller", kind: "function", file: "src/caller.ts", line: 20, sig: "function caller()", lang: "TypeScript" },
    ];
    const g: Graph = {
      nodes,
      edges: [
        { a: 0, b: 1, kind: "invokes", w: 0.7 },
        { a: 2, b: 0, kind: "invokes", w: 0.7 },
      ],
      byName: new Map(),
      byFile: new Map(),
      anchors: [],
      files: [],
    };
    const fit = revealFoveated(g, new Float64Array([1, 0.005, 0.005]), {
      header: "t",
      budget: 1000,
      seeds: [0],
    });
    expect(fit.text).toContain("→ callee  callee");
    expect(fit.text).toContain("← caller  caller");
  });


  it("keeps a structured focus nucleus while suppressing seen periphery", () => {
    const nodes: NodeRec[] = [
      { id: "focus@src/a.ts", name: "focus", kind: "function", file: "src/a.ts", line: 1, sig: "focus()", lang: "TypeScript" },
      { id: "caller@src/b.ts", name: "caller", kind: "function", file: "src/b.ts", line: 2, sig: "caller()", lang: "TypeScript" },
      { id: "warm@src/c.ts", name: "warm", kind: "function", file: "src/c.ts", line: 3, sig: "warm()", lang: "TypeScript" },
    ];
    const g: Graph = {
      nodes,
      edges: [{ a: 1, b: 0, kind: "invokes", w: 0.7 }],
      byName: new Map(),
      byFile: new Map(),
      anchors: [],
      files: [],
    };
    const field = new Float64Array([1, 0.1, 0.1]);
    const first = revealFoveated(g, field, { header: "t", budget: 1000, seeds: [0], repeatNucleus: true });
    const second = revealFoveated(g, field, {
      header: "t",
      budget: 1000,
      seeds: [0],
      repeatNucleus: true,
      disclosed: new Set(first.revealedIds),
    });
    expect(second.revealedIds).toContain("focus@src/a.ts");
    expect(second.revealedIds).toContain("caller@src/b.ts");
    expect(second.revealedIds).not.toContain("warm@src/c.ts");
    expect(second.revealed.find((node) => node.id === "caller@src/b.ts")).toMatchObject({
      role: "direct",
      relation: "← caller",
      seedId: "focus@src/a.ts",
    });
    expect(second.suppressed).toBe(1);
  });

  it("collapses anonymous warm siblings instead of flooding one file", () => {
    const nodes: NodeRec[] = [
      { id: "focus@src/large.ts", name: "focus", kind: "method", file: "src/large.ts", line: 10, sig: "focus()", lang: "TypeScript" },
    ];
    for (let i = 0; i < 10; i++) {
      nodes.push({ id: `sibling${i}@src/large.ts`, name: `sibling${i}`, kind: "method", file: "src/large.ts", line: 20 + i, sig: `sibling${i}()`, lang: "TypeScript" });
    }
    const g: Graph = { nodes, edges: [], byName: new Map(), byFile: new Map(), anchors: [], files: [] };
    const fit = revealFoveated(g, new Float64Array([1, ...Array(10).fill(0.1)]), {
      header: "t",
      budget: 2000,
      seeds: [0],
    });
    expect(fit.text.match(/^  · sibling/gm)).toHaveLength(4);
    expect(fit.text).toContain("~ +6 more in src/large.ts");
  });

  it("never presents a legacy parent line as an exact member location", () => {
    const node: NodeRec = {
      id: "Client.connect@src/client.ts",
      name: "Client.connect",
      kind: "method",
      file: "src/client.ts",
      line: 86,
      lineApproximate: true,
      sig: "method Client.connect",
      lang: "TypeScript",
    };
    const g: Graph = { nodes: [node], edges: [], byName: new Map(), byFile: new Map(), anchors: [], files: [] };
    const fit = revealFoveated(g, new Float64Array([1]), { header: "t", budget: 500, seeds: [0] });
    expect(fit.text).toContain("src/client.ts (member line unavailable)");
    expect(fit.text).not.toContain("src/client.ts:86");
  });

  it("disclosed nodes are suppressed from later reveals (delta bookkeeping)", () => {
    const g = fanGraph(10);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const field = heatAt(csr, s, 2);
    const first = revealFoveated(g, field, { header: "t", budget: 4000 });
    const second = revealFoveated(g, field, { header: "t", budget: 4000, disclosed: new Set(first.revealedIds) });
    expect(second.suppressed).toBe(first.revealedIds.length);
    for (const id of first.revealedIds) expect(second.revealedIds).not.toContain(id);
  });

  it("extreme budgets degrade to header-only instead of overspending", () => {
    const g = fanGraph(120);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const fit = revealFoveated(g, heatAt(csr, s, 3), { header: "fovea focus x", budget: 256 });
    expect(fit.tokens).toBeLessThanOrEqual(256);
    expect(fit.text).toContain("more results collapsed"); // periphery was truncated, budget intact
    expect(fit.truncated).toBe(true);
  });
});

describe("overflow artifacts", () => {
  it("keeps every eligible node in overflow even when the display cap alone truncates", () => {
    const g = fanGraph(150);
    const field = new Float64Array(g.nodes.length).fill(1);
    const path = join(tmpdir(), "pi-fovea-test-candidate-cap.txt");
    const fit = revealFoveated(g, field, { header: "all", budget: 16000, overflowTo: path });
    expect(fit.litTotal).toBe(g.nodes.length);
    expect(fit.candidateOmitted).toBe(g.nodes.length - 400);
    expect(fit.truncated).toBe(true);
    expect(fit.tokens).toBeLessThanOrEqual(16000);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(g.nodes.length + 1);
    expect(lines.join("\n")).toContain("helper2Mod149");
  });

  it("reports cap loss even without a writable artifact, including a zero display cap", () => {
    const g = fanGraph(3);
    const fit = revealFoveated(g, new Float64Array(g.nodes.length).fill(1), {
      header: "all", budget: 256, maxCandidates: 0,
      overflowTo: join(tmpdir(), "pi-fovea-no-such-directory", "overflow.txt"),
    });
    expect(fit.litTotal).toBe(g.nodes.length);
    expect(fit.candidateOmitted).toBe(g.nodes.length);
    expect(fit.truncated).toBe(true);
    expect(fit.overflowPath).toBeUndefined();
    expect(fit.text).toContain(`${g.nodes.length} more results`);
    expect(fit.text).not.toContain("full list saved");
    expect(fit.tokens).toBeLessThanOrEqual(256);
  });

  it("keeps scope, exclusions, and disclosure filtering ahead of complete overflow", () => {
    const g = fanGraph(3);
    const include = new Set(g.nodes.slice(0, 8).map((node) => node.id));
    const excluded = g.nodes[2]!.id;
    const disclosed = g.nodes[3]!.id;
    const path = join(tmpdir(), "pi-fovea-test-filtered-cap.txt");
    const fit = revealFoveated(g, new Float64Array(g.nodes.length).fill(1), {
      header: "filtered", budget: 256, maxCandidates: 1, overflowTo: path,
      include, exclude: new Set([excluded]), disclosed: new Set([disclosed]),
    });
    expect(fit.litTotal).toBe(6);
    expect(fit.candidateOmitted).toBe(5);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(7);
    expect(fit.suppressed).toBe(1);
  });


  it("spills the full foveated list to a tmp file and names it in the footer", () => {
    const g = fanGraph(90);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const field = heatAt(csr, s, 3);
    const path = join(tmpdir(), "pi-fovea-test-overflow.txt");

    const fit = revealFoveated(g, field, { header: "t", budget: 300, overflowTo: path });

    expect(fit.truncated).toBe(true);
    expect(fit.overflowPath).toBe(path);
    expect(fit.tokens).toBeLessThanOrEqual(300);
    expect(fit.text).toContain(`full list saved to ${path}`);
    expect(fit.text).toContain("fovea_dwell"); // semantic-widen hint survives
    const artifact = readFileSync(path, "utf8");
    // The deep-tail periphery is in the file but not in the budgeted prefix.
    expect(artifact).toContain("helper0Mod89");
    expect(fit.text).not.toContain("helper0Mod89");
  });

  it("spills group overflow for sketch/impact renders", () => {
    const groups: GroupLine[] = Array.from({ length: 60 }, (_, i) => ({
      label: `d${i}`,
      mass: 60 - i,
      detail: `${i} files · top: x${i}`,
    }));
    const path = join(tmpdir(), "pi-fovea-test-groups-overflow.txt");

    const fit = revealGroups(groups, { header: "t", budget: 300, overflowTo: path });

    expect(fit.truncated).toBe(true);
    expect(fit.overflowPath).toBe(path);
    expect(fit.tokens).toBeLessThanOrEqual(300);
    const artifact = readFileSync(path, "utf8");
    expect(artifact).toContain("d59");
    expect(fit.text).not.toContain("d59");
  });

  it("writes the artifact when only the glow periphery overflows", () => {
    // hub -> mid -> ten warm siblings in one file: only the first four render
    // individually, the rest collapse to a glow line. The prefix fits the
    // budget untouched, so only the footer knows anything was omitted — and
    // the artifact must exist and hold those nodes as real entries.
    const nodes: NodeRec[] = [
      { id: "hub@src/hub.ts", name: "hub", kind: "function", file: "src/hub.ts", line: 1, sig: "export function hub()", lang: "TypeScript" },
      { id: "mid@src/mid.ts", name: "mid", kind: "function", file: "src/mid.ts", line: 1, sig: "export function mid()", lang: "TypeScript" },
      { id: "file:src/big.ts", name: "big.ts", kind: "file", file: "src/big.ts", line: 0, sig: "src/big.ts", lang: "TypeScript" },
    ];
    const edges: Graph["edges"] = [{ a: 0, b: 1, kind: "invokes", w: 0.9 }];
    for (let j = 0; j < 10; j++) {
      const idx = nodes.length;
      nodes.push({ id: `helper${j}@src/big.ts`, name: `helper${j}`, kind: "function", file: "src/big.ts", line: 3 + j, sig: `function helper${j}() {}`, lang: "TypeScript" });
      edges.push({ a: 1, b: idx, kind: "invokes", w: 0.9 });
    }
    const g: Graph = { nodes, edges, byName: new Map(), byFile: new Map(), anchors: [], files: [] };
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const path = join(tmpdir(), "pi-fovea-test-collapsed-overflow.txt");

    const fit = revealFoveated(g, heatAt(csr, s, 2), { header: "t", budget: 4000, overflowTo: path });

    expect(fit.text).toContain(`full list saved to ${path}`);
    expect(fit.truncated).toBe(true);
    expect(fit.overflowPath).toBe(path);
    const artifact = readFileSync(path, "utf8");
    expect(artifact).toContain("helper9");
    expect(fit.text).not.toContain("helper9");
  });

  it("leaves non-overflowing fits and footer wording alone", () => {
    const g = fanGraph(8);
    const csr = buildCsr(g);
    const s = new Float64Array(g.nodes.length);
    s[0] = 1;
    const path = join(tmpdir(), "pi-fovea-test-nooverflow.txt");

    const fit = revealFoveated(g, heatAt(csr, s, 2), { header: "t", budget: 4000, overflowTo: path });

    expect(fit.truncated).toBe(false);
    expect(fit.overflowPath).toBeUndefined();
    expect(fit.text).not.toContain("full list saved");
  });
});
