import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { cachePathFor } from "../src/core/build.js";
import { ensureState, evictState, type RepoState } from "../src/core/state.js";
import { focus } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import { tokenEstimate, type RevealedNode } from "../src/core/render.js";

const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// ast-grep batches may finish in a different order on independent cold builds.
// Compare multisets, not completion order or opaque generation hashes. Keep
// ordered nodes intact because graph endpoints and CSR columns index them.
export const semanticSnapshot = (state: RepoState) => ({
  graph: { ...state.graph, edges: sorted(state.graph.edges), anchors: sorted(state.graph.anchors) },
  facts: Object.fromEntries(Object.entries(state.facts).map(([file, facts]) => [file,
    Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, Array.isArray(value) ? sorted(value) : value])),
  ])),
  extraction: state.extraction,
  discovery: state.discovery,
  degrees: state.csr.deg,
  operator: Array.from({ length: state.csr.n }, (_, row) => sorted(
    Array.from({ length: state.csr.rowPtr[row + 1]! - state.csr.rowPtr[row]! }, (_, offset) => {
      const p = state.csr.rowPtr[row]! + offset;
      return { col: state.csr.col[p], w: state.csr.w[p] };
    }),
  )),
  adjacency: new Map([...state.adjacency].map(([node, edges]) => [node, sorted(edges)])),
});

export const revealedIds = (result: Awaited<ReturnType<typeof focus>>, budget: number): Set<string> => {
  assert.equal(result.tokens, tokenEstimate(result.text), "reported token estimate drifted");
  assert.ok(result.tokens <= budget, `budget exceeded: ${result.tokens} > ${budget}`);
  assert.ok(Array.isArray(result.details.nodes), "focus must reveal structured nodes");
  return new Set((result.details.nodes as RevealedNode[]).map((node) => node.id));
};

export const distribution = (samples: number[]): string => {
  assert.ok(samples.length > 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.ceil(q * sorted.length) - 1]!.toFixed(2);
  return `median ${at(0.5)}ms · p95 ${at(0.95)}ms · n=${samples.length}`;
};

// All mutations happen in a disposable copy, never the benchmark's target repo.
// Timings are returned only after equivalence and independent fixture checks pass.
export const refreshProbe = async () => {
  const root = mkdtempSync(join(tmpdir(), "fovea-bench-refresh-"));
  const rows: Array<{ scenario: string; refreshMs: number; coldMs: number }> = [];
  try {
    cpSync(resolve(import.meta.dirname, "../tests/fixtures/mini"), root, { recursive: true });
    const file = join(root, "web/api.ts");
    const source = readFileSync(file, "utf8");
    let previous = await ensureState(root);
    assert.ok(previous.graph.nodes.some((node) => node.name === "loadUser"), "fixture extraction unavailable");
    const scenarios = [
      { name: "unchanged", edit: () => {}, symbol: "loadUser" },
      { name: "locations", edit: () => writeFileSync(file, `\n\n// location-only drift\n${source}`), symbol: "loadUser" },
      { name: "semantic", edit: () => writeFileSync(file, `${source}\nexport function benchmarkAdded() { return loadUser("1"); }\n`), symbol: "benchmarkAdded" },
      { name: "addition", edit: () => writeFileSync(join(root, "web/bench-added.ts"), 'import { loadUser } from "./api";\nexport function benchmarkCaller() { return loadUser("2"); }\n'), symbol: "benchmarkCaller" },
      { name: "deletion", edit: () => rmSync(join(root, "web/bench-added.ts")), symbol: "benchmarkAdded" },
    ];
    for (const scenario of scenarios) {
      scenario.edit();
      let t = performance.now();
      const incremental = await ensureState(root, { force: true });
      const refreshMs = performance.now() - t;
      assert.ok(incremental.graph.nodes.some((node) => node.name === scenario.symbol));
      if (scenario.name === "unchanged") assert.equal(incremental.generation, previous.generation);
      if (scenario.name === "semantic" || scenario.name === "addition" || scenario.name === "deletion") {
        assert.notEqual(incremental.generation, previous.generation);
      }
      if (scenario.name === "locations") {
        const line = (state: RepoState) => state.graph.nodes.find((node) => node.name === "loadUser" && node.file === "web/api.ts")!.line;
        assert.equal(line(incremental), line(previous) + 3, "location drift was not refreshed");
      }
      if (scenario.name === "addition") {
        const caller = incremental.graph.nodes.findIndex((node) => node.name === "benchmarkCaller");
        const callee = incremental.graph.nodes.findIndex((node) => node.name === "loadUser" && node.file === "web/api.ts");
        assert.ok(incremental.graph.edges.some((edge) => edge.kind === "invokes" && edge.a === caller && edge.b === callee && edge.evidence?.strategy === "imported-symbol"), "missing independently expected call evidence");
      }
      if (scenario.name === "deletion") assert.ok(!incremental.graph.nodes.some((node) => node.name === "benchmarkCaller"));
      resetSessions();
      const before = await focus(root, scenario.symbol, 1000);
      assert.ok(revealedIds(before, 1000).size > 0);
      evictState(root);
      rmSync(cachePathFor(root), { force: true });
      t = performance.now();
      const cold = await ensureState(root);
      const coldMs = performance.now() - t;
      assert.deepEqual(semanticSnapshot(incremental), semanticSnapshot(cold), `${scenario.name}: incremental != cold`);
      resetSessions();
      const after = await focus(root, scenario.symbol, 1000);
      // Cold extraction ordering can change opaque generation/version hashes.
      const navigation = ({ details: { generation, version, ...details }, ...rest }: typeof before) => ({ ...rest, details });
      assert.deepEqual(navigation(after), navigation(before), `${scenario.name}: navigation != cold`);
      rows.push({ scenario: scenario.name, refreshMs, coldMs });
      previous = cold;
    }
    return rows;
  } finally {
    evictState(root);
    resetSessions();
    rmSync(cachePathFor(root), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
};
