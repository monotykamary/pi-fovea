// The four operations. Each is: resolve seeds -> diffuse -> reveal within
// budget. sketch surveys the whole repo (large t, hub + anchor seeds, grouped
// rendering), focus centers the fovea on a query, dwell advances diffusion
// time and returns the delta, impact seeds from changed files.

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { diffHunks, prFiles, uncommittedFiles } from "./git.js";
import { chebyshevVectors, chooseOrder, heatField } from "./heat.js";
import { formatNodeLocation, revealFoveated, revealGroups, tokenEstimate, type GroupLine, type RevealedNode } from "./render.js";
import { FOCUS_T0, getSession, observeSessionPaths, TK_ORDER } from "./session.js";
import { detectBasins } from "./basins.js";
import { classifyLiteral, normalizeLiteral } from "./join.js";
import { isTestFile } from "./extract.js";
import { effectiveWeight, type CoChangeHistory } from "./cochange.js";
import type { Graph, NodeKind, NodeRec } from "./types.js";
import { ensureState } from "./state.js";
import type { RepoState } from "./state.js";
export { ensureState, ensureStateBackground, evictState, getInflight, getState } from "./state.js";
export type { RepoState } from "./state.js";

export interface OpResult {
  text: string;
  tokens: number;
  details: Record<string, unknown>;
}

// Honest coverage: surface dropped extractions instead of letting a thin
// graph read as a small repo. Suffixes go into rendered headers; the file
// lists go into structured details for consumers that can act on them.
const extractionSuffix = (state: RepoState): string => {
  const parts: string[] = [];
  if (state.extraction.failed.length) parts.push(`!${state.extraction.failed.length} files failed extraction`);
  if (state.extraction.unreadable.length) parts.push(`!${state.extraction.unreadable.length} files unreadable`);
  if (state.extraction.oversized.length) parts.push(`!${state.extraction.oversized.length} files over size cap`);
  if (state.extraction.generated.length) parts.push(`!${state.extraction.generated.length} generated files skipped`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
};

const extractionDetails = (state: RepoState): Record<string, unknown> => ({
  extractionFailures: state.extraction.failed.length,
  extractionFailedFiles: state.extraction.failed.slice(0, 20),
  extractionUnreadable: state.extraction.unreadable,
  extractionOversized: state.extraction.oversized,
  extractionGenerated: state.extraction.generated,
});

// Seed resolution.

export interface SeedSuggestion {
  index: number;
  name: string;
  file: string;
  line: number;
  lineApproximate?: boolean;
  score: number;
}

export interface SeedResolution {
  seeds: number[];
  note: string;
  suggestions: SeedSuggestion[];
}

export interface FocusOptions {
  fresh?: boolean;
  path?: string;
  language?: string;
  kind?: NodeKind;
}

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "does", "find", "for", "happen", "happens", "how",
  "in", "is", "of", "on", "please", "the", "this", "to", "what", "where", "which", "with",
]);

const stemIdentifier = (term: string): string => {
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
};

const identifierTerms = (value: string): string[] => {
  const split = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !QUERY_STOP_WORDS.has(term))
    .map(stemIdentifier)
    .filter((term) => !QUERY_STOP_WORDS.has(term));
  return [...new Set(split)];
};

const shortSymbolName = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

const diceSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const pair = a.slice(i, i + 2);
    left.set(pair, (left.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2);
    const count = left.get(pair) ?? 0;
    if (count > 0) {
      overlap++;
      left.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
};

const symbolSimilarity = (query: string, node: NodeRec): number => {
  const queryTerms = identifierTerms(query);
  const candidateTerms = identifierTerms(shortSymbolName(node.name));
  const candidateSet = new Set(candidateTerms);
  const shared = queryTerms.filter((term) => candidateSet.has(term)).length;
  const coverage = queryTerms.length ? shared / queryTerms.length : 0;
  const precision = candidateTerms.length ? shared / candidateTerms.length : 0;
  const tokenScore = 0.72 * coverage + 0.28 * precision;
  const charScore = diceSimilarity(queryTerms.join(""), candidateTerms.join(""));
  return Math.max(tokenScore, charScore);
};

const sameIdentifierTerms = (query: string, name: string): boolean => {
  const queryTerms = identifierTerms(query);
  const candidateTerms = identifierTerms(shortSymbolName(name));
  if (!queryTerms.length || queryTerms.length !== candidateTerms.length) return false;
  const candidateSet = new Set(candidateTerms);
  return queryTerms.every((term) => candidateSet.has(term));
};

const matchesFocusScope = (node: NodeRec, options: FocusOptions): boolean => {
  const pathScope = options.path?.replace(/^@/, "").replace(/^\.\//, "").replace(/\/$/, "");
  if (pathScope && node.file !== pathScope && !node.file.startsWith(`${pathScope}/`)) return false;
  if (options.language && node.lang.toLowerCase() !== options.language.toLowerCase()) return false;
  if (options.kind && node.kind !== options.kind) return false;
  return true;
};

export const resolveSeeds = (state: RepoState, query: string, options: FocusOptions = {}): SeedResolution => {
  const g = state.graph;
  const allows = (idx: number): boolean => matchesFocusScope(g.nodes[idx]!, options);
  const scored = new Map<number, number>();
  const bump = (idx: number, s: number): void => {
    if (!allows(idx)) return;
    scored.set(idx, Math.max(scored.get(idx) ?? 0, s));
  };
  const q = query.trim();
  const terms = q.split(/\s+/).filter((t) => t.length > 1);

  // Literal route: treat the query itself as a join token (path/env/word).
  const cls = classifyLiteral(q);
  if (cls) {
    const norm = normalizeLiteral(q, cls);
    for (const occ of state.joinIndex.byKey.get(norm)?.occ ?? []) bump(occ.node, 1);
    if (cls === "path") {
      // Route-prefix queries ("/api/airports") seed everything mounted below
      // them — the query is rarely a literal in code, which is the point: the
      // model shouldn't have to guess the full route string to look at it.
      const under = `${norm}/`;
      for (const [key, bucket] of state.joinIndex.byKey) {
        if (bucket.cls !== "path" || !key.startsWith(under)) continue;
        for (const occ of bucket.occ) bump(occ.node, 0.8);
      }
      // Anchors whose route sits under the query get seeded directly.
      state.graph.nodes.forEach((n, i) => {
        if (n.kind !== "anchor") return;
        const route = n.name.slice(n.name.indexOf(" ") + 1);
        if (route === norm || route.startsWith(under)) bump(i, 0.9);
      });
    }
  }

  for (const term of terms) {
    const key = term.toLowerCase();
    for (const idx of g.byName.get(key) ?? []) bump(idx, 1);
  }
  if (scored.size === 0) {
    // Substring fallback over symbol names.
    const hay: Array<{ i: number; name: string }> = [];
    g.nodes.forEach((n, i) => {
      if (n.kind !== "file" && n.kind !== "anchor") hay.push({ i, name: n.name.toLowerCase() });
    });
    for (const term of terms) {
      const key = term.toLowerCase();
      for (const { i, name } of hay) {
        if (name === key) bump(i, 1);
        else if (name.startsWith(key)) bump(i, 0.8);
        else if (name.includes(key)) bump(i, 0.5);
      }
    }
  }
  if (scored.size === 0) {
    g.nodes.forEach((node, i) => {
      if (node.kind !== "file" && node.kind !== "anchor" && sameIdentifierTerms(q, node.name)) {
        bump(i, 0.7);
      }
    });
  }
  // File path suffix (e.g. "web/api.ts").
  for (const f of g.files) {
    if (f === q || f.endsWith(`/${q}`)) {
      const arr = g.byFile.get(f) ?? [];
      if (arr[0] !== undefined) bump(arr[0], 1);
    }
  }

  const ranked = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || g.nodes[a[0]]!.file.localeCompare(g.nodes[b[0]]!.file))
    .slice(0, 16);
  const seeds = ranked.map(([i]) => i);
  const names = ranked.slice(0, 4).map(([i, score]) => `${g.nodes[i]!.name}${score < 1 ? " (approximate)" : ""}`);
  const note = seeds.length
    ? `${seeds.length} match${seeds.length === 1 ? "" : "es"}: ${names.join(", ")}${seeds.length > 4 ? ", …" : ""}`
    : "no graph match";
  const suggestions = seeds.length
    ? []
    : g.nodes
      .map((node, index) => ({ node, index, score: symbolSimilarity(q, node) }))
      .filter(({ node, index, score }) => allows(index) && node.kind !== "file" && node.kind !== "anchor" && score >= 0.34)
      .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name) || a.node.file.localeCompare(b.node.file))
      .slice(0, 5)
      .map(({ node, index, score }) => ({
        index,
        name: node.name,
        file: node.file,
        line: node.line,
        lineApproximate: node.lineApproximate,
        score,
      }));
  return { seeds, note, suggestions };
};

const suggestedReads = (nodes: RevealedNode[]): Array<{ path: string; offset: number; limit: number; reason: string }> => {
  const out: Array<{ path: string; offset: number; limit: number; reason: string }> = [];
  for (const node of nodes) {
    if (node.line <= 0 || node.lineApproximate) continue;
    const offset = Math.max(1, node.line - 5);
    const end = offset + 24;
    const existing = out.find((read) =>
      read.path === node.file && offset <= read.offset + read.limit && end + 1 >= read.offset);
    if (existing) {
      const mergedEnd = Math.max(existing.offset + existing.limit - 1, end);
      existing.offset = Math.min(existing.offset, offset);
      existing.limit = mergedEnd - existing.offset + 1;
      if (node.role === "focus") existing.reason = "matched focus";
      continue;
    }
    out.push({
      path: node.file,
      offset,
      limit: 25,
      reason: node.role === "focus" ? "matched focus" : node.relation ?? `${node.role} neighbor`,
    });
    if (out.length === 5) break;
  }
  return out;
};

const seedVector = (n: number, seeds: number[]): Float64Array => {
  const s = new Float64Array(n);
  for (const i of seeds) s[i] = 1;
  return s;
};

/**
 * Recency-decayed history heat for a changed-file set: past co-change
 * partners of those files, each at min(baseW * 2^-ageDays/halfLife). Pure
 * and linear — the caller adds the weights onto its seed vector, so the
 * whole cascade stays one diffusion. Never returns a file that is itself
 * being seeded, and old joints (age >> half-life) decay to ~0 and drop out.
 */
export const historySeedWeights = (
  seedFiles: ReadonlySet<string>,
  graph: Readonly<Graph>,
  history: CoChangeHistory,
  now: number,
): Map<string, number> => {
  const partners = new Map<string, number>();
  const add = (file: string, w: number): void => {
    if (seedFiles.has(file)) return;
    partners.set(file, Math.max(partners.get(file) ?? 0, w));
  };
  for (const file of seedFiles) {
    for (const p of history.get(file) ?? []) {
      const ageDays = Math.max(0, (now - p.lastTs) / 86_400_000);
      const w = effectiveWeight(p.w, ageDays);
      if (w <= 1e-6) continue;
      add(p.partner, w);
    }
  }
  return partners;
};

const clampBudget = (b: number | undefined, dflt: number): number =>
  Math.max(256, Math.min(16000, b ?? dflt));

// Overflow artifacts: budgeted views stay lean; when they truncate, the full
// list spills to a stable per-invocation tmp file whose path the footer names,
// mirroring pi's bash output-accumulator so agents can read/grep the rest.
const overflowArtifact = (op: string, key: string): string =>
  join(tmpdir(), `pi-fovea-${op}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}.txt`);

export const isTestScope = (file: string): boolean =>
  isTestFile(file) || /(^|\/)(tests?|__tests__|fixtures?)(\/|$)/i.test(file);


export const sketch = async (root: string, budget?: number): Promise<OpResult> => {
  const state = await ensureState(root);
  const g = state.graph;
  const B = clampBudget(budget, 512);

  // Production anchors and hubs define the opening silhouette. Tests remain
  // in the graph for focus/impact, but do not crowd out the code being shipped.
  const conductance = state.csr.deg;
  const closureFor = (i: number): number[] => [i, ...(state.adjacency.get(i) ?? []).map((edge) => edge.to)];
  const anchorIdx = g.nodes.map((node, i) => (node.kind === "anchor" ? i : -1)).filter((i) => i >= 0);
  const productionAnchorIdx = anchorIdx.filter((i) => closureFor(i).some((j) => !isTestScope(g.nodes[j]!.file)));
  const testAnchorIdx = anchorIdx.filter((i) => !productionAnchorIdx.includes(i));
  const productionHubIdx = g.nodes
    .map((_, i) => i)
    .filter((i) => !isTestScope(g.nodes[i]!.file))
    .sort((a, b) => conductance[b]! - conductance[a]!)
    .slice(0, 24);
  const fallbackHubIdx = productionHubIdx.length
    ? productionHubIdx
    : g.nodes.map((_, i) => i).sort((a, b) => conductance[b]! - conductance[a]!).slice(0, 24);
  const seeds = [...new Set([...productionAnchorIdx, ...fallbackHubIdx])].slice(0, 64);
  const s = seedVector(g.nodes.length, seeds);
  const t = 16;
  const field = heatField(chebyshevVectors(state.csr, s, Math.max(TK_ORDER, chooseOrder(t))), t, g.nodes.length);
  let vmax = 0;
  for (let i = 0; i < field.length; i++) if (field[i]! > vmax) vmax = field[i]!;
  if (vmax <= 0) {
    return { text: "fovea sketch: empty graph (no supported files matched)", tokens: 0, details: { files: 0 } };
  }

  // Feature groups: anchors first; where the repo declares few routes,
  // infer basins — greedy conductance-cut regions around self-dense seeds
  // (implicit features on non-web repos: CLIs, libraries, kernels).
  const claimed = new Set<number>();
  const groups: GroupLine[] = [];
  const basins = productionAnchorIdx.length < 6 && g.nodes.length >= 48
    ? detectBasins(
        state.adjacency,
        conductance,
        g.nodes.length,
        (i) => g.nodes[i]!.kind !== "file" && g.nodes[i]!.kind !== "anchor" && !isTestScope(g.nodes[i]!.file),
        (i) => !isTestScope(g.nodes[i]!.file),
      )
    : [];
  for (const b of basins) {
    let mass = 0;
    const bfiles = new Set<string>();
    for (const j of b.members) {
      mass += field[j] ?? 0;
      bfiles.add(g.nodes[j]!.file);
    }
    const topName = b.members
      .map((j) => [field[j] ?? 0, j] as const)
      .filter(([, j]) => g.nodes[j]!.kind !== "file")
      .sort((a, b2) => b2[0] - a[0])[0];
    groups.push({
      label: `◈ region ${topName ? g.nodes[topName[1]]!.name : g.nodes[b.seed]!.name}`,
      mass,
      detail: `${b.members.length} nodes · ${bfiles.size} files · seed ${g.nodes[b.seed]!.file}`,
    });
    for (const j of b.members) claimed.add(j);
  }

  for (const i of productionAnchorIdx) {
    const closure = closureFor(i);
    let mass = 0;
    const filesIn = new Set<string>();
    for (const j of closure) {
      mass += field[j]!;
      filesIn.add(g.nodes[j]!.file);
      claimed.add(j);
    }
    const handler = g.nodes[i]!;
    groups.push({
      label: `⚑ ${g.nodes[i]!.name}`,
      mass,
      detail: `${closure.length} nodes · ${filesIn.size} file${filesIn.size === 1 ? "" : "s"} · ${handler.file}:${handler.line}`,
    });
  }

  let testAnchorMass = 0;
  for (const i of testAnchorIdx) {
    for (const j of closureFor(i)) {
      testAnchorMass += field[j] ?? 0;
      claimed.add(j);
    }
  }
  if (testAnchorIdx.length) {
    groups.push({
      label: "tests/fixtures",
      mass: testAnchorMass * 0.05,
      detail: `${testAnchorIdx.length} feature anchors collapsed`,
    });
  }

  // Directory groups over the rest (depth-2 prefixes).
  const dirAgg = new Map<string, { mass: number; files: Set<string>; top: Array<[number, number]> }>();
  g.nodes.forEach((n, i) => {
    if (claimed.has(i) || n.kind === "anchor") return;
    const parts = n.file.split("/");
    const dir = parts.length === 1 ? "(root)" : parts.length === 2 ? `${parts[0]}/` : `${parts.slice(0, 2).join("/")}/`;
    const agg = dirAgg.get(dir) ?? { mass: 0, files: new Set<string>(), top: [] as Array<[number, number]> };
    dirAgg.set(dir, agg);
    agg.mass += field[i]!;
    agg.files.add(n.file);
    if (n.kind !== "file") agg.top.push([field[i]!, i]);
  });
  for (const [dir, agg] of dirAgg) {
    agg.top.sort((a, b) => b[0] - a[0]);
    const names = agg.top.slice(0, 3).map(([, i]) => g.nodes[i]!.name).join(", ");
    const testScope = [...agg.files].every(isTestScope);
    groups.push({
      label: dir,
      mass: agg.mass * (testScope ? 0.1 : 1),
      detail: `${testScope ? "test scope · " : ""}${agg.files.size} files${names ? ` · top: ${names}` : ""}`,
    });
  }

  const anchorSummary = testAnchorIdx.length
    ? `${productionAnchorIdx.length} production anchors · ${testAnchorIdx.length} test/fixture anchors collapsed`
    : `${productionAnchorIdx.length} anchors`;
  const fit = revealGroups(groups, {
    header: `fovea sketch · ${g.files.length} files · ${g.nodes.length} symbols · ${anchorSummary}${extractionSuffix(state)}`,
    budget: B,
    overflowTo: overflowArtifact("sketch", `${root}|sketch`),
  });
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      files: g.files.length,
      nodes: g.nodes.length,
      anchors: anchorIdx.length,
      productionAnchors: productionAnchorIdx.length,
      testAnchors: testAnchorIdx.length,
      truncated: fit.truncated,
      ...extractionDetails(state),
    },
  };
};

export const focus = async (
  root: string,
  query: string,
  budget?: number,
  options: FocusOptions = {},
  ensured?: RepoState,
): Promise<OpResult> => {
  // ensured lets verdict renderers reuse the exact state a warm/inline compute
  // already built, so an embed never triggers its own probe/rebuild.
  const state = ensured ?? (await ensureState(root));
  const g = state.graph;
  const session = getSession(root);
  const B = clampBudget(budget, 512);
  const { seeds, note, suggestions } = resolveSeeds(state, query, options);
  if (!seeds.length) {
    const renderMiss = (count: number): string => {
      const nearby = suggestions.slice(0, count).map((suggestion) => {
        const node = g.nodes[suggestion.index]!;
        return `  ? ${node.name} — ${formatNodeLocation(node)} — ${node.sig}`;
      });
      const guidance = suggestions.length
        ? "Retry fovea_focus with one of these names, a route path (/api/...), or a file path."
        : "Try a symbol name, a route path (/api/...), or a file path. Run fovea_sketch for the map silhouette first.";
      return [
        ...(state.extraction.failed.length
          ? [`! ${state.extraction.failed.length} files failed extraction; matches may be incomplete.`]
          : []),
        `fovea focus "${query}": ${note}.`,
        ...(nearby.length ? ["Nearby symbols:", ...nearby] : []),
        guidance,
      ].join("\n");
    };
    let shown = suggestions.length;
    let text = renderMiss(shown);
    while (shown > 0 && tokenEstimate(text) > B) text = renderMiss(--shown);
    return {
      text,
      tokens: tokenEstimate(text),
      details: {
        seeds: 0,
        suggestions: suggestions.slice(0, shown).map(({ name, file, line, lineApproximate, score }) => ({
          name,
          file,
          line,
          lineApproximate,
          score: Number(score.toFixed(3)),
        })),
        scope: { path: options.path, language: options.language, kind: options.kind },
        ...extractionDetails(state),
      },
    };
  }
  const scopeKey = [options.path ?? "", options.language?.toLowerCase() ?? "", options.kind ?? ""].join("|");
  const key = `${state.version}:${[...seeds].sort((a, b) => a - b).join(",")}:${scopeKey}`;
  if (options.fresh || session.focusKey !== key) {
    session.t = FOCUS_T0;
    session.disclosed.clear();
    session.focusKey = key;
    session.scope = { path: options.path, language: options.language, kind: options.kind };
  }
  if (session.tkKey !== key) {
    session.tk = chebyshevVectors(state.csr, seedVector(g.nodes.length, seeds), TK_ORDER);
    session.tkKey = key;
  }
  session.seeds = seeds;
  session.seedNote = note;
  const t = session.t;
  const field = heatField(session.tk, t, g.nodes.length);
  const scopedIds = options.path || options.language || options.kind
    ? new Set(g.nodes.filter((node) => matchesFocusScope(node, options)).map((node) => node.id))
    : undefined;
  const fit = revealFoveated(g, field, {
    header: `fovea focus "${query}" · ${note}${extractionSuffix(state)}`,
    include: scopedIds,
    disclosed: session.disclosed,
    seeds,
    repeatNucleus: true,
    budget: B,
    overflowTo: overflowArtifact("focus", `${root}|${query}`),
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  observeSessionPaths(root, fit.revealed.map((node) => node.file));
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      seeds: seeds.length,
      lit: fit.litTotal,
      shown: fit.shown,
      suppressed: fit.suppressed,
      t,
      scope: { path: options.path, language: options.language, kind: options.kind },
      nodes: fit.revealed,
      suggestedReads: suggestedReads(fit.revealed),
      ...extractionDetails(state),
    },
  };
};

export const dwell = async (root: string, factor?: number, budget?: number): Promise<OpResult> => {
  const state = await ensureState(root);
  const g = state.graph;
  const session = getSession(root);
  const B = clampBudget(budget, 512);
  if (!session.seeds.length) {
    return {
      text: "fovea dwell: no focus yet. Call fovea_focus with a symbol or route first; dwell then deepens that field.",
      tokens: 0,
      details: { seeds: 0 },
    };
  }
  const from = session.t;
  const to = Math.min(64, from * Math.max(1.2, factor ?? 2));
  session.t = to;
  // The cached T_k(M)s vectors are exact for t up to ~TK_ORDER/2.2-16; beyond
  // that, extend the recurrence instead of silently degrading accuracy.
  if (chooseOrder(to) > session.tk.length - 1) {
    session.tk = chebyshevVectors(state.csr, seedVector(g.nodes.length, session.seeds), chooseOrder(to) + 8);
    session.tkKey += "+ext";
  }
  const field = heatField(session.tk, to, g.nodes.length);
  const scope = session.scope ?? {};
  const scopedIds = scope.path || scope.language || scope.kind
    ? new Set(g.nodes.filter((node) => matchesFocusScope(node, scope)).map((node) => node.id))
    : undefined;
  const fit = revealFoveated(g, field, {
    header: `fovea dwell · context widened ${Number((to / from).toFixed(1))}× · new results`,
    include: scopedIds,
    disclosed: session.disclosed,
    seeds: session.seeds,
    budget: B,
    overflowTo: overflowArtifact("dwell", root),
  });
  for (const id of fit.revealedIds) session.disclosed.add(id);
  observeSessionPaths(root, fit.revealed.map((node) => node.file));
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      from,
      to,
      lit: fit.litTotal,
      shown: fit.shown,
      suppressed: fit.suppressed,
      scope,
      nodes: fit.revealed,
      suggestedReads: suggestedReads(fit.revealed),
      ...extractionDetails(state),
    },
  };
};

export interface ImpactArgs {
  files?: string[];
  symbols?: string[];
  includeUncommitted?: boolean;
  /** Base ref for PR-style cascades: seeds from `git diff base...HEAD`. */
  base?: string;
  budget?: number;
}

// Reason label for the history heat layer; must equal the sync CHANNEL_WEIGHT
// key so the surprise gate weighs it the same as it ever weighed the edge.
const COCHANGE_REASON = "co-change history";

export const impact = async (root: string, args: ImpactArgs, ensured?: RepoState): Promise<OpResult> => {
  const state = ensured ?? (await ensureState(root));
  const g = state.graph;
  const B = clampBudget(args.budget, 512);
  const files = new Set<string>(args.files ?? []);
  if (args.base) for (const f of await prFiles(root, args.base)) files.add(f);
  if (args.includeUncommitted !== false && !args.base) for (const f of await uncommittedFiles(root)) files.add(f);

  // Explicit what-if/sync files with Git discovery disabled may not describe
  // the current HEAD patch (notably a semantic revert that is clean again),
  // so only refine the Git-backed modes that own a trustworthy diff.
  const useDiffHunks = !!args.base || args.includeUncommitted !== false;
  const hunksByFile = files.size && useDiffHunks ? await diffHunks(root, args.base) : undefined;
  const seedSet = new Set<number>();
  const seededFileNodes = new Set<number>();
  const s = new Float64Array(g.nodes.length);
  for (const rel of files) {
    const normalized = posix.normalize(rel);
    const arr = g.byFile.get(rel) ?? g.byFile.get(normalized) ?? [];
    const fileNode = arr.find((i) => g.nodes[i]!.kind === "file");
    if (fileNode === undefined || seededFileNodes.has(fileNode)) continue;
    seededFileNodes.add(fileNode);
    const graphFile = g.nodes[fileNode]!.file;
    const parsed = hunksByFile?.get(graphFile) ?? hunksByFile?.get(normalized) ?? hunksByFile?.get(rel);

    // byFile is line-ordered. Collapse same-line declarations to the last
    // node, matching an upper-bound enclosing-symbol lookup deterministically.
    const symbols: number[] = [];
    for (const i of arr) {
      const node = g.nodes[i]!;
      if (node.kind === "file" || node.kind === "anchor" || node.line < 1) continue;
      const previous = symbols[symbols.length - 1];
      if (previous !== undefined && g.nodes[previous]!.line === node.line) symbols[symbols.length - 1] = i;
      else symbols.push(i);
    }

    const touched = new Map<number, number>();
    let precise = !!parsed && !parsed.fallback && symbols.length > 0;
    const upperBound = (line: number): number => {
      let lo = 0;
      let hi = symbols.length;
      while (lo < hi) {
        const mid = lo + ((hi - lo) >> 1);
        if (g.nodes[symbols[mid]!]!.line <= line) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    if (parsed && precise) {
      for (const hunk of parsed.hunks) {
        if (hunk.newLines === 0) continue;
        const end = hunk.newStart + hunk.newLines;
        if (hunk.newStart < 1 || hunk.newLines < 0 || !Number.isSafeInteger(end)) {
          precise = false;
          touched.clear();
          break;
        }
        let cursor = hunk.newStart;
        let at = upperBound(cursor) - 1;
        if (at < 0) {
          at = 0;
          cursor = Math.max(cursor, g.nodes[symbols[0]!]!.line);
        }
        while (cursor < end && at < symbols.length) {
          const node = symbols[at]!;
          const next = symbols[at + 1];
          const segmentEnd = Math.min(end, next === undefined ? end : g.nodes[next]!.line);
          if (segmentEnd > cursor) touched.set(node, (touched.get(node) ?? 0) + segmentEnd - cursor);
          cursor = segmentEnd;
          at++;
        }
      }
    }

    if (!precise || !touched.size) {
      // New, deleted, untracked, renamed, binary, oversized, malformed, and
      // symbol-free files all preserve the old one-unit file-node nucleus.
      seedSet.add(fileNode);
      s[fileNode]! += 1;
      continue;
    }

    const scored = [...touched.entries()].map(([node, lines]) => [node, Math.sqrt(lines)] as const);
    const scoreTotal = scored.reduce((sum, [, score]) => sum + score, 0);
    seedSet.add(fileNode);
    s[fileNode]! += 0.2;
    let assigned = 0.2;
    for (let i = 0; i < scored.length; i++) {
      const [node, score] = scored[i]!;
      const weight = i === scored.length - 1 ? 1 - assigned : 0.8 * score / scoreTotal;
      seedSet.add(node);
      s[node]! += weight;
      assigned += weight;
    }
  }
  for (const sym of args.symbols ?? []) {
    for (const r of resolveSeeds(state, sym).seeds) {
      if (!seedSet.has(r)) s[r] = 1;
      seedSet.add(r);
    }
  }
  if (!seedSet.size) {
    return {
      text: "fovea impact: no seed files (repo clean or paths unknown). Pass files: [...] or symbols: [...] for a what-if cascade.",
      tokens: 0,
      details: { seeds: 0 },
    };
  }
  const seeds = [...seedSet];
  const t = 4;
  const seedFiles = new Set(seeds.map((i) => g.nodes[i]!.file));
  // History heat layer: past co-change re-seeds partner files into the SAME
  // diffusion at recency-decayed strength instead of pinning a permanent
  // structural edge. Linearity makes this exactly heat(seeds + partners·w):
  // a change with recent history hot-reloads its old co-workers, an idle one
  // adds nothing, and wall-clock decay cools the affinity like any heat.
  const historyFor = historySeedWeights(seedFiles, g, state.history, Date.now());
  let historyPartners = 0;
  for (const [file, w] of historyFor) {
    const fileNode = (g.byFile.get(file) ?? []).find((i) => g.nodes[i]!.kind === "file");
    if (fileNode === undefined) continue;
    s[fileNode]! += w;
    historyPartners++;
  }
  const field = heatField(chebyshevVectors(state.csr, s, chooseOrder(t)), t, g.nodes.length);
  const exclude = new Set(seeds.map((i) => g.nodes[i]!.id));

  // Aggregate warmed mass per file (excluding the seeds themselves). Heat
  // retained by the seed files (seedMass) is the scale-free normalizer turn
  // sync uses, since raw mass shrinks with graph size.
  const fileAgg = new Map<string, number>();
  const fileTop = new Map<string, Array<[number, number]>>();
  const anchorHits: GroupLine[] = [];
  let seedMass = 0;
  g.nodes.forEach((n, i) => {
    if (exclude.has(n.id)) return;
    const v = field[i]!;
    if (v <= 1e-6) return;
    if (seedFiles.has(n.file)) {
      seedMass += v;
      return;
    }
    if (n.kind === "anchor") {
      anchorHits.push({ label: `⚑ ${n.name}`, mass: v, detail: `${n.file}:${n.line}` });
      return;
    }
    fileAgg.set(n.file, (fileAgg.get(n.file) ?? 0) + v);
    if (n.kind === "file") return; // file nodes warm their file but aren't "top symbols"
    const top = fileTop.get(n.file) ?? [];
    fileTop.set(n.file, top);
    top.push([v, i]);
  });
  const reasonByFile = new Map<string, Set<string>>();
  // Per-NODE first-encounter reasons: the verdict memory is charged and aged
  // per graph node, so the channel prior must be attached at the same
  // granularity a node warms at, not smeared over its file.
  const reasonByNode = new Map<number, string[]>();
  const noteNode = (node: number, reasons: string[]): void => {
    if (!reasonByNode.has(node) && reasons.length) reasonByNode.set(node, reasons);
  };
  const reasonFor = (kind: Graph["edges"][number]["kind"]): string | undefined => {
    switch (kind) {
      case "invokes": return "call dependency";
      case "imports": return "import dependency";
      case "tests": return "test dependency";
      case "inherits": return "inheritance";
      case "join": return "shared literal";
      case "anchors": return "shared route";
      case "contains": return undefined;
    }
  };
  for (const edge of g.edges) {
    const aFile = g.nodes[edge.a]!.file;
    const bFile = g.nodes[edge.b]!.file;
    if (aFile === bFile) continue;
    const target = seedFiles.has(aFile) && !seedFiles.has(bFile)
      ? bFile
      : seedFiles.has(bFile) && !seedFiles.has(aFile)
        ? aFile
        : undefined;
    const reason = reasonFor(edge.kind);
    if (!reason) continue;
    // 1-hop: the non-seed endpoint inherits the channel directly.
    const farNode = seedFiles.has(aFile) && !seedFiles.has(bFile) ? edge.b
      : seedFiles.has(bFile) && !seedFiles.has(aFile) ? edge.a
      : undefined;
    if (farNode !== undefined) noteNode(farNode, [reason]);
    if (!target || !fileAgg.has(target)) continue;
    const reasons = reasonByFile.get(target) ?? new Set<string>();
    reasons.add(reason);
    reasonByFile.set(target, reasons);
  }

  // Files beyond one hop still need an explanation. Walk the unweighted
  // shortest paths once from all seeds, preserving semantic edge kinds while
  // omitting same-file containment hops from the user-facing reason.
  const visited = new Set(seeds);
  const queue = seeds.map((node) => ({ node, reasons: [] as string[] }));
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const edge of state.adjacency.get(current.node) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const reason = reasonFor(edge.kind as Graph["edges"][number]["kind"]);
      const reasons = reason && !current.reasons.includes(reason)
        ? [...current.reasons, reason]
        : current.reasons;
      noteNode(edge.to, reasons);
      queue.push({ node: edge.to, reasons });
      const file = g.nodes[edge.to]!.file;
      if (fileAgg.has(file) && !seedFiles.has(file) && !reasonByFile.has(file) && reasons.length) {
        reasonByFile.set(file, new Set(reasons.slice(0, 3)));
      }
    }
  }

  // History overlays are their own evidence: a file surfaced because it
  // co-moved with the change in the past, so label it directly. The sync
  // surprise gate weighs this channel at 0.5 — unchanged from the edge era.
  for (const file of historyFor.keys()) {
    if (!fileAgg.has(file) || seedFiles.has(file)) continue;
    const merged = new Set<string>([COCHANGE_REASON, ...(reasonByFile.get(file) ?? [])]);
    reasonByFile.set(file, merged);
    // History-seeded mass enters through the partner's file node; its symbols
    // warm through it, so stamp the whole file's warmed nodes as co-change.
    for (const i of g.byFile.get(file) ?? []) {
      const existing = reasonByNode.get(i) ?? [];
      if (!existing.includes(COCHANGE_REASON)) reasonByNode.set(i, [COCHANGE_REASON, ...existing]);
    }
  }

  // Verdict-grade warmth, keyed by stable node identity (kind|name@file) so
  // turn-sync's heat memory can age per hunk rather than per file: a charged
  // cascade node stays silent on revisits, while a novel hunk in a known file
  // still fires. File nodes are coarse duplicates of their symbols (they warm
  // whenever anything nearby does) and would re-smear memory file-wide, so
  // they join display aggregation but never the memory ledger.
  const warmedNodes: Record<string, { file: string; m: number; r: string[] }> = {};
  {
    // Tail cap: on monorepo-scale graphs a cascade can warm tens of thousands
    // of nodes; the verdict head (and the memory ledger it feeds) only ever
    // needs the dominant masses, and the pruned tail is per-node noise anyway.
    const warmed: Array<[string, { file: string; m: number; r: string[] }]> = [];
    g.nodes.forEach((n, i) => {
      if (exclude.has(n.id) || seedFiles.has(n.file)) return;
      const v = field[i]!;
      if (v <= 1e-6) return;
      warmed.push([`${n.kind}|${n.id}`, {
        file: n.file,
        m: Number(v.toFixed(6)),
        r: reasonByNode.get(i) ?? [],
      }]);
    });
    warmed.sort((a, b) => b[1].m - a[1].m);
    for (const [k, v] of warmed.slice(0, 2000)) warmedNodes[k] = v;
  }

  const fileEntries = [...fileAgg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const fileGroups: GroupLine[] = [];
  for (const [file, mass] of fileEntries) {
    const top = (fileTop.get(file) ?? [])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3)
      .map(([, i]) => g.nodes[i]!.name)
      .join(", ");
    const reasons = [...(reasonByFile.get(file) ?? new Set(["graph path"]))];
    fileGroups.push({
      label: file,
      mass,
      detail: `via ${reasons.join(", ")}${top ? ` · top: ${top}` : ""}`,
    });
  }
  const groups: GroupLine[] = [...anchorHits, ...fileGroups];
  const seedNames = seeds.slice(0, 5).map((i) => g.nodes[i]!.file).join(", ");
  const fit = revealGroups(groups, {
    header: `fovea impact · changed: ${seedNames}${seeds.length > 5 ? ", …" : ""} · likely review order`,
    budget: B,
    overflowTo: overflowArtifact("impact", `${root}|${(args.files ?? []).join(",")}`),
  });
  return {
    text: fit.text,
    tokens: fit.tokens,
    details: {
      seeds: seeds.length,
      historyPartners,
      warmed: groups.length,
      truncated: fit.truncated,
      ...extractionDetails(state),
      // Structured form for consumers (turn-sync): warmed anchors, files,
      // and the strongest direct evidence channel without text re-parsing.
      warmedAnchors: anchorHits.map((h) => h.label.replace(/^⚑\s*/, "")),
      warmedFiles: fileEntries.map(([file]) => file),
      // Heat retained by the seed files themselves — a graph-size-invariant
      // normalizer for warmedMass (per-file warmth as a fraction of the heat
      // the change site keeps).
      seedMass: Number(seedMass.toFixed(6)),
      // Per-file cascade mass (Σ node heat, seeds excluded). Turn-sync gates
      // on these masses; the file list alone cannot rank a drizzle against a
      // real cascade. Rounded so the warm-cache path and the inline path
      // carry bit-identical payloads.
      warmedMass: Object.fromEntries(fileEntries.map(([file, mass]) => [file, Number(mass.toFixed(6))])),
      warmedReasons: Object.fromEntries(fileEntries.map(([file]) => [
        file,
        [...(reasonByFile.get(file) ?? new Set(["graph path"]))],
      ])),
      warmedNodes,
    },
  };
};

// For tests and benches: token estimate passthrough.
export const estimateTokens = tokenEstimate;
