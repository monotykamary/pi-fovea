import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasAstGrepAsync } from "./astgrep.js";
import {
  clearPersistTimer,
  discoverFiles,
  discoveryExclusionReason,
  filterSupported,
  loadFacts,
  readEnrolledBoundaries,
  refreshFacts,
} from "./build.js";
import type { DiscoveryReport, ExtractionReport, FactStore, FileFacts } from "./build.js";
import { assembleGraphWithIndex } from "./graph.js";
import { gitOut, gitProbe, gitReflogAction } from "./git.js";
import { ROOT_CACHE_LIMIT, envInt, yieldToLoop } from "./asyncutil.js";
import { loadRepoRules } from "./anchors.js";
import { buildCsr, type Csr } from "./heat.js";
import type { JoinIndex } from "./join.js";
import { coChangeHistory, type CoChangeHistory } from "./cochange.js";
import type { EdgeEvidence, Graph } from "./types.js";

export interface RepoState {
  root: string;
  version: string;
  /** Identity of the ordered weighted graph backing index-addressed session vectors. */
  generation: string;
  graph: Graph;
  csr: Csr;
  joinIndex: JoinIndex;
  /** facts → FileFacts snapshot for this version; records are immutable per generation. */
  facts: Record<string, FileFacts>;
  /** What extraction dropped on the floor building this graph version. */
  extraction: ExtractionReport;
  /** What discovery considered, omitted, or could not enumerate for this state. */
  discovery: DiscoveryReport;
  adjacency: Map<number, Array<{ to: number; kind: string; w: number; evidence?: EdgeEvidence }>>;
  /** The live mutation container; facts/meta records are replaced immutably on refresh. */
  store: FactStore;
  /** Authoritative file listing for this version. */
  files: string[];
  gitKind: "git" | "plain";
  head: string | undefined;
  probedAt: number;
  walkedAt: number;
  sweptAt: number;
  /** Porcelain-dirty paths at last probe. Porcelain diffs the worktree against
   * HEAD, but facts track the last seen worktree: a file reverting to
   * porcelain-clean with unmoved HEAD would otherwise keep serving its dirty
   * facts until the next edit. */
  dirty: Set<string>;
  /** Set when this generation materialized from a `git checkout` (HEAD moved
   * with reflog action "checkout:…"): sync re-baselines silently instead of
   * cascading over the branch diff. Lives exactly one generation — the next
   * fact-moving refresh builds a fresh state without it, so the quiet path
   * cannot hide authored drift. */
  checkout?: boolean;
  /** Past joint-edit affinity (raw conductance + last joint commit). History
   * is NOT structure: impact re-seeds these partners at recency-decayed
   * strength whenever a change lands, so old co-work cools like any heat. */
  history: CoChangeHistory;
}

// State lifecycle: background builds, probe-gated refreshes, LRU eviction.
// pi runs hooks on one JS thread, so ensureState must never block the first
// resolvable answer behind a full rebuild.

const states = new Map<string, RepoState>(); // insertion order doubles as LRU order
const inflight = new Map<string, Promise<RepoState>>();
// Each resident root holds a full fact store + graph; all heavyweight root
// caches use ROOT_CACHE_LIMIT so one override cannot leave hidden retainers.
const WALK_GAP_MS = envInt("FOVEA_WALK_GAP_MS", 4000, 500, 300_000);
const SWEEP_GAP_MS = envInt("FOVEA_SWEEP_GAP_MS", 20_000, 2000, 600_000);

const touch = (root: string): RepoState | undefined => {
  const st = states.get(root);
  if (st) {
    states.delete(root);
    states.set(root, st);
  }
  return st;
};

const evictLru = (): void => {
  while (states.size > ROOT_CACHE_LIMIT) {
    const oldest = states.keys().next().value!;
    states.delete(oldest);
    inflight.delete(oldest);
    clearPersistTimer(oldest);
  }
};

/** Warm state if present (does not block). */
export const getState = (root: string): RepoState | undefined => touch(root);

/** Ongoing build/refresh for root, if any (does not block). */
export const getInflight = (root: string): Promise<RepoState> | undefined => inflight.get(root);

/** Drop resident state (tests); the on-disk fact cache survives. */
export const evictState = (root: string): void => {
  states.delete(root);
  inflight.delete(root);
  clearPersistTimer(root);
};

// All live fact passes serialize through one chain. Extraction-failure
// attribution is a process-wide ledger (astgrep cannot see nested passes),
// so overlapping passes would misblame files — and piled-up ast-grep spawns
// would freeze the host anyway. The chain itself never rejects.
let factChain: Promise<unknown> = Promise.resolve();
const factPass = <T>(job: () => Promise<T>): Promise<T> => {
  const run = factChain.then(job, job);
  factChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const graphGeneration = (graph: Graph): string => {
  const hash = createHash("sha1");
  for (const node of graph.nodes) {
    hash.update(JSON.stringify([node.id, node.kind, node.file, node.line, node.lang, node.sig])).update("\0");
  }
  for (const edge of graph.edges) {
    hash.update(JSON.stringify([edge.a, edge.b, edge.kind, edge.w, edge.evidence])).update("\n");
  }
  return hash.digest("hex").slice(0, 12);
};

const stateVersion = (
  facts: Record<string, FileFacts>,
  generation: string,
  files: readonly string[],
  rulesSha: string,
  extraction: ExtractionReport,
  discovery: DiscoveryReport,
): string => createHash("sha1")
  .update(Object.entries(facts).map(([file, value]) => `${file}:${value.sha1}`).sort().join("\n"))
  .update("\0").update(files.join("\n"))
  .update("\0").update(rulesSha)
  .update("\0").update(generation)
  .update("\0").update(JSON.stringify(extraction))
  .update("\0").update(JSON.stringify(discovery))
  .digest("hex")
  .slice(0, 12);

const assembleState = async (
  root: string,
  files: string[],
  store: FactStore,
  extraction: ExtractionReport,
  discovery: DiscoveryReport,
  gitKind: "git" | "plain",
  head: string | undefined,
  dirty: Set<string>,
): Promise<RepoState> => {
  // Snapshot the generation: refresh replaces fact records wholesale, so the
  // Record view stays a stable witness for baselines (sync).
  const facts: Record<string, FileFacts> = {};
  for (const [k, v] of store.facts) facts[k] = v;
  await yieldToLoop();
  const { graph, joinIndex } = await assembleGraphWithIndex(root, files, store.facts);
  const generation = graphGeneration(graph);
  const version = stateVersion(facts, generation, files, store.rulesSha, extraction, discovery);
  await yieldToLoop();
  const csr = buildCsr(graph);
  await yieldToLoop();
  const adjacency = new Map<number, Array<{ to: number; kind: string; w: number; evidence?: EdgeEvidence }>>();
  for (const edge of graph.edges) {
    (adjacency.get(edge.a) ?? adjacency.set(edge.a, []).get(edge.a)!).push({
      to: edge.b, kind: edge.kind, w: edge.w, evidence: edge.evidence,
    });
    (adjacency.get(edge.b) ?? adjacency.set(edge.b, []).get(edge.b)!).push({
      to: edge.a, kind: edge.kind, w: edge.w, evidence: edge.evidence,
    });
  }
  // impact's path-reason walk used to sort a fresh copy of this list per
  // visited node; identical comparator, pre-sorted once here.
  for (const list of adjacency.values()) {
    list.sort((a, b) => Number(a.kind === "contains") - Number(b.kind === "contains") || b.w - a.w || a.to - b.to);
  }
  // History memory rides alongside the graph, not in it. Impact re-seeds the
  // partners of a change at recency-decayed strength; focus/sketch stay pure
  // structure. Cached by HEAD + tracked set, so a rebuild is cheap.
  const history = await coChangeHistory(root, files);
  const stamp = Date.now();
  return { root, version, generation, graph, csr, joinIndex, facts, extraction, discovery, adjacency, store, files, gitKind, head, dirty, history, probedAt: stamp, walkedAt: stamp, sweptAt: stamp };
};

const buildState = async (root: string): Promise<RepoState> => {
  if (!(await hasAstGrepAsync())) {
    throw new Error(
      "fovea: `ast-grep` binary not found on PATH (set FOVEA_AST_GREP to override). Install: https://ast-grep.github.io/",
    );
  }
  const { fileRoutes } = await loadRepoRules(root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const probe = await gitProbe(root);
  const gitKind: RepoState["gitKind"] = probe ? "git" : "plain";
  // Cold start: the fact cache header remembers which nested boundaries this
  // root had enrolled, so a restart restores coverage without a fresh edit.
  const listing = await discoverFiles(root, routeRes, new Set(await readEnrolledBoundaries(root)));
  const files = listing.files;
  const { store, report } = await factPass(() => loadFacts(root, files));
  return assembleState(root, files, store, report, listing.report, gitKind, probe?.head,
    new Set(probe ? probe.changes.map((c) => c.path).filter((p) => p && !p.endsWith("/")) : []));
};

const refreshState = async (state: RepoState, hints: string[] = [], force = false): Promise<RepoState> => {
  const now = Date.now();
  // No probe-short-circuit across turns: git porcelain is ~40ms behind the
  // spawn gate and is the correctness oracle; plain roots gate on their own
  // walk/sweep intervals below. In-flight dedupe already coalesces bursts.
  const { fileRoutes } = await loadRepoRules(state.root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const store = state.store;
  let files = state.files;
  let discovery = state.discovery;
  const changed: string[] = [];
  const deleted: string[] = [];
  // A checkout re-materializes the worktree from another ref; flag the
  // rebuilt generation so sync re-baselines quietly. Only a HEAD move whose
  // latest reflog action is "checkout:…" qualifies — pulls/rebases merge
  // foreign work and keep the loud drift path, and reflog-less repos stay
  // conservative (undefined -> false).
  let checkout = false;
  const hinted = [...new Set([...filterSupported(hints, routeRes), ...hints.filter((h) => store.facts.has(h))])];
  changed.push(...hinted);

  // Progressive disclosure: a nested repository stays outside this root's
  // graph until work touches it. A hint landing across a .git marker enrolls
  // the boundary — every marker on the path, so doubly-nested clones cross
  // together — and a vanished marker un-enrolls, so a removed clone leaves
  // no orphan facts behind.
  let disclosureChanged = false;
  for (const boundary of [...store.enrolled]) {
    const exists = await stat(join(state.root, boundary, ".git")).then(() => true, () => false);
    if (!exists) {
      store.enrolled.delete(boundary);
      disclosureChanged = true;
    }
  }
  let known: Set<string> | undefined;
  for (const h of hinted) {
    let covered = false;
    for (const b of store.enrolled) {
      if (h.startsWith(b + "/")) { covered = true; break; }
    }
    if (!covered) {
      known ??= new Set(state.files);
      covered = known.has(h);
    }
    if (covered) continue;
    let prefix = "";
    for (const seg of h.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (store.enrolled.has(prefix)) continue;
      const boundary = await stat(join(state.root, prefix, ".git")).then(() => true, () => false);
      if (!boundary) continue;
      store.enrolled.add(prefix);
      disclosureChanged = true;
    }
  }

  if (state.gitKind === "git") {
    const probe = await gitProbe(state.root);
    if (probe) {
      const headMoved = probe.head !== state.head;
      state.head = probe.head;
      if (headMoved) {
        checkout = (await gitReflogAction(state.root))?.startsWith("checkout:") ?? false;
      }
      // Relist only when coverage membership may move. Ordinary first edits
      // retain the cheap per-file path; adds/deletes/renames, restored paths,
      // ignore-rule edits, and HEAD changes refresh the full ledger once.
      const statusPaths = new Set(probe.changes.map((change) => change.path).filter(Boolean));
      const dirtyPathRemoved = [...state.dirty].some((path) => !statusPaths.has(path));
      const membershipPathAdded = probe.changes.some((change) =>
        !state.dirty.has(change.path) && /[?ADRCT]/.test(change.code));
      const ignoreRulesChanged = probe.changes.some((change) =>
        change.path === ".gitignore" || change.path.endsWith("/.gitignore") || change.path === ".gitmodules");
      let needsList = probe.relist || disclosureChanged || headMoved || dirtyPathRemoved
        || membershipPathAdded || ignoreRulesChanged || probe.changes.some((change) => change.path.endsWith("/"));
      if (probe.changes.length) {
        // Porcelain collapses any drift inside a nested checkout (submodule
        // or embedded repo: HEAD move, dirty content, untracked files) to
        // one entry naming its gitlink. A directory change therefore _is_ an
        // edit event: enroll the boundary and relist. Pushing its path into
        // the file pipeline would fail stat and masquerade as unreadable.
        const dirFlags = await Promise.all(
          probe.changes.map((c) => !c.path.endsWith("/") && stat(join(state.root, c.path)).then((s) => s.isDirectory(), () => false)),
        );
        probe.changes.forEach((c, i) => {
          if (!dirFlags[i]) return;
          needsList = true;
          if (!store.enrolled.has(c.path)) {
            store.enrolled.add(c.path);
            disclosureChanged = true;
          }
        });
      }
      if (needsList) {
        const listing = await discoverFiles(state.root, routeRes, store.enrolled);
        files = listing.files;
        discovery = listing.report;
        const listed = new Set(files);
        for (const previous of state.files) if (!listed.has(previous)) deleted.push(previous);
        changed.push(...files);
      } else {
        // HEAD moved with a clean status means a checkout: worktree content
        // re-materialized under fresh mtimes, so sweep everything once.
        if (headMoved) changed.push(...state.files);
        for (const c of probe.changes) {
          const p = c.path;
          if (!p || p.endsWith("/")) continue;
          if (c.code.includes("D")) {
            if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
          } else if (store.facts.has(p) || filterSupported([p], routeRes).length) {
            changed.push(p);
          }
        }
      }
      const nowDirty = new Set([...statusPaths].filter((path) => !path.endsWith("/")));
      if (!headMoved && !needsList) {
        // Porcelain-clean with unmoved HEAD hides reverts: a previously dirty
        // file vanishes from the probe while its captured facts stay dirty.
        // Resurrect it once so the snapshot follows the worktree (covers
        // checkout/restore and untracked files that disappear).
        for (const p of state.dirty) {
          if (nowDirty.has(p)) continue;
          // stat is the arbiter: a restored file whose facts were dropped
          // with the deletion must come back through changed, not sit
          // deleted until its next porcelain-visible edit.
          const onDisk = await stat(join(state.root, p)).then((s) => s.isFile(), () => false);
          if (onDisk) changed.push(p);
          else if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
        }
      }
      state.dirty = nowDirty;
    } else {
      // .git vanished (moved/renamed out from under us): degrade to plain.
      state.gitKind = "plain";
    }
  }
  if (state.gitKind === "plain") {
    const walkDue = now - state.walkedAt > WALK_GAP_MS;
    if (force || walkDue || changed.length || disclosureChanged) {
      const listing = await discoverFiles(state.root, routeRes, store.enrolled);
      files = listing.files;
      discovery = listing.report;
      state.walkedAt = now;
      if (force || now - state.sweptAt > SWEEP_GAP_MS) {
        state.sweptAt = now;
        changed.push(...state.files);
      }
    }
  }

  if (!changed.length && !deleted.length && files === state.files) {
    state.probedAt = Date.now();
    return state;
  }
  const { report, stats } = await factPass(() =>
    refreshFacts(state.root, store, files, [...new Set(changed)], [...new Set(deleted)]),
  );
  const noDelta =
    !stats.reExtracted.length && !stats.deleted.length && !stats.added.length && files.length === state.files.length;
  if (noDelta) {
    state.probedAt = Date.now();
    state.extraction = report; // reports are state-wide (taint/unreadable live in the store)
    state.discovery = discovery;
    state.files = files;
    state.version = stateVersion(state.facts, state.generation, files, store.rulesSha, report, discovery);
    return state;
  }
  const fresh = await assembleState(state.root, files, store, report, discovery, state.gitKind, state.head, state.dirty);
  if (checkout) fresh.checkout = true;
  states.set(state.root, fresh);
  return fresh;
};

export const ensureState = (root: string, opts: { hints?: string[]; force?: boolean } = {}): Promise<RepoState> => {
  const pending = inflight.get(root);
  if (pending) return pending;
  const warm = touch(root);
  const p: Promise<RepoState> = warm
    ? refreshState(warm, opts.hints, opts.force)
    : (async () => {
        const st = await stat(root).catch(() => undefined);
        if (!st?.isDirectory()) throw new Error(`fovea: root does not exist or is not a directory: ${root}`);
        const state = await buildState(root);
        states.set(root, state);
        evictLru();
        return state;
      })();
  inflight.set(root, p);
  const clear = (): void => {
    if (inflight.get(root) === p) inflight.delete(root);
  };
  p.then(clear, clear);
  return p;
};

type PathCoverageStatus =
  | "indexed"
  | "partial"
  | "unreadable"
  | "unavailable"
  | "oversized"
  | "generated"
  | "unsupported"
  | "excluded"
  | "closed-boundary"
  | "omitted"
  | "missing"
  | "outside-root"
  | "not-file"
  | "not-indexed";

export interface PathCoverage {
  requested: string;
  path?: string;
  status: PathCoverageStatus;
  reason: string;
}

const relativeRequest = (root: string, input: string): string | undefined => {
  const raw = input.startsWith("@") ? input.slice(1) : input;
  const rootPath = resolve(root);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(rootPath, raw);
  const rel = relative(rootPath, absolute);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
};

/** Explain explicit paths against the exact discovery/extraction generation. */
export const explainPathCoverage = async (
  state: RepoState,
  requested: readonly string[],
): Promise<PathCoverage[]> => {
  const { fileRoutes } = await loadRepoRules(state.root);
  const routeRes = fileRoutes.map((rule) => new RegExp(rule.re));
  const indexed = new Set(state.files);
  const failed = new Set(state.extraction.failed);
  const unreadable = new Set(state.extraction.unreadable);
  const oversized = new Set(state.extraction.oversized);
  const generated = new Set(state.extraction.generated);
  const out: PathCoverage[] = [];

  for (const input of requested) {
    const rel = relativeRequest(state.root, input);
    if (!rel) {
      out.push({ requested: input, status: "outside-root", reason: "path does not name a file inside the repository root" });
      continue;
    }
    const closed = state.discovery.closedBoundaries.find((boundary) =>
      rel === boundary || rel.startsWith(`${boundary}/`));
    if (closed) {
      out.push({ requested: input, path: rel, status: "closed-boundary", reason: `nested repository ${closed} is not enrolled or readable` });
      continue;
    }
    const unreadableDirectory = state.discovery.unreadableDirectories.find((directory) =>
      directory === "." || rel === directory || rel.startsWith(`${directory}/`));
    if (unreadableDirectory) {
      out.push({ requested: input, path: rel, status: "unreadable", reason: `discovery could not traverse ${unreadableDirectory}` });
      continue;
    }
    if (state.discovery.unavailableFiles.includes(rel)) {
      out.push({ requested: input, path: rel, status: "unavailable", reason: "Git listed the path but the worktree entry was unavailable" });
      continue;
    }
    const onDisk = await stat(join(state.root, rel)).catch(() => undefined);
    if (!onDisk) {
      out.push({ requested: input, path: rel, status: "missing", reason: "path does not exist in this worktree" });
      continue;
    }
    if (!onDisk.isFile()) {
      out.push({ requested: input, path: rel, status: "not-file", reason: "path is not a regular file" });
      continue;
    }
    if (failed.has(rel)) {
      out.push({ requested: input, path: rel, status: "partial", reason: "one or more extraction stages failed for this file" });
      continue;
    }
    if (unreadable.has(rel)) {
      out.push({ requested: input, path: rel, status: "unreadable", reason: "file could not be read during extraction" });
      continue;
    }
    if (oversized.has(rel)) {
      out.push({ requested: input, path: rel, status: "oversized", reason: "file exceeds the byte cap for its type (FOVEA_MAX_FILE_BYTES or FOVEA_MAX_PROTO_FILE_BYTES)" });
      continue;
    }
    if (generated.has(rel)) {
      out.push({ requested: input, path: rel, status: "generated", reason: "file was classified as machine-generated source" });
      continue;
    }
    if (indexed.has(rel)) {
      out.push({ requested: input, path: rel, status: "indexed", reason: "file is present in this graph generation" });
      continue;
    }
    const exclusion = discoveryExclusionReason(rel);
    if (exclusion) {
      out.push({ requested: input, path: rel, status: "excluded", reason: exclusion });
      continue;
    }
    if (!filterSupported([rel], routeRes).length) {
      out.push({ requested: input, path: rel, status: "unsupported", reason: "file type has no structural or protocol extractor" });
      continue;
    }
    let prefix = "";
    let closedBoundary: string | undefined;
    for (const segment of rel.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      if (state.store.enrolled.has(prefix)) continue;
      const marker = await stat(join(state.root, prefix, ".git")).then(() => true, () => false);
      if (marker) {
        closedBoundary = prefix;
        break;
      }
    }
    if (closedBoundary) {
      out.push({ requested: input, path: rel, status: "closed-boundary", reason: `nested repository ${closedBoundary} is not enrolled` });
      continue;
    }
    if (state.gitKind === "git") {
      const ignored = await gitOut(state.root, ["check-ignore", "--", rel]);
      if (ignored?.trim()) {
        out.push({ requested: input, path: rel, status: "excluded", reason: "excluded by Git ignore rules" });
        continue;
      }
    }
    if (state.discovery.capped) {
      const omitted = state.discovery.omittedSupported;
      out.push({
        requested: input,
        path: rel,
        status: "omitted",
        reason: omitted === null
          ? `discovery stopped at FOVEA_MAX_FILES=${state.discovery.maxFiles}`
          : `omitted by FOVEA_MAX_FILES=${state.discovery.maxFiles} (${omitted} supported files omitted)`,
      });
      continue;
    }
    out.push({ requested: input, path: rel, status: "not-indexed", reason: "file was outside the current discovery snapshot" });
  }
  return out;
};

/**
 * Fire-and-forget indexing. started=true when this call kicked a cold build;
 * the completion is always awaitable via the returned promise.
 */
export const ensureStateBackground = (root: string): { started: boolean; promise: Promise<RepoState> } => {
  if (states.has(root) || inflight.has(root)) {
    return { started: false, promise: ensureState(root) };
  }
  return { started: true, promise: ensureState(root) };
};
