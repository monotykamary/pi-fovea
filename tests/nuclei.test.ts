import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffHunks,
  MAX_DIFF_HUNKS_PER_FILE,
  parseZeroContextDiff,
} from "../src/core/git.js";
import { buildCsr, chebyshevVectors, chooseOrder, heatField } from "../src/core/heat.js";
import { impact, type OpResult } from "../src/core/ops.js";
import type { RepoState } from "../src/core/state.js";
import type { Edge, Graph, NodeRec } from "../src/core/types.js";

interface SourceSpec {
  file: string;
  symbols: Array<{ name: string; line: number }>;
}

interface SeedProbeHarness {
  state: RepoState;
  normalizedMass: (result: OpResult, file: string, symbol?: string) => number;
}

const keyFor = (file: string, symbol?: string): string => `${file}\0${symbol ?? "<file>"}`;

// Each possible source nucleus gets an identical, disconnected two-node edge
// to a probe file. Heat arriving at that probe is therefore a fixed linear
// multiple of the exact input seed weight, letting the tests observe impact's
// private Float64Array without adding diagnostics to the public OpResult.
const makeSeedProbeHarness = (root: string, specs: SourceSpec[]): SeedProbeHarness => {
  const nodes: NodeRec[] = [];
  const edges: Edge[] = [];
  const byFile = new Map<string, number[]>();
  const sourceNodes: Array<{ key: string; index: number }> = [];

  const addSource = (node: NodeRec, key: string): void => {
    const index = nodes.length;
    nodes.push(node);
    (byFile.get(node.file) ?? byFile.set(node.file, []).get(node.file)!).push(index);
    sourceNodes.push({ key, index });
  };

  for (const spec of specs) {
    addSource({
      id: `file:${spec.file}`,
      name: basename(spec.file),
      kind: "file",
      file: spec.file,
      line: 0,
      sig: spec.file,
      lang: "TypeScript",
    }, keyFor(spec.file));
    for (const symbol of spec.symbols) {
      addSource({
        id: `${symbol.name}@${spec.file}`,
        name: symbol.name,
        kind: "function",
        file: spec.file,
        line: symbol.line,
        sig: `function ${symbol.name}()`,
        lang: "TypeScript",
      }, keyFor(spec.file, symbol.name));
    }
  }

  const probeFiles = new Map<string, string>();
  const probeNodes = new Map<string, number>();
  for (let i = 0; i < sourceNodes.length; i++) {
    const source = sourceNodes[i]!;
    const probeFile = `probes/${i}.ts`;
    const probe = nodes.length;
    nodes.push({
      id: `file:${probeFile}`,
      name: `${i}.ts`,
      kind: "file",
      file: probeFile,
      line: 0,
      sig: probeFile,
      lang: "TypeScript",
    });
    byFile.set(probeFile, [probe]);
    edges.push({ a: source.index, b: probe, kind: "imports", w: 1 });
    probeFiles.set(source.key, probeFile);
    probeNodes.set(source.key, probe);
  }

  const graph: Graph = {
    nodes,
    edges,
    byName: new Map(),
    byFile,
    anchors: [],
    files: [...specs.map((spec) => spec.file), ...probeFiles.values()],
  };
  const csr = buildCsr(graph);
  const adjacency: RepoState["adjacency"] = new Map();
  for (const edge of edges) {
    (adjacency.get(edge.a) ?? adjacency.set(edge.a, []).get(edge.a)!).push({
      to: edge.b,
      kind: edge.kind,
      w: edge.w,
    });
    (adjacency.get(edge.b) ?? adjacency.set(edge.b, []).get(edge.b)!).push({
      to: edge.a,
      kind: edge.kind,
      w: edge.w,
    });
  }
  const state: RepoState = {
    root,
    version: "nuclei-test",
    graph,
    csr,
    joinIndex: { byKey: new Map(), edges: [] },
    facts: {},
    extraction: { failed: [], unreadable: [], oversized: [], generated: [] },
    adjacency,
    store: {} as RepoState["store"],
    files: graph.files,
    gitKind: "git",
    head: undefined,
    probedAt: 0,
    walkedAt: 0,
    sweptAt: 0,
    dirty: new Set(),
    history: new Map(),
  };

  const transfers = new Map<string, number>();
  for (const source of sourceNodes) {
    const seed = new Float64Array(nodes.length);
    seed[source.index] = 1;
    const field = heatField(chebyshevVectors(csr, seed, chooseOrder(4)), 4, nodes.length);
    transfers.set(source.key, field[probeNodes.get(source.key)!]!);
  }

  return {
    state,
    normalizedMass: (result, file, symbol) => {
      const key = keyFor(file, symbol);
      const warmed = result.details.warmedMass as Record<string, number>;
      return (warmed[probeFiles.get(key)!] ?? 0) / transfers.get(key)!;
    },
  };
};

const git = (root: string, args: string[]): void => {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
};

const repoWith = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "fovea-nuclei-"));
  git(root, ["init", "-q", "-b", "main"]);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]);
  return root;
};

const moduleText = (alpha: string, betaLine: string, betaReturn = "  return value;"): string => [
  "// module",
  "function alpha() {",
  `  return \"${alpha}\";`,
  "}",
  "",
  "function beta() {",
  `  const value = \"${betaLine}\";`,
  betaReturn,
  "}",
  "",
].join("\n");

describe("mass-conserving impact hunk nuclei", () => {
  it("concentrates a single-line edit on its enclosing symbol", async () => {
    const file = "source.ts";
    const root = repoWith({ [file]: moduleText("alpha", "before") });
    try {
      writeFileSync(join(root, file), moduleText("alpha", "after"), "utf8");
      const parsed = await diffHunks(root);
      expect(parsed?.get(file)).toEqual({
        hunks: [{ newStart: 7, newLines: 1 }],
        fallback: false,
      });

      const harness = makeSeedProbeHarness(root, [{
        file,
        symbols: [{ name: "alpha", line: 2 }, { name: "beta", line: 6 }],
      }]);
      const result = await impact(root, { files: [file], budget: 4000 }, harness.state);
      const fileMass = harness.normalizedMass(result, file);
      const alphaMass = harness.normalizedMass(result, file, "alpha");
      const betaMass = harness.normalizedMass(result, file, "beta");

      expect(fileMass).toBeCloseTo(0.2, 5);
      expect(alphaMass).toBe(0);
      expect(betaMass).toBeCloseTo(0.8, 5);
      expect(betaMass).toBeGreaterThan(alphaMass); // top seed-file symbol by mass
      expect(fileMass + alphaMass + betaMass).toBeCloseTo(1, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("weights multiple hunks by sqrt(lines) and normalizes every changed file to one", async () => {
    const first = "first.ts";
    const second = "second.ts";
    const root = repoWith({
      [first]: moduleText("alpha-before", "beta-before"),
      [second]: moduleText("gamma-before", "delta"),
    });
    try {
      writeFileSync(join(root, first), moduleText("alpha-after", "beta-after", "  return value + \"!\";"), "utf8");
      writeFileSync(join(root, second), moduleText("gamma-after", "delta"), "utf8");
      const parsed = await diffHunks(root);
      expect(parsed?.get(first)?.fallback).toBe(false);
      expect(parsed?.get(first)?.hunks.map((hunk) => hunk.newLines)).toEqual([1, 2]);

      const harness = makeSeedProbeHarness(root, [
        { file: first, symbols: [{ name: "alpha", line: 2 }, { name: "beta", line: 6 }] },
        { file: second, symbols: [{ name: "gamma", line: 2 }, { name: "delta", line: 6 }] },
      ]);
      const result = await impact(root, {
        files: [first, second],
        budget: 4000,
      }, harness.state);

      const alphaMass = harness.normalizedMass(result, first, "alpha");
      const betaMass = harness.normalizedMass(result, first, "beta");
      const firstFileMass = harness.normalizedMass(result, first);
      const sqrtTwo = Math.sqrt(2);
      expect(firstFileMass).toBeCloseTo(0.2, 5);
      expect(alphaMass).toBeCloseTo(0.8 / (1 + sqrtTwo), 5);
      expect(betaMass).toBeCloseTo(0.8 * sqrtTwo / (1 + sqrtTwo), 5);
      expect(firstFileMass + alphaMass + betaMass).toBeCloseTo(1, 5);

      const secondFileMass = harness.normalizedMass(result, second);
      const gammaMass = harness.normalizedMass(result, second, "gamma");
      const deltaMass = harness.normalizedMass(result, second, "delta");
      expect(secondFileMass).toBeCloseTo(0.2, 5);
      expect(gammaMass).toBeCloseTo(0.8, 5);
      expect(deltaMass).toBe(0);
      expect(secondFileMass + gammaMass + deltaMass).toBeCloseTo(1, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the file node for a renamed file with shifted lines", async () => {
    const oldFile = "old.ts";
    const movedFile = "moved.ts";
    const root = repoWith({ [oldFile]: moduleText("alpha", "beta") });
    try {
      renameSync(join(root, oldFile), join(root, movedFile));
      writeFileSync(join(root, movedFile), `// shifted\n// shifted again\n${moduleText("alpha", "beta")}`, "utf8");
      git(root, ["add", "-A"]); // staged rename; unstaged targets are untracked and intentionally coarse
      const parsed = await diffHunks(root);
      expect(parsed?.get(movedFile)?.fallback).toBe(true);

      const harness = makeSeedProbeHarness(root, [{
        file: movedFile,
        symbols: [{ name: "alpha", line: 4 }, { name: "beta", line: 8 }],
      }]);
      const result = await impact(root, {
        files: [movedFile],
        budget: 4000,
      }, harness.state);
      expect(harness.normalizedMass(result, movedFile)).toBeCloseTo(1, 5);
      expect(harness.normalizedMass(result, movedFile, "alpha")).toBe(0);
      expect(harness.normalizedMass(result, movedFile, "beta")).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds oversized per-file diffs and falls back without partial symbol seeds", async () => {
    const file = "large.ts";
    const before = Array.from({ length: 2 * MAX_DIFF_HUNKS_PER_FILE + 3 }, (_, i) => `line-${i}: before`).join("\n");
    const after = Array.from({ length: 2 * MAX_DIFF_HUNKS_PER_FILE + 3 }, (_, i) =>
      i % 2 === 0 ? `line-${i}: after` : `line-${i}: before`).join("\n");
    const root = repoWith({ [file]: before });
    try {
      writeFileSync(join(root, file), after, "utf8");
      const parsed = await diffHunks(root);
      expect(parsed?.get(file)).toEqual({ hunks: [], fallback: true });

      const harness = makeSeedProbeHarness(root, [{
        file,
        symbols: [{ name: "wholeFileSymbol", line: 1 }],
      }]);
      const result = await impact(root, { files: [file], budget: 4000 }, harness.state);
      expect(harness.normalizedMass(result, file)).toBeCloseTo(1, 5);
      expect(harness.normalizedMass(result, file, "wholeFileSymbol")).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks malformed, new, deleted, and binary sections coarse", () => {
    const patch = [
      "diff --git a/bad.ts b/bad.ts",
      "--- a/bad.ts",
      "+++ b/bad.ts",
      "@@ not-a-range @@",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/blob.bin b/blob.bin",
      "Binary files a/blob.bin and b/blob.bin differ",
      "",
    ].join("\n");
    const parsed = parseZeroContextDiff(patch);
    expect(parsed.get("bad.ts")?.fallback).toBe(true);
    expect(parsed.get("new.ts")?.fallback).toBe(true);
    expect(parsed.get("gone.ts")?.fallback).toBe(true);
    expect(parsed.get("blob.bin")?.fallback).toBe(true);
  });
});
