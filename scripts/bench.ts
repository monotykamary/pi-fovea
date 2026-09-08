// Developer-only rate–distortion and refresh benchmark. No timing gates in check.
// bun run bench [root] (default: ../pi-fabric)
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cachePathFor } from "../src/core/build.js";
import { ensureState, evictState, focus, dwell } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import { tokenEstimate } from "../src/core/render.js";
import { distribution, refreshProbe, revealedIds, semanticSnapshot } from "./bench-support.js";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "..", "pi-fabric"));
assert.ok(existsSync(root), `bench root not found: ${root}`);
const repeats = 3;
const refreshRows = [];
for (let i = 0; i < repeats; i++) refreshRows.push(...await refreshProbe());

// Refuse to time a cheaper workload caused by missing facts, evidence, or coverage.
rmSync(cachePathFor(root), { force: true });
let t0 = performance.now();
let state = await ensureState(root);
const coldMs = performance.now() - t0;
const cold = semanticSnapshot(state);
evictState(root);
t0 = performance.now();
state = await ensureState(root);
const warmMs = performance.now() - t0;
assert.deepEqual(semanticSnapshot(state), cold, "warm build differs from cold build");
const g = state.graph;
assert.ok(g.nodes.length > 0, "benchmark requires a nonempty graph");
const idle: number[] = [];
const sweep: number[] = [];
for (let i = 0; i < repeats; i++) {
  t0 = performance.now();
  await ensureState(root);
  idle.push(performance.now() - t0);
  t0 = performance.now();
  const swept = await ensureState(root, { force: true });
  sweep.push(performance.now() - t0);
  assert.deepEqual(semanticSnapshot(swept), cold, "unchanged sweep differs from cold build");
}

// Internal fidelity, NOT independently labeled relevance: compare structured
// node identities against a finite 16k response, never substring/name matches.
const queries = [...new Set(g.nodes.map((node, i) => ({ node, degree: state.csr.deg[i]! }))
  .filter(({ node }) => node.kind !== "file" && node.kind !== "anchor")
  .sort((a, b) => b.degree - a.degree)
  .map(({ node }) => node.name))].slice(0, 12);
assert.ok(queries.length > 0, "benchmark requires queryable symbols");
const outline = g.nodes.filter((node) => node.kind !== "file" && node.kind !== "anchor")
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  .map((node) => ({ id: node.id, text: `${node.file}:${node.line} ${node.sig}\n` }));
const lines: string[] = [];
for (const B of [500, 1000, 2000, 4000]) {
  let hits = 0, naiveHits = 0, total = 0, used = 0, naiveUsed = 0;
  const focusMs: number[] = [], dwellMs: number[] = [];
  for (const query of queries) {
    resetSessions();
    const reference = revealedIds(await focus(root, query, 16000), 16000);
    assert.ok(reference.size > 0, `empty reference for ${query}`);
    for (let repeat = 0; repeat < repeats; repeat++) {
      resetSessions();
      t0 = performance.now();
      const result = await focus(root, query, B);
      focusMs.push(performance.now() - t0);
      const got = revealedIds(result, B);
      // Spend no more than Fovea actually spent, and count only complete entries.
      const naive = new Set<string>();
      let text = "";
      for (const entry of outline) {
        if (tokenEstimate(text + entry.text) > result.tokens) break;
        text += entry.text;
        naive.add(entry.id);
      }
      used += result.tokens;
      naiveUsed += tokenEstimate(text);
      for (const id of reference) {
        total++;
        if (got.has(id)) hits++;
        if (naive.has(id)) naiveHits++;
      }
      t0 = performance.now();
      const wider = await dwell(root, 2, B);
      dwellMs.push(performance.now() - t0);
      revealedIds(wider, B);
    }
  }
  const n = queries.length * repeats;
  lines.push(`${B}\t${(hits / total).toFixed(3)}\t${(naiveHits / total).toFixed(3)}\t${(used / n).toFixed(0)}/${(naiveUsed / n).toFixed(0)}\t${distribution(focusMs)}\t${distribution(dwellMs)}`);
}
console.log(`equivalence gates: passed · ${process.version} · ${process.platform}/${process.arch}`);
console.log(`root: ${root}\ngraph: ${g.files.length} files, ${g.nodes.length} nodes, ${g.edges.length} edges`);
console.log(`build (single sample): cold ${coldMs.toFixed(0)}ms, disk-warm ${warmMs.toFixed(0)}ms`);
console.log(`idle (probe-gated): ${distribution(idle)}\nforced unchanged sweep: ${distribution(sweep)}`);
for (const scenario of [...new Set(refreshRows.map((row) => row.scenario))]) {
  const rows = refreshRows.filter((row) => row.scenario === scenario);
  console.log(`mini/${scenario}: refresh ${distribution(rows.map((row) => row.refreshMs))}; cold ${distribution(rows.map((row) => row.coldMs))}`);
}
console.log("budget\tfovea fidelity@16k\toutline fidelity@16k\tmean estimated tokens f/o\tfocus\tdwell");
console.log(lines.join("\n"));
console.log(`process peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB (includes gates; not isolated graph memory)`);
console.log(`queries: ${queries.join(", ")}`);
resetSessions();
