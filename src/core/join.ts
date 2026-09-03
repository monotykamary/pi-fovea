// The cross-language join layer. In an LSP the per-language graphs stop at
// the language boundary; pi-fovea joins them through shared literals: route
// paths, env keys, and long distinctive identifiers. Gradation comes from
// specificity: a literal seen in 2 files is a strong bridge (high conductance),
// a literal seen in 30 files is noise (near-zero), fixing the "1-hop channel
// has no ranking signal" failure mode of uniform-weight graphs.

import { ENV_TOKEN_RE, PATH_TOKEN_RE } from "./extract.js";
import type { EdgeEvidence, LiteralSite } from "./types.js";

export type LitClass = "path" | "env" | "word";

interface LitOccurrence { node: number; line: number; file: string; }

interface JoinEdge { a: number; b: number; w: number; evidence: EdgeEvidence; }

const PLACEHOLDER_SEGMENT = /^(?::[^/]+|\{[^}/]*\}|\$\{[^}/]*\}|\$[A-Za-z_]\w*|<[^/>]+>|\*+)$/; // $x = Kotlin template shorthand
const WORD_RE = /^[A-Za-z][\w$.\-]{6,63}$/;
const URLISH_RE = /^(?:https?|wss?):\/\/[^/]+/;

export const classifyLiteral = (text: string): LitClass | undefined => {
  const t = text.trim();
  if (t.length < 3 || t.length > 200) return undefined;
  if (ENV_TOKEN_RE.test(t)) return "env";
  const body = t.replace(URLISH_RE, "");
  if (PATH_TOKEN_RE.test(body)) return "path";
  if (WORD_RE.test(t) && (t.includes(".") || t.includes("::") || t.includes("-") || t.includes("_") || /[A-Z][a-z]/.test(t.slice(1)))) {
    return "word";
  }
  return undefined;
};

// Router conventions disagree on placeholders (:id in gin/echo/express, {id} in
// OpenAPI, ${id} in template literals, * wildcards). Normalizing segment-wise
// makes them the same join token.
export const normalizeLiteral = (text: string, cls: LitClass): string => {
  const t = text.trim();
  if (cls === "env") return t.toUpperCase();
  if (cls === "word") return t;
  const body = t.replace(URLISH_RE, "");
  const segments = body
    .split("/")
    .map((s) => (PLACEHOLDER_SEGMENT.test(s) ? "{*}" : s));
  let joined = segments.join("/");
  if (joined.length > 1 && joined.endsWith("/")) joined = joined.slice(0, -1);
  return joined;
};

const BASE: Record<LitClass, number> = { path: 1.0, env: 0.8, word: 0.55 };
const MAX_DF = 48; // distinct files per literal key (bridge/edge gate)
// Focus lookups are liberal: even an everywhere-literal (or a singleton) is a
// valid thing to look at; only edge construction needs rarity.
const LOOKUP_CAP = 192;

export interface JoinIndex {
  byKey: Map<string, { cls: LitClass; spec: number; occ: LitOccurrence[] }>;
  edges: JoinEdge[];
}

// resolveOccurrence maps a literal site to its enclosing node index
// (symbol, else the file node).
export const buildJoinIndex = (
  sites: LiteralSite[],
  resolveOccurrence: (file: string, line: number) => number | undefined,
): JoinIndex => {
  // One occurrence per (key, file): repetition inside a single file must not
  // inflate document frequency, or lockfile-ish files dominate the bridge.
  const grouped = new Map<string, { cls: LitClass; occ: LitOccurrence[]; seenFiles: Set<string> }>();
  let total = 0;
  for (const s of sites) {
    const cls = classifyLiteral(s.text);
    if (!cls) continue;
    const node = resolveOccurrence(s.file, s.line);
    if (node === undefined) continue;
    const key = normalizeLiteral(s.text, cls);
    const g = grouped.get(key) ?? { cls, occ: [], seenFiles: new Set<string>() };
    grouped.set(key, g);
    if (g.seenFiles.has(s.file)) continue;
    g.seenFiles.add(s.file);
    g.occ.push({ node, line: s.line, file: s.file });
    total++;
  }
  const byKey: JoinIndex["byKey"] = new Map();
  const edges: JoinEdge[] = [];
  const idfMax = Math.log(Math.max(total, 2));
  const pairBest = new Map<string, { w: number; evidence: EdgeEvidence }>();
  for (const [key, g] of grouped) {
    const df = g.occ.length;
    const spec = Math.min(1, Math.log(total / Math.max(df, 1)) / idfMax || 0);
    byKey.set(key, { cls: g.cls, spec, occ: g.occ.slice(0, LOOKUP_CAP) });
    if (df < 2 || df > MAX_DF) continue;
    // Clique weight decays past ~6 members so a popular literal can't turn
    // its members into accidental hubs of uncapped incident conductance.
    const w = (BASE[g.cls] * (0.25 + 0.75 * spec)) / Math.max(1, df / 6);
    for (let i = 0; i < g.occ.length; i++) {
      for (let j = i + 1; j < g.occ.length; j++) {
        const a = g.occ[i]!.node;
        const b = g.occ[j]!.node;
        if (a === b) continue;
        const pk = a < b ? `${a}|${b}` : `${b}|${a}`;
        const evidence: EdgeEvidence = {
          strategy: "normalized-literal",
          rule: `literal-${g.cls}`,
          source: key,
          candidates: df,
          key,
        };
        const previous = pairBest.get(pk);
        if (!previous || w > previous.w || (w === previous.w && key.localeCompare(previous.evidence.key ?? "") < 0)) {
          pairBest.set(pk, { w, evidence });
        }
      }
    }
  }
  for (const [pk, best] of pairBest) {
    const [a, b] = pk.split("|").map(Number) as [number, number];
    edges.push({ a, b, w: best.w, evidence: best.evidence });
  }
  return { byKey, edges };
};
