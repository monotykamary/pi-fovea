// Shared graph model for pi-fovea.
// Nodes are symbols (functions, methods, classes, ...), files, and feature anchors.
// Edges are undirected conductances between node indices; `kind` records why
// the edge exists, `evidence` records how it was derived, and `w` is the
// thermal conductance used by diffusion.

export type NodeKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "field"
  | "decl"
  | "file"
  | "anchor";

export type EdgeKind =
  | "contains"   // file -> its symbols
  | "imports"    // symbol/file -> symbol/file across an import
  | "invokes"    // call edge caller -> callee
  | "inherits"   // class extends / implements (outline-derived)
  | "tests"      // test file -> unit under test
  | "join"       // shared normalized literal (cross-language bridge)
  | "anchors";   // route anchor -> handler symbol (site-collapsed feature hub)

export interface NodeRec {
  id: string;        // stable identity: "name@file" (methods: "Type.name@file")
  name: string;
  kind: NodeKind;
  file: string;      // repo-relative path
  line: number;      // 1-indexed
  lineApproximate?: boolean; // legacy outlines only know the enclosing declaration
  sig: string;       // one-line signature for foveated rendering
  lang: string;      // ast-grep language name, or "config" / "text"
}

type EdgeStrategy =
  | "file-membership"
  | "relative-import"
  | "computed-import-family"
  | "python-module"
  | "go-module-suffix"
  | "rust-module"
  | "typescript-tail"
  | "test-import"
  | "same-file-symbol"
  | "imported-symbol"
  | "globally-unique-symbol"
  | "signature-extends"
  | "signature-implements"
  | "normalized-literal"
  | "declared-anchor"
  | "discovered-anchor"
  | "anchor-membership";

/** Deterministic derivation metadata. This is provenance, not probability. */
export interface EdgeEvidence {
  strategy: EdgeStrategy;
  /** Declarative rule or bounded resolver branch that derived the edge. */
  rule?: string;
  /** Exact import, symbol, literal, feature site, or file witness. */
  source?: string;
  /** Number of candidates considered by a bounded resolver. */
  candidates?: number;
  /** Canonical literal or feature key when one is the exact join witness. */
  key?: string;
  implicit?: boolean;
  /** A bounded possible target, never an exact runtime dependency. */
  possible?: boolean;
}

export interface Edge {
  a: number;         // index into Graph.nodes
  b: number;
  kind: EdgeKind;
  w: number;         // conductance >= 0
  /** Optional for compatibility with callers constructing synthetic graphs. */
  evidence?: EdgeEvidence;
}

export interface Anchor {
  id: string;        // e.g. "GET /api/users/{*}" or "RPC users.v1.Users/GetUser"
  kind: string;      // "route", "rpc", "graphql", "trpc", "channel", ...
  label: string;     // display label
  nodeId: string;    // handler symbol node id, or enclosing node
  file: string;
  line: number;
  /** Declarative extractor rule for a site; collapsed hubs expose `sources`. */
  ruleId?: string;
  sources?: string[];
  implicit?: boolean; // tier-3 discovered shape: half hub gravity, shown with △
}

export interface ImportCoverage {
  sites: number;
  resolved: number;
  possible: number;
  unresolved: number;
  capped: number;
  unsupportedLanguages: string[];
  examples: Array<{ file: string; line: number; spec: string; status: "possible" | "unresolved" | "capped"; reason: string }>;
  examplesOmitted: number;
}

export interface Graph {
  nodes: NodeRec[];
  edges: Edge[];
  byName: Map<string, number[]>;   // lowercased name -> node indices
  byFile: Map<string, number[]>;   // file -> node indices (sorted by line)
  anchors: Anchor[];
  files: string[];
  /** Current extraction/resolution diagnostics, not persistent workflow state. */
  importCoverage?: ImportCoverage;
}

export interface SymbolRec {
  name: string;
  kind: NodeKind;
  file: string;
  line: number;
  lineApproximate?: boolean;
  sig: string;
  lang: string;
}

export interface ImportSite {
  file: string;
  spec: string;
  line: number;
  /** Captured computed expression; absent bounds mean the target is unresolved. */
  dynamic?: { prefix?: string; suffix?: string };
}
export interface CallSite { file: string; line: number; callee: string; }
export interface LiteralSite { file: string; line: number; text: string; }
