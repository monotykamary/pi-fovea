// Versioned, session-free substrate for consumers of immutable extraction facts.
// This module never discovers files, reads project configuration, or loads a session.
import { assembleGraphWithIndex } from "./core/graph.js";
import { buildCsr, chebyshevVectors, chooseOrder, heatField } from "./core/heat.js";
import type { FileFacts } from "./core/build.js";
import type { Graph } from "./core/types.js";

export const SUBSTRATE_VERSION = 1 as const;
export type SnapshotFacts = Pick<FileFacts, "sha1" | "symbols" | "imports" | "calls" | "literals" | "anchors">;
export type { Graph, Edge, NodeRec, EdgeEvidence } from "./core/types.js";

/** Assemble only the supplied files. Paths and witnesses must belong to this snapshot. */
export async function assembleFactGraph(facts: ReadonlyMap<string, SnapshotFacts>): Promise<Graph> {
  const files = [...facts.keys()].sort();
  for (const file of files) {
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").some(p => p === ".." || p === "." || !p)) {
      throw new Error(`Invalid snapshot path: ${file}`);
    }
    const fact = facts.get(file)!;
    for (const site of [...fact.symbols, ...fact.imports, ...fact.calls, ...fact.literals, ...fact.anchors]) {
      if (site.file !== file) throw new Error(`Witness outside its snapshot file: ${site.file}`);
    }
  }
  return (await assembleGraphWithIndex("", files, new Map(facts))).graph;
}

/** Column-mass heat D^(1/2) exp(-t Lsym) D^(-1/2) q, sharing one Chebyshev basis.
 * Times are analysis scales, not wall-clock ages. Isolates retain their source mass.
 * Results are exposure, not calibrated risk. Callers may project/reweight the graph.
 */
export function diffuseMass(graph: Graph, source: Float64Array, times: readonly number[]): Array<{ time: number; mass: Float64Array }> {
  if (source.length !== graph.nodes.length || source.some(v => !Number.isFinite(v) || v < 0)) {
    throw new Error("Mass must be finite, nonnegative, and match the graph");
  }
  if (times.some(t => !Number.isFinite(t) || t < 0 || t > 64)) throw new Error("Diffusion scales must lie in [0, 64]");
  if (graph.edges.some(e => !Number.isFinite(e.w) || e.w < 0 || !Number.isInteger(e.a) || !Number.isInteger(e.b)
    || e.a < 0 || e.b < 0 || e.a >= source.length || e.b >= source.length)) throw new Error("Invalid conductance edge");
  if (!times.length) return [];
  const csr = buildCsr(graph);
  const seed = Float64Array.from(source, (mass, i) => csr.deg[i]! > 0 ? mass / Math.sqrt(csr.deg[i]!) : 0);
  const vectors = chebyshevVectors(csr, seed, chooseOrder(Math.max(...times)));
  return times.map(time => {
    const field = heatField(vectors, time, csr.n);
    return { time, mass: Float64Array.from(source, (mass, i) => csr.deg[i]! > 0 ? Math.sqrt(csr.deg[i]!) * field[i]! : mass) };
  });
}
