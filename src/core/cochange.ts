// Git-history co-change as a heat memory, not a structural bond.
//
// Heat diffusion over the static graph says what is near what BY
// CONSTRUCTION (imports, calls, routes, literals). Joint git history says
// what ACTUALLY moves together — the signal `impact` needs when two files
// share no static edge but repeatedly move in the same integration units.
//
// Under the all-in heat model that signal is a seeded field, not permanent
// structure. Each (a, b) pair records directional touch counts plus the
// latest member timestamp of the most recent joint unit; at wall-clock `now`
// its heat contribution is
//
//     w = w0(count, jaccard) * 2^(-ageDays / COCHANGE_HALF_LIFE_DAYS)
//
// the same geometric-decay family as the sync heat memory (mu <- 0.7 mu).
// A pair that last moved together days ago is hot; one from months ago adds
// almost nothing. Nothing pins history into the graph, so old co-work cools
// out of the field exactly like every other heat source.
//
// Bounded by commit window and per-file pair caps; the raw facts (counts +
// lastTs) are cached by HEAD + tracked-file set + an independent cache
// version, and recency is applied at USE time so even a cached hit cools as
// the wall clock advances.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join as joinPath } from "node:path";
import { envInt } from "./asyncutil.js";
import { gitHead, gitOut, gitPrefix } from "./git.js";

const LOG_COMMITS = 400;
const MAX_FILES_PER_UNIT = 24; // oversized integration units carry no pair signal
const MIN_SHARED = 2;            // a single collision is noise
const MAX_PAIRS_PER_FILE = 16;   // union of endpoint top-16 selections, not a hard degree cap
const COCHANGE_CACHE_VERSION = 4;
const EXPECTATION_MIN_SUPPORT = 3;
const WILSON_Z_95 = 1.96;
const DAY_MS = 86_400_000;

/** Wall-clock half-life (days) of a co-change pair. Past joint work cools
 * with exponential decay; FOVEA_COCHANGE_HALF_LIFE_DAYS tunes how fast. */
export const COCHANGE_HALF_LIFE_DAYS = envInt("FOVEA_COCHANGE_HALF_LIFE_DAYS", 30, 1, 3650);

export interface CoChangePartner {
  /** Partner file (repo-relative), the other end of the history bond. */
  partner: string;
  /** Base conductance from count + Jaccard, BEFORE recency decay. */
  w: number;
  /** Latest member committer epoch ms of this pair's most recent joint unit. */
  lastTs: number;
  /** Joint integration units for this directional pair in the bounded window. */
  n_ij?: number;
  /** Integration units in the window that touch the source file. */
  n_i?: number;
  /** Integration units in the window that touch the partner file. */
  n_j?: number;
  /** Total integration units observed in the bounded history window. */
  N?: number;
}

/** Per-file history memory: file -> past co-change partners. Raw facts only;
 * recency is applied when the field is seeded (see recencyFactor). */
export type CoChangeHistory = Map<string, CoChangePartner[]>;

/** Freshness of a past joint commit: 1 when it just happened, 1/2 at one
 * half-life, ~0 once the work is ancient. Same geometric family as the sync
 * memory decay (mu <- 0.7 mu); the heat kernel's own e^{-tL} is the decay of
 * the diffusing field itself. */
export const recencyFactor = (ageDays: number): number =>
  Math.pow(0.5, ageDays / COCHANGE_HALF_LIFE_DAYS);

/** Effective seeding weight of a pair whose newest joint commit is ageDays
 * old. */
export const effectiveWeight = (baseW: number, ageDays: number): number =>
  baseW * recencyFactor(ageDays);

/** Base conductance: Jaccard-tilted confidence, mildly compressed by count so
 * a pair changed 40 times beats one changed twice without swampg the graph. */
export const scorePair = (n: number, soloA: number, soloB: number): number => {
  const union = soloA + soloB - n;
  if (union <= 0) return 0;
  const jaccard = n / union;
  return Math.min(0.5, 0.08 + 0.55 * jaccard + 0.10 * Math.min(n / 10, 1));
};

const wilsonLower95 = (successes: number, trials: number): number => {
  if (trials <= 0 || successes < 0 || successes > trials) return 0;
  const p = successes / trials;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const radius = WILSON_Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - radius) / denominator);
};

const pathOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * Find historical companions conspicuously absent from `changedFiles`.
 *
 * For each changed i -> unchanged j pair, q(j|i) is the 95% Wilson lower
 * bound on n_ij / n_i. A ubiquitous j is not informative, so q must beat
 * j's base rate n_j / N; multiplying q by (1 - 1/lift) leaves exactly that
 * conservative excess. Independent changed-file evidence adds, with the
 * result capped at one, and the newest joint commit supplies the usual
 * wall-clock recency decay.
 *
 * Count fields are optional on CoChangePartner for compatibility with
 * hand-built pre-v3 heat histories. Records without complete v3 counts do
 * not provide residual evidence.
 */
export const expectationResiduals = (
  changedFiles: string[],
  history: CoChangeHistory,
  now = Date.now(),
): Map<string, number> => {
  const changed = new Set(changedFiles);
  const totals = new Map<string, number>();
  const sources = [...changed].sort(pathOrder);

  for (const source of sources) {
    const partners = [...(history.get(source) ?? [])].sort((a, b) =>
      pathOrder(a.partner, b.partner)
      || (a.n_ij ?? 0) - (b.n_ij ?? 0)
      || (a.n_i ?? 0) - (b.n_i ?? 0)
      || (a.n_j ?? 0) - (b.n_j ?? 0)
      || a.lastTs - b.lastTs);
    for (const p of partners) {
      if (changed.has(p.partner)) continue;
      const nIJ = p.n_ij;
      const nI = p.n_i;
      const nJ = p.n_j;
      const total = p.N;
      if (
        nIJ === undefined || nI === undefined || nJ === undefined || total === undefined
        || !Number.isInteger(nIJ) || !Number.isInteger(nI)
        || !Number.isInteger(nJ) || !Number.isInteger(total)
        || nIJ < EXPECTATION_MIN_SUPPORT || nIJ > nI || nIJ > nJ
        || nI <= 0 || nJ < 0 || total <= 0 || nI > total || nJ > total
      ) continue;

      const q = wilsonLower95(nIJ, nI);
      const baseRate = nJ / total;
      if (q <= baseRate) continue;
      const lift = baseRate > 0 ? q / baseRate : Number.POSITIVE_INFINITY;
      const liftDiscount = Number.isFinite(lift) ? 1 - 1 / lift : 1;
      const ageDays = Math.max(0, (now - p.lastTs) / DAY_MS);
      const contribution = effectiveWeight(q * liftDiscount, ageDays);
      if (!(contribution > 0) || !Number.isFinite(contribution)) continue;
      totals.set(p.partner, (totals.get(p.partner) ?? 0) + contribution);
    }
  }

  const ranked: Array<[string, number]> = [...totals]
    .map(([file, weight]): [string, number] => [file, Math.min(1, weight)])
    .sort((a, b) => b[1] - a[1] || pathOrder(a[0], b[0]));
  return new Map(ranked);
};

type CachedPair = [string, string, number, number, number, number, number];

interface CacheShape {
  v: number;
  head: string;
  key: string;
  commits: number;
  pairs: CachedPair[];
}

const cachePath = (root: string): string =>
  joinPath(tmpdir(), `pi-fovea-cochange-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

// coChangeHistory returns, for every tracked file, its past co-change partners
// with base conductance and the most recent joint unit time. filesInGraph
// restricts to files we actually track, so vendored churn is excluded.
export const coChangeHistory = async (
  root: string,
  filesInGraph: string[],
  now = Date.now(),
): Promise<CoChangeHistory> => {
  const head = (await gitHead(root)) ?? "";
  if (!head) return new Map(); // not a git repo
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return new Map();
  // Deepening can change evidence without changing HEAD. Do not mistake a
  // shallow boundary's synthetic root diff for an integrated feature.
  const shallowPath = await gitOut(root, ["rev-parse", "--git-path", "shallow"]);
  if (shallowPath === undefined) return new Map();
  let shallowText = "";
  try { shallowText = await readFile(resolve(root, shallowPath.trim()), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return new Map();
  }
  const shallow = new Set(shallowText.trim().split(/\s+/));
  const tracked = new Set(filesInGraph);
  const key = createHash("sha1")
    .update(`v${COCHANGE_CACHE_VERSION}\0`)
    .update(shallowText)
    .update(JSON.stringify([...tracked].sort()))
    .digest("hex")
    .slice(0, 12);
  const cp = cachePath(root);
  try {
    const cached = JSON.parse(await readFile(cp, "utf8")) as CacheShape;
    if (
      cached.v === COCHANGE_CACHE_VERSION && cached.head === head && cached.key === key
      && Number.isInteger(cached.commits) && Array.isArray(cached.pairs)
    ) return groupPairs(cached.pairs, cached.commits);
  } catch { /* recompute */ }

  // No pathspec: history simplification could remove integration boundaries
  // or make subroot denominators differ from the repository's observations.
  const log = await gitOut(root, [
    "log", "--first-parent", "--diff-merges=first-parent", "--root",
    "--format=%x00FOVEA%x00%H%x00%P%x00%ct%x00%s%x00", "--name-status", "-z",
    "-n", String(LOG_COMMITS), "--no-renames", "--no-ext-diff", "--no-textconv",
    "--no-relative", "--no-notes", "--no-show-signature", "--no-color", head, "--",
  ], { maxBuffer: 16 * 1024 * 1024 });
  if (log === undefined) return new Map(); // never cache a failed/partial scan
  type Unit = { subject: string; merge: boolean; ts: number; files: Set<string> };
  const units: Unit[] = [];
  const fields = log.split("\0");
  let cursor = 0;
  while (cursor < fields.length) {
    if (fields[cursor] === "") { cursor++; continue; }
    if (fields[cursor++] !== "FOVEA") return new Map();
    const hash = fields[cursor++];
    const parents = fields[cursor++];
    const seconds = Number(fields[cursor++]);
    const subject = fields[cursor++];
    if (!hash || parents === undefined || subject === undefined || !Number.isFinite(seconds)
      || fields[cursor++] !== "") return new Map();
    const files = new Set<string>();
    let first = true;
    while (cursor < fields.length && fields[cursor] !== "") {
      let status = fields[cursor++]!;
      if (first) {
        if (!status.startsWith("\n")) return new Map();
        status = status.slice(1);
        first = false;
      }
      let file = fields[cursor++];
      if (!/^[AMDTUXB]$/.test(status) || !file) return new Map();
      // NUL names are literal, including tabs, newlines and backslashes.
      // Filter here, not in Git: --diff-filter drops empty observations and
      // lets the scan walk arbitrarily far looking for 400 matching diffs.
      if ((status === "A" || status === "M") && file.startsWith(prefix)) {
        file = file.slice(prefix.length);
        if (tracked.has(file)) files.add(file);
      }
    }
    if (!shallow.has(hash)) units.push({ subject, merge: parents.includes(" "), ts: seconds * 1000, files });
  }

  // Match against the entire bounded window before mutating anything. An
  // exact unique older subject is evidence; proximity and issue IDs are not.
  const subjects = new Map<string, number[]>();
  units.forEach((unit, i) => {
    const hits = subjects.get(unit.subject) ?? [];
    hits.push(i);
    subjects.set(unit.subject, hits);
  });
  const consumed = new Set<number>();
  units.forEach((unit, i) => {
    if (unit.merge) return;
    const target = /^(?:fixup!|squash!) (.+)$/.exec(unit.subject)?.[1];
    if (!target) return;
    const hits = subjects.get(target);
    if (hits?.length !== 1 || hits[0]! <= i) return;
    const parent = units[hits[0]!]!;
    for (const file of unit.files) parent.files.add(file);
    parent.ts = Math.max(parent.ts, unit.ts);
    consumed.add(i);
  });

  const pairCount = new Map<string, number>();
  const pairLast = new Map<string, number>();
  const touchCount = new Map<string, number>();
  let commits = 0; // cache field retained: now independent integration units
  units.forEach((unit, index) => {
    if (consumed.has(index)) return;
    commits++;
    const fs = [...unit.files].sort();
    // Solo and oversized units still contribute truthful denominators.
    for (const f of fs) touchCount.set(f, (touchCount.get(f) ?? 0) + 1);
    if (fs.length < 2 || fs.length > MAX_FILES_PER_UNIT) return;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const k = JSON.stringify([fs[i], fs[j]]);
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
        pairLast.set(k, Math.max(pairLast.get(k) ?? 0, unit.ts));
      }
    }
  });

  const scored: CachedPair[] = [];
  for (const [k, n] of pairCount) {
    if (n < MIN_SHARED) continue;
    const [a, b] = JSON.parse(k) as [string, string];
    const nA = touchCount.get(a) ?? 0;
    const nB = touchCount.get(b) ?? 0;
    const w = scorePair(n, nA, nB);
    if (w <= 0) continue;
    scored.push([a, b, w, pairLast.get(k) ?? 0, n, nA, nB]);
  }

  // Keeper filter: per-file top partners by EFFECTIVE hotness (recency
  // included at compute time), so a fresh-but-weak pair outranks an ancient
  // strong one. The surviving raw facts keep their lastTs so later use still
  // cools them further as the wall clock advances.
  const perFile = new Map<string, number[]>();
  scored.forEach((p, i) => {
    for (const f of [p[0], p[1]]) (perFile.get(f) ?? perFile.set(f, []).get(f)!).push(i);
  });
  const eff = (p: CachedPair): number =>
    p[2] * recencyFactor(Math.max(0, now - p[3]) / DAY_MS);
  const keep = new Set<number>();
  for (const [, idxs] of perFile) {
    idxs.sort((x, y) => eff(scored[y]!) - eff(scored[x]!));
    for (const i of idxs.slice(0, MAX_PAIRS_PER_FILE)) keep.add(i);
  }
  const pairs = scored.filter((_, i) => keep.has(i));

  try {
    await mkdir(dirname(cp), { recursive: true });
    await writeFile(cp, JSON.stringify({
      v: COCHANGE_CACHE_VERSION,
      head,
      key,
      commits,
      pairs,
    } satisfies CacheShape));
  } catch { /* cache is an optimization */ }
  return groupPairs(pairs, commits);
};

const groupPairs = (pairs: CachedPair[], commits: number): CoChangeHistory => {
  const out: CoChangeHistory = new Map();
  const push = (
    a: string,
    b: string,
    w: number,
    lastTs: number,
    nIJ: number,
    nI: number,
    nJ: number,
  ): void => {
    const partner: CoChangePartner = { partner: b, w, lastTs, n_ij: nIJ, n_i: nI, n_j: nJ, N: commits };
    const list = out.get(a);
    if (list) list.push(partner);
    else out.set(a, [partner]);
  };
  for (const [a, b, w, lastTs, nIJ, nA, nB] of pairs) {
    push(a, b, w, lastTs, nIJ, nA, nB);
    push(b, a, w, lastTs, nIJ, nB, nA);
  }
  return out;
};
