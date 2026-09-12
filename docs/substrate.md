# Snapshot substrate v1

`pi-fovea/substrate` is a small, session-free entrypoint for graph consumers. It does not enroll roots, discover files, read project rules, perform extraction, or inspect the current working tree.

```ts
import { SUBSTRATE_VERSION, assembleFactGraph, diffuseMass, type SnapshotFacts } from "pi-fovea/substrate";

if (SUBSTRATE_VERSION !== 1) throw new Error("Unsupported substrate version");
const facts = new Map<string, SnapshotFacts>();
// Populate immutable per-file symbol/import/call/literal/anchor facts.
const graph = await assembleFactGraph(facts);
const source = new Float64Array(graph.nodes.length);
// Assign nonnegative source mass to graph node indices.
const fields = diffuseMass(graph, source, [0.5, 2, 8]);
```

`SnapshotFacts` is the explicit projection of Fovea's extraction-fact shape. Its legacy `sha1` field is caller-owned content identity; graph assembly does not interpret that digest. Every site must name its owning repository-relative file. Unsafe paths and cross-file witnesses are rejected. Callers own source coverage and must keep supplied facts immutable during assembly.

The resulting `Graph` retains nodes, typed relationship evidence, file/name indexes, and import coverage. Callers can select or reweight relationships without introducing a second graph resolver. Navigation conductances are not calibrated defect probabilities.

`diffuseMass` accepts a graph, a finite nonnegative source vector matching the node count, and finite times in [0,64]. Results are `{ time, mass: Float64Array }` in requested order. It shares Chebyshev recurrence vectors across times and applies the forward random-walk conjugation of the symmetric heat kernel. Isolates retain their original mass. Floating-point conservation is approximate; tests cover it against existing solver paths, whose independent reference tests remain in the core suite.

No session, disclosure, snapshot cache, or quality policy is implied by this API. Consumers such as pi-contour supply immutable Git/index snapshots, analysis-specific projections, source evidence, and their own bounded caches.
