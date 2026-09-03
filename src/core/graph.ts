import { basename, posix } from "node:path";
import { forEachChunked } from "./asyncutil.js";
import { LANG_BY_EXT } from "./astgrep.js";
import { isTestFile } from "./extract.js";
import { buildJoinIndex, type JoinIndex } from "./join.js";
import type { AnchorDraft } from "./anchors.js";
import type { FileFacts } from "./build.js";
import type { Edge, EdgeEvidence, Graph, LiteralSite, NodeRec } from "./types.js";

const CODE_EXTS_BY_LANGFAMILY: Record<string, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  py: [".py"],
  rs: [".rs"],
  go: [],
};

const langFamily = (file: string): string => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (ext === "py") return "py";
  if (ext === "rs") return "rs";
  if (ext === "go") return "go";
  return ext;
};

/**
 * Precomputed suffix indexes. The naive resolvers scanned the whole file set
 * per import (O(imports × files)), which quadratic-blows on big trees; these
 * maps make each lookup near-constant while preserving the exact match rules.
 */
interface ImportIndex {
  fileSet: Set<string>;
  filesByDir: Map<string, string[]>;
  /** Go: last-k-segment dir suffix (k <= 3) -> dirs, built for every source dir. */
  goDirsBySuffix: Map<string, string[]>;
  /** Rust: module basename -> files (`foo.rs`, `foo/mod.rs`). */
  rsByBase: Map<string, string[]>;
  /** TS bare specifiers: last path segment -> `x.ts` / `x/index.ts` files. */
  tsByTailStem: Map<string, string[]>;
}

const pushIndex = (m: Map<string, string[]>, key: string, value: string): void => {
  (m.get(key) ?? m.set(key, []).get(key)!).push(value);
};

const buildImportIndex = (files: string[]): ImportIndex => {
  const fileSet = new Set(files);
  const filesByDir = new Map<string, string[]>();
  const goDirsBySuffix = new Map<string, string[]>();
  const rsByBase = new Map<string, string[]>();
  const tsByTailStem = new Map<string, string[]>();
  for (const f of files) {
    const dir = posix.dirname(f);
    pushIndex(filesByDir, dir, f);
  }
  for (const dir of filesByDir.keys()) {
    const segs = dir.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(3, segs.length); k++) {
      pushIndex(goDirsBySuffix, segs.slice(-k).join("/"), dir);
    }
  }
  for (const f of files) {
    if (f.endsWith(".rs")) {
      const base = basename(f, ".rs");
      pushIndex(rsByBase, base, f);
      if (base === "mod") {
        const parentBase = basename(posix.dirname(f));
        pushIndex(rsByBase, parentBase, f);
      }
    }
    if (f.endsWith(".ts")) {
      const base = basename(f, ".ts");
      if (base === "index") pushIndex(tsByTailStem, basename(posix.dirname(f)), f);
      else pushIndex(tsByTailStem, base, f);
    }
  }
  return { fileSet, filesByDir, goDirsBySuffix, rsByBase, tsByTailStem };
};

interface ImportResolution {
  file: string;
  evidence: EdgeEvidence;
}

const resolveImportToFile = (
  spec: string,
  fromFile: string,
  index: ImportIndex,
): ImportResolution | undefined => {
  const { fileSet } = index;
  const fam = langFamily(fromFile);
  const exact = (candidates: string[], strategy: EdgeEvidence["strategy"]): ImportResolution | undefined => {
    const hits = [...new Set(candidates)].filter((candidate) => fileSet.has(candidate));
    return hits.length
      ? { file: hits[0]!, evidence: { strategy, rule: "import-resolve", source: spec, candidates: hits.length } }
      : undefined;
  };
  if (spec.startsWith("./") || spec.startsWith("../")) {
    let base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    // NodeNext convention: TS files import "./sibling.js" — the .js refers to
    // the .ts source. Strip a runtime extension before probing.
    base = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates: string[] = [];
    for (const ext of CODE_EXTS_BY_LANGFAMILY[fam] ?? []) {
      candidates.push(base + ext, `${base}/index${ext}`);
    }
    candidates.push(base);
    return exact(candidates, "relative-import");
  }
  if (fam === "py") {
    const p = spec.replace(/\./g, "/");
    return exact([`${p}.py`, `${p}/__init__.py`], "python-module");
  }
  if (fam === "go") {
    const segs = spec.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(3, segs.length); k++) {
      const suffix = segs.slice(-k).join("/");
      const matches = (index.goDirsBySuffix.get(suffix) ?? []).filter(
        (directory) => directory === suffix || directory.endsWith(`/${suffix}`),
      );
      if (matches.length === 1) {
        const inDir = index.filesByDir.get(matches[0]!) ?? [];
        if (inDir.length) {
          return {
            file: inDir[0]!,
            evidence: { strategy: "go-module-suffix", rule: "go-package-representative", source: spec, candidates: inDir.length },
          };
        }
      }
    }
    return undefined;
  }
  if (fam === "rs") {
    const modPath = spec.replace(/^crate::|^self::/, "").replace(/::/g, "/");
    const direct = exact([`src/${modPath}.rs`, `${modPath}.rs`], "rust-module");
    if (direct) return direct;
    const baseName = basename(modPath);
    const hits = (index.rsByBase.get(baseName) ?? []).filter(
      (file) => file === `${baseName}.rs` || file.endsWith(`/${baseName}.rs`) || file.endsWith(`/${baseName}/mod.rs`),
    );
    return hits.length === 1
      ? { file: hits[0]!, evidence: { strategy: "rust-module", rule: "import-resolve", source: spec, candidates: hits.length } }
      : undefined;
  }
  // TS bare specifier: node_modules or aliased; try a tail match.
  const tail = spec.split("/").filter(Boolean).join("/");
  const stem = tail.split("/").pop() ?? tail;
  const hits = (index.tsByTailStem.get(stem) ?? []).filter(
    (file) => file.endsWith(`/${tail}.ts`) || file.endsWith(`/${tail}/index.ts`),
  );
  return hits.length === 1
    ? { file: hits[0]!, evidence: { strategy: "typescript-tail", rule: "import-resolve", source: spec, candidates: hits.length } }
    : undefined;
};

const addNode = (nodes: NodeRec[], seen: Map<string, number>, rec: NodeRec): number => {
  const hit = seen.get(rec.id);
  if (hit !== undefined) return hit;
  const idx = nodes.length;
  seen.set(rec.id, idx);
  nodes.push(rec);
  return idx;
};

export interface GraphAssembly { graph: Graph; joinIndex: JoinIndex }

export const assembleGraphWithIndex = async (
  root: string,
  files: string[],
  factsMap: Map<string, FileFacts> | Record<string, FileFacts>,
): Promise<GraphAssembly> => {
  const facts = (file: string): FileFacts | undefined =>
    factsMap instanceof Map ? factsMap.get(file) : factsMap[file];
  const factValues = (): Iterable<FileFacts> =>
    factsMap instanceof Map ? factsMap.values() : Object.values(factsMap);
  const nodes: NodeRec[] = [];
  const seen = new Map<string, number>();
  const edges: Edge[] = [];
  const byFile = new Map<string, number[]>();
  const fileIdx = new Map<string, number>();

  const pushEdge = (a: number, b: number, kind: Edge["kind"], w: number, evidence: EdgeEvidence): void => {
    if (a === b) return;
    edges.push({ a, b, kind, w, evidence });
  };

  // File nodes first (stable for enclosing fallback + sketch grouping).
  for (const rel of files) {
    const idx = addNode(nodes, seen, {
      id: `file:${rel}`, name: posix.basename(rel), kind: "file", file: rel, line: 0,
      sig: rel, lang: LANG_BY_EXT[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "config",
    });
    fileIdx.set(rel, idx);
    (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
  }

  // Symbol nodes + contains edges.
  const symIdxByFileLine = new Map<string, number>(); // `${file}:${line}` first symbol idx
  await forEachChunked(files, 512, (rel) => {
    const f = facts(rel);
    if (!f) return;
    for (const s of f.symbols) {
      const idx = addNode(nodes, seen, { id: `${s.name}@${s.file}`, ...s });
      (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
      pushEdge(fileIdx.get(rel)!, idx, "contains", 1.0, { strategy: "file-membership", rule: "symbol-contained-by-file", source: rel });
      const key = `${rel}:${s.line}`;
      if (!symIdxByFileLine.has(key)) symIdxByFileLine.set(key, idx);
    }
  });

  // Order each file's node list by line for enclosing-symbol queries.
  for (const [, arr] of byFile) arr.sort((x, y) => nodes[x]!.line - nodes[y]!.line);

  const enclosingIdx = (file: string, line: number): number => {
    const arr = byFile.get(file) ?? [];
    let best = fileIdx.get(file)!;
    for (const idx of arr) {
      const n = nodes[idx]!;
      if (n.kind !== "file" && n.line <= line && nodes[best]!.line <= n.line) best = idx;
    }
    return best;
  };

  // byName index: exact, lowercased, and short suffix (methods).
  const byName = new Map<string, number[]>();
  {
    const addKey = (key: string, idx: number): void => {
      if (!key) return;
      (byName.get(key) ?? byName.set(key, []).get(key)!).push(idx);
    };
    nodes.forEach((n, i) => {
      if (n.kind === "file" || n.kind === "anchor") return;
      addKey(n.name.toLowerCase(), i);
      const dot = n.name.indexOf(".");
      if (dot > 0) addKey(n.name.slice(dot + 1).toLowerCase(), i);
    });
  }

  const importIndex = buildImportIndex(files);

  // Import edges (file-level, low conductance backbone) + tests wiring.
  const importTargets = new Map<string, ImportResolution[]>();
  await forEachChunked(files, 512, (rel) => {
    const f = facts(rel);
    if (!f) return;
    for (const imp of f.imports) {
      const target = resolveImportToFile(imp.spec, rel, importIndex);
      if (!target || target.file === rel) continue;
      pushEdge(fileIdx.get(rel)!, fileIdx.get(target.file)!, "imports", 0.3, target.evidence);
      (importTargets.get(rel) ?? importTargets.set(rel, []).get(rel)!).push(target);
    }
    if (isTestFile(rel)) {
      for (const target of importTargets.get(rel) ?? []) {
        pushEdge(fileIdx.get(rel)!, fileIdx.get(target.file)!, "tests", 0.6, {
          strategy: "test-import",
          rule: "test-subject-import",
          source: target.evidence.source,
          candidates: target.evidence.candidates,
        });
      }
    }
  });

  // Call edges: resolve callee by name, prefer same-file, then imported files,
  // then a globally unique definition. Conductance decays with definition
  // cardinality: a name defined twice is a pointer, a name defined 40 times
  // is ambient noise (the dynamic-language `str(`/`it(` hub failure mode).
  await forEachChunked(files, 256, (rel) => {
    const f = facts(rel);
    if (!f) return;
    const imported = new Set((importTargets.get(rel) ?? []).map((target) => target.file));
    for (const call of f.calls) {
      const cands = byName.get(call.callee.toLowerCase()) ?? [];
      if (!cands.length || cands.length > 48) continue;
      let strategy: EdgeEvidence["strategy"] = "same-file-symbol";
      let chosen: number[] = cands.filter((i) => nodes[i]!.file === rel);
      if (!chosen.length) {
        strategy = "imported-symbol";
        chosen = cands.filter((i) => imported.has(nodes[i]!.file));
      }
      if (!chosen.length && cands.length === 1) {
        strategy = "globally-unique-symbol";
        chosen = cands;
      }
      if (!chosen.length || chosen.length > 3) continue;
      const w = cands.length <= 8 ? 0.7 : cands.length <= 24 ? 0.45 : 0.25;
      const from = enclosingIdx(rel, call.line);
      for (const to of chosen) {
        pushEdge(from, to, "invokes", w, { strategy, rule: "call-target-resolution", source: call.callee, candidates: cands.length });
      }
    }
  });

  // Inherits edges from class signatures (TS/py style visible on the sig line).
  nodes.forEach((node, i) => {
    if (node.kind !== "class") return;
    for (const match of node.sig.matchAll(/extends\s+([A-Za-z_$][\w$.]*)/g)) {
      const candidates = byName.get(match[1]!.toLowerCase()) ?? [];
      for (const to of candidates) {
        pushEdge(i, to, "inherits", 0.9, {
          strategy: "signature-extends", rule: "extends-clause", source: match[1]!, candidates: candidates.length,
        });
      }
    }
    const impl = /implements\s+([A-Za-z_$][\w$.,\s]*)/.exec(node.sig);
    if (impl) {
      for (const raw of impl[1]!.split(",")) {
        const name = raw.trim();
        const candidates = byName.get(name.toLowerCase()) ?? [];
        for (const to of candidates) {
          pushEdge(i, to, "inherits", 0.9, {
            strategy: "signature-implements", rule: "implements-clause", source: name, candidates: candidates.length,
          });
        }
      }
    }
  });

  // Literal join edges (the cross-language bridge).
  const allSites: LiteralSite[] = [];
  for (const f of factValues()) for (const literal of f.literals) allSites.push(literal);
  const joinIdx = buildJoinIndex(allSites, (file, line) => enclosingIdx(file, line));
  for (const edge of joinIdx.edges) pushEdge(edge.a, edge.b, "join", edge.w, edge.evidence);

  // Anchors: one node per exact feature id, not per site. Registrations, schema
  // declarations, and consumers carrying that id meet at the same hub. Site
  // conductance decays with sqrt(count) so a common feature cannot dominate.
  const drafts: AnchorDraft[] = [];
  for (const rel of files) {
    const f = facts(rel);
    if (f) for (const anchor of f.anchors) drafts.push(anchor);
  }
  const draftsByLabel = new Map<string, AnchorDraft[]>();
  for (const anchor of drafts) {
    (draftsByLabel.get(anchor.id) ?? draftsByLabel.set(anchor.id, []).get(anchor.id)!).push(anchor);
  }
  const anchors: Graph["anchors"] = [];
  for (const [label, sites] of draftsByLabel) {
    const first = sites[0]!;
    const filesOf = [...new Set(sites.map((site) => site.file))];
    const sources = [...new Set(sites.map((site) => site.ruleId).filter((source): source is string => !!source))].sort();
    // A hub is implicit only when EVERY site came from a discovered rule — a
    // match by any declared rule upgrades it back to first-class instantly.
    const hubImplicit = sites.every((site) => site.implicit === true);
    anchors.push({
      id: label,
      kind: first.kind,
      label: sites.length > 1 ? `${label} · ${sites.length} sites` : label,
      nodeId: first.nodeId,
      file: first.file,
      line: first.line,
      ...(sources.length ? { sources } : {}),
      ...(hubImplicit ? { implicit: true } : {}),
    });
    const idx = addNode(nodes, seen, {
      id: `anchor:${label}`, name: label, kind: "anchor", file: first.file, line: first.line,
      sig: `${hubImplicit ? "(△ discovered) " : ""}${sites.length > 1 ? `${label} (${sites.length} sites)` : label}`, lang: "anchor",
    });
    (byFile.get(first.file) ?? byFile.set(first.file, []).get(first.file)!).push(idx);
    const w = (hubImplicit ? 0.5 : 1) / Math.sqrt(sites.length);
    for (const site of sites) {
      const handler = seen.get(site.nodeId) ?? fileIdx.get(site.file)!;
      pushEdge(idx, handler, "anchors", w, {
        strategy: site.implicit ? "discovered-anchor" : "declared-anchor",
        rule: site.ruleId ?? "legacy-anchor",
        source: `${site.file}:${site.line}`,
        candidates: sites.length,
        key: label,
        ...(site.implicit ? { implicit: true } : {}),
      });
    }
    if (filesOf.length > 1 && filesOf.length <= 12) {
      const fw = 0.35 / Math.sqrt(filesOf.length);
      for (const file of filesOf) {
        pushEdge(idx, fileIdx.get(file)!, "anchors", fw, {
          strategy: "anchor-membership",
          rule: "feature-file-membership",
          source: file,
          candidates: filesOf.length,
          key: label,
          ...(hubImplicit ? { implicit: true } : {}),
        });
      }
    }
  }

  return { graph: { nodes, edges, byName, byFile, anchors, files }, joinIndex: joinIdx };
};
