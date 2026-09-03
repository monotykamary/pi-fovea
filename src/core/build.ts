// Repo -> typed graph. Extraction is a pure function of file content, so the
// on-disk cache (keyed by content sha1) makes re-indexing incremental: dirty
// files re-run ast-grep, everything else is reused verbatim. This is the
// green-node-reuse analogue of incremental parsing, one level up.
//
// Cache format v9 is JSONL (header line + one fact line per file), inspired by
// pi-fast-resume's partial-parse trick: reading/writing streams line-wise so
// 40MB of facts never monopolize the event loop. Per-file entries carry a
// stat manifest {size, mtime}; unchanged stats skip the re-read+rehash that
// used to run over every tracked file on every turn.
//
// Honesty rule: facts implicated in a FAILED ast-grep pass are tainted. They
// serve the live session (a thin graph beats none) but are never persisted,
// so one bad invocation can't poison warm starts forever.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { IO_CONCURRENCY, SPAWN_CONCURRENCY, envInt, mapLimit, yieldToLoop } from "./asyncutil.js";
import { gitOut } from "./git.js";
import {
  AST_GREP_CHUNK,
  LANG_BY_EXT,
  drainExtractionFailures,
  isBinaryExt,
  isConfigFile,
  langOf,
  scanRules,
} from "./astgrep.js";
import {
  coreFactsFromScan,
  coreScanRules,
  extractCalls,
  extractImports,
  extractLiterals,
  extractSymbols,
} from "./extract.js";
import { assembleGraphWithIndex as assembleGraph } from "./graph.js";
import {
  anchorScanPlan,
  anchorsFromScan,
  extractAnchors,
  extractFileRoutes,
  loadRepoRules,
} from "./anchors.js";
import { aggregateFiles, harvestFile, promote, type FileSigs } from "./discover.js";
import { makeFileSource } from "./source.js";
import { extractProtocolAnchors } from "./protocols.js";
import type { CallSite, Graph, ImportSite, LiteralSite, SymbolRec } from "./types.js";
import type { AnchorDraft } from "./anchors.js";
import type { JoinIndex } from "./join.js";

export interface FileFacts {
  sha1: string;
  symbols: SymbolRec[];
  imports: ImportSite[];
  calls: CallSite[];
  literals: LiteralSite[];
  anchors: AnchorDraft[];
  // Tier-3 discovery: per-file histogram of call-shape signatures
  // (sig -> [totalSites, pathSites]); aggregated repo-wide at load to promote
  // statistically significant unknown shapes into implicit half-weight rules.
  sigs?: FileSigs;
}

const CACHE_VERSION = 14; // v14: orpc/hono call shapes, proto keyword guard, graphql union/implements, protocol doc size cap

// Honest coverage: what the extractor could NOT see. Tools and status render
// this so a thin graph never reads as a small repo; omissions are explicit.
export interface ExtractionReport {
  /** Files implicated in at least one failed ast-grep invocation (chunk-granular). */
  failed: string[];
  /** Files skipped because their content could not be read (permissions, race). */
  unreadable: string[];
  /** Files deliberately omitted because one source exceeded the byte cap. */
  oversized: string[];
  /** Files skipped because they look machine-generated (minified bundles):
   * ast-grep pattern matching over a single huge line emits gigabytes of
   * matches and takes ~a minute per invocation. */
  generated: string[];
}

export interface DiscoveryReport {
  source: "git" | "walk";
  /** Complete for the visible worktree, partial on unavailable entries/directories, truncated at the file cap. */
  recording: "complete" | "partial" | "truncated";
  maxFiles: number;
  candidateFilesSeen: number;
  supportedFilesSeen: number;
  indexedFiles: number;
  unsupportedFilesSeen: number;
  excludedEntriesSeen: number;
  closedBoundariesSeen: number;
  unreadableDirectoriesSeen: number;
  unavailableFilesSeen: number;
  capped: boolean;
  /** Exact for Git listings, zero for complete walks, unknown for truncated walks. */
  omittedSupported: number | null;
  unsupportedExamples: string[];
  excludedExamples: string[];
  closedBoundaries: string[];
  unreadableDirectories: string[];
  unavailableFiles: string[];
  excludedPolicies: string[];
}

export interface FileDiscovery {
  files: string[];
  report: DiscoveryReport;
}

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "vendor", ".venv", "venv", "target", "coverage", ".next", "build", "__pycache__", ".pi", ".pi-fovea", "deps", "_build", ".tox", "Pods", ".cargo"]);
// File count is also a resident-graph budget, not just a discovery limit.
// Override deliberately for giant monorepos; normal roots stay bounded.
const MAX_FILES = envInt("FOVEA_MAX_FILES", 8000, 100, 100_000);
const MAX_FILE_BYTES = envInt("FOVEA_MAX_FILE_BYTES", 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
// Protocol documents never reach ast-grep; their exact readers are
// regex-bounded, so real-world schemas larger than the code cap still parse
// instead of being silently dropped as oversized.
const PROTOCOL_MAX_FILE_BYTES = envInt("FOVEA_MAX_PROTO_FILE_BYTES", 8 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024);
const PROTOCOL_DOC_RE = /\.(?:proto|graphql|gql)$/i;
const maxFileBytes = (file: string): number =>
  PROTOCOL_DOC_RE.test(file) ? PROTOCOL_MAX_FILE_BYTES : MAX_FILE_BYTES;
// Recursion cap for nested submodules; real-world nesting is one or two deep.
const MAX_SUBMODULE_DEPTH = envInt("FOVEA_MAX_SUBMODULE_DEPTH", 4, 1, 16);
// Generated dependency manifests are enormous and carry no first-class routes.
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "pipfile.lock", "poetry.lock", "cargo.lock", "composer.lock", "gemfile.lock", "go.sum",
]);

export const discoveryExclusionReason = (file: string): string | undefined => {
  const segments = file.split("/");
  for (const segment of segments) if (IGNORE_DIRS.has(segment)) return `ignored directory ${segment}`;
  const base = segments[segments.length - 1]!.toLowerCase();
  return LOCKFILE_NAMES.has(base) || base.endsWith(".lock") ? "dependency lockfile" : undefined;
};

const isJunk = (file: string): boolean => discoveryExclusionReason(file) !== undefined;

const supported = (f: string, routeRes?: RegExp[]): boolean => {
  const ext = f.split(".").pop()?.toLowerCase() ?? "";
  if (!isBinaryExt(f) && (ext in LANG_BY_EXT || isConfigFile(f))) return true;
  // File-convention routers use extensions with no ast-grep lang (.svelte, .mdx).
  return routeRes?.some((re) => re.test(f)) ?? false;
};

// Minified/generated bundles parse fine but blow up ast-grep pattern matching:
// `$F($$$A)` over duckdb's 800 KB single-line worker emitted 7.5 GB of match
// JSON and took ~46 s per invocation. Real source lines never run thousands
// of chars, so a huge line (or a conventional generated name) marks the file
// for fact-free skipping — same treatment as oversized, no extraction at all.
const MINIFIED_LINE_CHARS = 4_000;
const GENERATED_NAME_RE = /\.(?:min|bundle)\.(?:[cm]?js|[cm]?ts|jsx|tsx|mjs|cjs)$/i;

export const isGeneratedSource = (rel: string, text: string): boolean => {
  if (GENERATED_NAME_RE.test(rel)) return true;
  if (text.length < MINIFIED_LINE_CHARS) return false;
  for (let i = 0; i < text.length; ) {
    const nl = text.indexOf("\n", i);
    const end = nl === -1 ? text.length : nl;
    if (end - i >= MINIFIED_LINE_CHARS) return true;
    if (nl === -1) break;
    i = nl + 1;
  }
  return false;
};

const NO_BOUNDARIES: ReadonlySet<string> = new Set();

/**
 * `ls-files` never lists plain directories, so a directory entry in its
 * output is a submodule gitlink: a nested-repository boundary. Progressive
 * disclosure keeps boundaries closed until the root's FactStore enrolls them
 * (first hint or collapsed drift inside); enrolled boundaries recurse into
 * prefixed tracked + untracked paths, their own .gitignore still applying
 * via --exclude-standard. Empty or unpopulated checkouts remain reported as
 * closed boundaries. The gitlink path itself never enters the result: it names a
 * directory, not a file, and keeping it would poison the unreadable ledger
 * on refresh (this also covers dotted submodule names).
 */
interface ExpandedListing {
  files: string[];
  closedBoundaries: string[];
  unavailableFiles: string[];
}

const expandSubmodules = async (
  root: string,
  prefix: string,
  entries: string[],
  enrolled: ReadonlySet<string>,
  depth: number,
): Promise<ExpandedListing> => {
  const candidates = entries.filter((entry) => !entry.endsWith("/"));
  const kinds = await mapLimit(
    candidates,
    IO_CONCURRENCY,
    (entry) => lstat(joinPath(root, entry)).then(
      (value) => value.isDirectory() ? "directory" : value.isFile() || value.isSymbolicLink() ? "file" : "other",
      () => "unavailable",
    ),
  );
  const gitlinks = new Set(candidates.filter((_, index) => kinds[index] === "directory"));
  const files = candidates.filter((_, index) => kinds[index] === "file").map((entry) => prefix + entry);
  const unavailableFiles = candidates
    .filter((_, index) => kinds[index] === "unavailable" || kinds[index] === "other")
    .map((entry) => prefix + entry);
  const closedBoundaries: string[] = [];
  for (const link of gitlinks) {
    const key = prefix + link;
    if (depth <= 0 || !enrolled.has(key)) {
      closedBoundaries.push(key);
      continue;
    }
    const inner = await gitOut(joinPath(root, link), ["ls-files", "-z", "-co", "--exclude-standard"], { timeout: 30_000 });
    if (inner === undefined) {
      closedBoundaries.push(key);
      continue;
    }
    if (!inner.trim()) {
      closedBoundaries.push(key);
      continue;
    }
    const nested = await expandSubmodules(
      joinPath(root, link),
      `${key}/`,
      inner.split("\0").filter(Boolean),
      enrolled,
      depth - 1,
    );
    files.push(...nested.files);
    closedBoundaries.push(...nested.closedBoundaries);
    unavailableFiles.push(...nested.unavailableFiles);
  }
  return { files, closedBoundaries, unavailableFiles };
};

const excludedPolicies = (): string[] => [
  "Git ignore rules for untracked files",
  "nested repositories until enrolled",
  `directories: ${[...IGNORE_DIRS].sort().join(", ")}`,
  "dependency lockfiles",
];

const examples = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort().slice(0, 20);

export const discoverFiles = async (
  root: string,
  routeRes?: RegExp[],
  enrolled: ReadonlySet<string> = NO_BOUNDARIES,
  maxFiles = MAX_FILES,
): Promise<FileDiscovery> => {
  const limit = Math.max(1, Math.floor(maxFiles));
  const gitListing = await gitOut(root, ["ls-files", "-z", "-co", "--exclude-standard"], { timeout: 30_000 });
  if (gitListing !== undefined) {
    const entries = gitListing.split("\0").filter(Boolean);
    const expanded = await expandSubmodules(root, "", entries, enrolled, MAX_SUBMODULE_DEPTH);
    const candidates = [...new Set(expanded.files)].sort();
    const unavailable = [...new Set(expanded.unavailableFiles)].sort();
    const eligible: string[] = [];
    const unsupported: string[] = [];
    const excluded: string[] = [...expanded.closedBoundaries, ...unavailable];
    for (const file of candidates) {
      if (isJunk(file)) excluded.push(file);
      else if (supported(file, routeRes)) eligible.push(file);
      else unsupported.push(file);
    }
    const files = eligible.slice(0, limit);
    return {
      files,
      report: {
        source: "git",
        recording: unavailable.length ? "partial" : "complete",
        maxFiles: limit,
        candidateFilesSeen: candidates.length + unavailable.length,
        supportedFilesSeen: eligible.length,
        indexedFiles: files.length,
        unsupportedFilesSeen: unsupported.length,
        excludedEntriesSeen: excluded.length,
        closedBoundariesSeen: expanded.closedBoundaries.length,
        unreadableDirectoriesSeen: 0,
        unavailableFilesSeen: unavailable.length,
        capped: eligible.length > limit,
        omittedSupported: Math.max(0, eligible.length - files.length),
        unsupportedExamples: examples(unsupported),
        excludedExamples: examples(excluded),
        closedBoundaries: examples(expanded.closedBoundaries),
        unreadableDirectories: [],
        unavailableFiles: examples(unavailable),
        excludedPolicies: excludedPolicies(),
      },
    };
  }

  const files: string[] = [];
  const unsupported: string[] = [];
  const excluded: string[] = [];
  const closedBoundaries: string[] = [];
  const unreadableDirectories: string[] = [];
  let candidateFilesSeen = 0;
  let supportedFilesSeen = 0;
  let truncated = false;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unreadableDirectories.push(prefix || ".");
      return;
    }
    if (prefix && !enrolled.has(prefix) && entries.some((entry) => entry.name === ".git")) {
      closedBoundaries.push(prefix);
      excluded.push(prefix);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) excluded.push(`${rel}/`);
        else await walk(joinPath(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      candidateFilesSeen++;
      if (isJunk(rel)) {
        excluded.push(rel);
      } else if (!supported(rel, routeRes)) {
        unsupported.push(rel);
      } else {
        supportedFilesSeen++;
        if (files.length < limit) files.push(rel);
        else truncated = true;
      }
    }
  };
  await walk(root, "");
  files.sort();
  return {
    files,
    report: {
      source: "walk",
      recording: truncated ? "truncated" : unreadableDirectories.length ? "partial" : "complete",
      maxFiles: limit,
      candidateFilesSeen,
      supportedFilesSeen,
      indexedFiles: files.length,
      unsupportedFilesSeen: unsupported.length,
      excludedEntriesSeen: excluded.length,
      closedBoundariesSeen: closedBoundaries.length,
      unreadableDirectoriesSeen: unreadableDirectories.length,
      unavailableFilesSeen: 0,
      capped: truncated,
      omittedSupported: truncated ? null : 0,
      unsupportedExamples: examples(unsupported),
      excludedExamples: examples(excluded),
      closedBoundaries: examples(closedBoundaries),
      unreadableDirectories: examples(unreadableDirectories),
      unavailableFiles: [],
      excludedPolicies: excludedPolicies(),
    },
  };
};

export const listFiles = async (
  root: string,
  routeRes?: RegExp[],
  enrolled: ReadonlySet<string> = NO_BOUNDARIES,
): Promise<string[]> => (await discoverFiles(root, routeRes, enrolled)).files;

interface FileMeta { size: number; mtime: number }

const statFile = async (root: string, rel: string): Promise<FileMeta | undefined> => {
  try {
    const s = await stat(joinPath(root, rel));
    if (!s.isFile()) return undefined;
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return undefined;
  }
};

const statMany = async (root: string, files: readonly string[]): Promise<Map<string, FileMeta>> => {
  const out = new Map<string, FileMeta>();
  await mapLimit(files, IO_CONCURRENCY, async (rel) => {
    const meta = await statFile(root, rel);
    if (meta) out.set(rel, meta);
  });
  return out;
};

const metaEquals = (a: FileMeta | undefined, b: FileMeta | undefined): boolean =>
  !!a && !!b && a.size === b.size && Math.abs(a.mtime - b.mtime) < 1e-6;

const sha1Of = async (root: string, rel: string): Promise<{ sha1: string; text: string } | undefined> => {
  try {
    const buf = await readFile(joinPath(root, rel));
    return { sha1: createHash("sha1").update(buf).digest("hex"), text: buf.toString("utf8") };
  } catch {
    return undefined;
  }
};

// Hash passes touch every dirty file; holding every text until extraction
// ends means a large root pins ALL of its source in memory at once (one
// such probe OOM-killed the host). Keep a bounded prefetch window instead:
// files past the budget are lazily re-read by FileSource where extraction
// actually needs content, and spent texts drop with the pass.
const TEXT_RETAIN_TOTAL = 16 * 1024 * 1024;
const TEXT_RETAIN_FILE = 128 * 1024;
const makeTextBudget = () => {
  let used = 0;
  return (rel: string, text: string, into: Map<string, string>): void => {
    if (text.length > TEXT_RETAIN_FILE || used + text.length > TEXT_RETAIN_TOTAL) return;
    into.set(rel, text);
    used += text.length;
  };
};

/**
 * In-memory facts for one root, plus the stat manifest that makes refresh a
 * stat-only sweep for untouched files. Entries are immutable per file: a
 * refresh replaces records wholesale, which keeps sync baselines holding
 * stable references to the previous generation.
 */
export interface FactStore {
  root: string;
  facts: Map<string, FileFacts>;
  meta: Map<string, FileMeta>;
  /** Files whose latest extraction pass failed; only hash/stat markers persist. */
  tainted: Set<string>;
  /** Content hashes for honest, fact-free failure backoff. */
  failedSha: Map<string, string>;
  /** Files whose content could not be read at last pass. */
  unreadable: Set<string>;
  /** Files deliberately omitted because source size exceeded MAX_FILE_BYTES. */
  oversized: Set<string>;
  /** Files skipped as machine-generated (minified) sources. */
  generated: Set<string>;
  /** Rules pack hash the anchors were extracted with (defaults + repo + implicit). */
  rulesSha: string;
  /** Nested-repository boundaries this root has enrolled (progressive
   * disclosure): relative prefixes whose `.git` marker the listing crosses.
   * Grows on first observed work inside the project, prunes when the marker
   * vanishes, and persists across restarts via the cache header. */
  enrolled: Set<string>;
  savedAt: number;
}

const newFactStore = (root: string): FactStore => ({
  root,
  facts: new Map(),
  meta: new Map(),
  tainted: new Set(),
  failedSha: new Map(),
  unreadable: new Set(),
  oversized: new Set(),
  generated: new Set(),
  rulesSha: "",
  enrolled: new Set(),
  savedAt: 0,
});

const emptyFileFacts = (sha1: string): FileFacts => ({
  sha1,
  symbols: [],
  imports: [],
  calls: [],
  literals: [],
  anchors: [],
});

const pendingFileFacts = (file: string, sha1: string, text: string): FileFacts => {
  const facts = emptyFileFacts(sha1);
  const language = langOf(file);
  if (!language) return facts;
  const sigs = harvestFile(language, text);
  if (Object.keys(sigs).length) facts.sigs = sigs;
  return facts;
};

interface CacheHeader { fovea: number; root: string; rulesSha: string; enrolled?: string[] }
interface CacheLine {
  file: string;
  sha1: string;
  size: number;
  mtime: number;
  facts?: Omit<FileFacts, "sha1">;
  /** Marker only: no partial semantic facts cross the cache boundary. */
  failed?: true;
  /** Marker only: generated sources carry empty facts, never partial ones. */
  generated?: true;
}

export const cachePathFor = (root: string): string =>
  joinPath(tmpdir(), `pi-fovea-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);

const loadDiskStore = async (root: string): Promise<FactStore | undefined> => {
  const stream = createReadStream(cachePathFor(root), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let store: FactStore | undefined;
  let count = 0;
  try {
    for await (const line of lines) {
      if (!store) {
        let header: CacheHeader;
        try {
          header = JSON.parse(line) as CacheHeader;
        } catch {
          return undefined;
        }
        // v8 caches were one JSON document; a marker miss is a cold start.
        if (header.fovea !== CACHE_VERSION || header.root !== root) return undefined;
        store = newFactStore(root);
        store.rulesSha = header.rulesSha;
        if (Array.isArray(header.enrolled)) {
          for (const b of header.enrolled) if (typeof b === "string") store.enrolled.add(b);
        }
        continue;
      }
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as CacheLine;
        store.meta.set(rec.file, { size: rec.size, mtime: rec.mtime });
        if (rec.generated) store.generated.add(rec.file);
        if (rec.failed) {
          store.tainted.add(rec.file);
          store.failedSha.set(rec.file, rec.sha1);
        } else if (rec.facts) {
          store.facts.set(rec.file, { sha1: rec.sha1, ...rec.facts });
        }
      } catch {
        // Skip a torn line; that file re-extracts via stat/hash fallback.
      }
      if (++count % 2000 === 0) await yieldToLoop();
    }
    return store;
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
};

const persistDebounce = new Map<string, ReturnType<typeof setTimeout>>();

export const persistFacts = async (store: FactStore): Promise<void> => {
  const header = JSON.stringify({
    fovea: CACHE_VERSION,
    root: store.root,
    rulesSha: store.rulesSha,
    enrolled: [...store.enrolled].sort(),
  } satisfies CacheHeader);
  const target = cachePathFor(store.root);
  const tmpName = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(tmpName, "w");
    try {
      let batch = header + "\n";
      let count = 0;
      const files = new Set([...store.facts.keys(), ...store.failedSha.keys()]);
      for (const file of files) {
        const facts = store.facts.get(file);
        const meta = store.meta.get(file);
        if (!meta) continue;
        let line: CacheLine | undefined;
        if (store.tainted.has(file)) {
          const sha1 = store.failedSha.get(file) ?? facts?.sha1;
          if (sha1) line = { file, sha1, size: meta.size, mtime: meta.mtime, failed: true };
        } else if (facts) {
          const { sha1, ...rest } = facts;
          line = { file, sha1, size: meta.size, mtime: meta.mtime, facts: rest };
        }
        if (!line) continue;
        if (store.generated.has(file)) line.generated = true;
        batch += JSON.stringify(line) + "\n";
        if (batch.length >= 1024 * 1024) {
          await handle.write(batch);
          batch = "";
          await yieldToLoop();
        } else if (++count % 2000 === 0) {
          await yieldToLoop();
        }
      }
      if (batch) await handle.write(batch);
    } finally {
      await handle.close();
    }
    await rename(tmpName, target);
    store.savedAt = Date.now();
  } catch {
    await rm(tmpName, { force: true }).catch(() => undefined);
    // Cache is an optimization; never fail the build over it.
  }
};

/**
 * Header-only cache peek: which nested-repository boundaries this root had
 * enrolled when its facts were last persisted. Cold builds answer this before
 * the first listing so a restart restores coverage without a fresh edit.
 */
export const readEnrolledBoundaries = async (root: string): Promise<string[]> => {
  const stream = createReadStream(cachePathFor(root), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as CacheHeader;
      if (header.fovea !== CACHE_VERSION || header.root !== root) return [];
      return Array.isArray(header.enrolled) ? header.enrolled.filter((b): b is string => typeof b === "string") : [];
    }
    return [];
  } catch {
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** Drop any pending debounced persist (root eviction) without writing. */
export const clearPersistTimer = (root: string): void => {
  const timer = persistDebounce.get(root);
  if (timer) clearTimeout(timer);
  persistDebounce.delete(root);
};

/** Supported (code/config/route-convention) and non-junk filter shared by probes. */
export const filterSupported = (files: readonly string[], routeRes?: RegExp[]): string[] =>
  files.filter((f) => supported(f, routeRes) && !isJunk(f));

/** Debounced persistence: refreshes during active editing coalesce. */
const persistFactsSoon = (store: FactStore, minGapMs = 1500): void => {
  if (persistDebounce.has(store.root)) return;
  const wait = Math.max(0, store.savedAt + minGapMs - Date.now());
  const timer = setTimeout(() => {
    persistDebounce.delete(store.root);
    void persistFacts(store);
  }, wait);
  (timer as unknown as { unref?: () => void }).unref?.();
  persistDebounce.set(store.root, timer);
};

/**
 * Replace dirty records through independent, bounded batches. Each batch runs
 * symbols, one consolidated rule scan, and file routes concurrently; the global
 * spawn gate bounds work across batches. Failed fallback stages still taint their
 * files, so partial live facts never reach disk.
 */
const EXTRACTION_BATCH = AST_GREP_CHUNK;

const extractInto = async (
  root: string,
  store: FactStore,
  files: string[],
  contents: Map<string, string>,
  packRules: { pack: Awaited<ReturnType<typeof loadRepoRules>>["pack"]; fileRoutes: Awaited<ReturnType<typeof loadRepoRules>>["fileRoutes"] },
): Promise<void> => {
  if (!files.length) return;
  const source = makeFileSource(root, contents);

  const putByFile = <T extends { file: string }>(arr: T[], pick: (f: FileFacts) => T[]): void => {
    for (const v of arr) {
      const rec = store.facts.get(v.file);
      if (rec) pick(rec).push(v);
    }
  };

  const batches: string[][] = [];
  for (let start = 0; start < files.length; start += EXTRACTION_BATCH) {
    batches.push(files.slice(start, start + EXTRACTION_BATCH));
  }
  const extracted = await mapLimit(batches, SPAWN_CONCURRENCY, async (batch) => {
    const code = batch.filter((f) => !isConfigFile(f));
    const anchorPlan = anchorScanPlan(code, packRules.pack);
    const rules = [...coreScanRules(code), ...anchorPlan.rules];
    const [symbols, scanned, fileRouteAnchors, protocolAnchors] = await Promise.all([
      extractSymbols(code, root, source),
      scanRules(rules, code, root),
      extractFileRoutes(code, root, packRules.fileRoutes, source),
      extractProtocolAnchors(batch, source),
    ]);
    const symsByFile = new Map<string, SymbolRec[]>();
    for (const rel of code) symsByFile.set(rel, []);
    for (const symbol of symbols) symsByFile.get(symbol.file)?.push(symbol);
    const enclosingId = (file: string, line: number): string | undefined => {
      const syms = symsByFile.get(file) ?? [];
      let best: SymbolRec | undefined;
      for (const symbol of syms) {
        if (symbol.line <= line && (!best || symbol.line > best.line)) best = symbol;
      }
      return best ? `${best.name}@${best.file}` : `file:${file}`;
    };

    let imports: ImportSite[];
    let calls: CallSite[];
    let literals: LiteralSite[];
    let anchors: AnchorDraft[];
    if (scanned !== undefined) {
      const core = await coreFactsFromScan(batch, root, source, scanned);
      imports = core.imports;
      calls = core.calls;
      literals = core.literals;
      anchors = anchorsFromScan(scanned, anchorPlan, enclosingId);
    } else {
      [imports, calls, literals, anchors] = await Promise.all([
        extractImports(code, root),
        extractCalls(code, root),
        extractLiterals(batch, root, source),
        extractAnchors(code, root, enclosingId, packRules.pack),
      ]);
    }

    return { batch, symbols, imports, calls, literals, anchors, fileRouteAnchors, protocolAnchors };
  });

  for (const result of extracted) {
    // Replace records immutably: a baseline snapshot holding the previous
    // object must keep seeing the previous generation. The caller seeded each
    // dirty record with the content hash — carry it forward untouched.
    for (const f of result.batch) {
      const prev = store.facts.get(f);
      store.facts.set(f, {
        sha1: prev?.sha1 ?? "",
        symbols: [],
        imports: [],
        calls: [],
        literals: [],
        anchors: [],
        ...(prev?.sigs ? { sigs: prev.sigs } : {}),
      });
    }
    putByFile(result.symbols, (f) => f.symbols);
    putByFile(result.imports, (f) => f.imports);
    putByFile(result.calls, (f) => f.calls);
    putByFile(result.literals, (f) => f.literals);
    putByFile(result.anchors, (f) => f.anchors);
    putByFile(result.fileRouteAnchors, (f) => f.anchors);
    putByFile(result.protocolAnchors, (f) => f.anchors);
    await yieldToLoop();
  }
};

const runAnchorPass = async (
  root: string,
  store: FactStore,
  files: string[],
  packRules: { pack: Awaited<ReturnType<typeof loadRepoRules>>["pack"]; fileRoutes: Awaited<ReturnType<typeof loadRepoRules>>["fileRoutes"] },
  source = makeFileSource(root),
): Promise<void> => {
  const batches: string[][] = [];
  for (let start = 0; start < files.length; start += EXTRACTION_BATCH) {
    const batch = files.slice(start, start + EXTRACTION_BATCH).filter((file) => !isConfigFile(file));
    if (batch.length) batches.push(batch);
  }
  const extracted = await mapLimit(batches, SPAWN_CONCURRENCY, async (anchorFiles) => {
    const symsByFile = new Map<string, SymbolRec[]>();
    for (const rel of anchorFiles) symsByFile.set(rel, store.facts.get(rel)?.symbols ?? []);
    const enclosingId = (file: string, line: number): string | undefined => {
      const syms = symsByFile.get(file) ?? [];
      let best: SymbolRec | undefined;
      for (const symbol of syms) {
        if (symbol.line <= line && (!best || symbol.line > best.line)) best = symbol;
      }
      return best ? `${best.name}@${best.file}` : `file:${file}`;
    };
    const [anchors, fileRouteAnchors] = await Promise.all([
      extractAnchors(anchorFiles, root, enclosingId, packRules.pack),
      extractFileRoutes(anchorFiles, root, packRules.fileRoutes, source),
    ]);
    return { anchorFiles, anchors, fileRouteAnchors };
  });

  for (const result of extracted) {
    for (const file of result.anchorFiles) {
      const previous = store.facts.get(file);
      if (previous?.anchors.length) store.facts.set(file, { ...previous, anchors: [] });
    }
    for (const anchor of result.anchors) store.facts.get(anchor.file)?.anchors.push(anchor);
    for (const anchor of result.fileRouteAnchors) store.facts.get(anchor.file)?.anchors.push(anchor);
    await yieldToLoop();
  }
};

type ActiveRulePack = Awaited<ReturnType<typeof loadRepoRules>> & { previousSha: string };

/** Resolve discovered rules before AST extraction so dirty files anchor once. */
const resolveRulePack = (
  store: FactStore,
  base: Awaited<ReturnType<typeof loadRepoRules>>,
): ActiveRulePack => {
  const sigsByFile: Record<string, FileSigs | undefined> = {};
  for (const [file, facts] of store.facts) sigsByFile[file] = facts.sigs;
  const implicitRules = promote(aggregateFiles(sigsByFile), base.pack);
  const pack = implicitRules.length ? [...base.pack, ...implicitRules] : base.pack;
  const sha = implicitRules.length
    ? createHash("sha1").update(base.sha).update(JSON.stringify(implicitRules.map((rule) => rule.id).sort())).digest("hex")
    : base.sha;
  const previousSha = store.rulesSha;
  store.rulesSha = sha;
  return { pack, fileRoutes: base.fileRoutes, sha, previousSha };
};

/** Re-anchor only unchanged records left stale when the active pack moves. */
const reanchorStaleClean = async (
  root: string,
  store: FactStore,
  files: string[],
  dirty: readonly string[],
  active: ActiveRulePack,
): Promise<void> => {
  if (active.sha === active.previousSha) return;
  const dirtySet = new Set(dirty);
  const stale = files.filter((file) =>
    !dirtySet.has(file) &&
    !isConfigFile(file) &&
    !store.generated.has(file) &&
    store.facts.has(file),
  );
  if (stale.length) await runAnchorPass(root, store, stale, active);
};

/** Drain the failure ledger into this store's taint set for the given batch. */
const settleTaint = (store: FactStore, batch: ReadonlySet<string>): void => {
  const failures = drainExtractionFailures();
  const failed = new Set(failures.flatMap((f) => f.files));
  for (const f of failed) {
    if (!batch.has(f)) continue;
    store.tainted.add(f);
    const sha1 = store.facts.get(f)?.sha1;
    if (sha1) store.failedSha.set(f, sha1);
  }
};

// Additive-only contract: a fact pass can drain after dirty extraction and
// again after stale-clean re-anchoring. Clear batch taint only once before work;
// a mid-pass clear would wipe failures from the first drain.
const clearTaint = (store: FactStore, batch: Iterable<string>): void => {
  for (const f of batch) {
    store.tainted.delete(f);
    store.failedSha.delete(f);
  }
};

export interface FactsOutcome {
  store: FactStore;
  report: ExtractionReport;
  /** Files whose facts were recomputed this pass. */
  dirty: string[];
}

/**
 * Full fact pass: reuse what the disk store + stat manifest prove unchanged,
 * re-extract the rest. Cold caches pay one full read+hash per file; warm
 * boots with an intact manifest never re-read unchanged content.
 */
export const loadFacts = async (root: string, files: string[]): Promise<FactsOutcome> => {
  drainExtractionFailures();
  const disk = await loadDiskStore(root);
  const store = disk ?? newFactStore(root);
  let cacheDirty = disk === undefined;
  const fileSet = new Set(files);
  const knownFiles = new Set([...store.facts.keys(), ...store.failedSha.keys(), ...store.unreadable, ...store.oversized]);
  for (const f of knownFiles) {
    if (!fileSet.has(f)) {
      store.facts.delete(f);
      store.meta.delete(f);
      store.tainted.delete(f);
      store.failedSha.delete(f);
      store.unreadable.delete(f);
      store.oversized.delete(f);
      store.generated.delete(f);
      cacheDirty = true;
    }
  }

  const stats = await statMany(root, files);
  const needHashed: string[] = [];
  const unreadable: string[] = [];
  const oversized: string[] = [];
  for (const rel of files) {
    const meta = stats.get(rel);
    if (!meta) {
      unreadable.push(rel);
      continue;
    }
    if (meta.size > maxFileBytes(rel)) {
      oversized.push(rel);
      if (store.facts.delete(rel)) cacheDirty = true;
      store.meta.set(rel, meta);
      store.tainted.delete(rel);
      store.failedSha.delete(rel);
      store.unreadable.delete(rel);
      store.generated.delete(rel);
      continue;
    }
    store.oversized.delete(rel);
    const cachedMeta = store.meta.get(rel);
    if (store.failedSha.has(rel) && metaEquals(meta, cachedMeta)) {
      store.meta.set(rel, meta);
      continue; // unchanged known failure: report it, do not retry it
    }
    if (store.facts.has(rel) && metaEquals(meta, cachedMeta) && !store.tainted.has(rel)) {
      store.meta.set(rel, meta);
      continue; // manifest hit: no read, no hash
    }
    needHashed.push(rel);
  }

  const contents = new Map<string, string>();
  const dirty: string[] = [];
  const spend = makeTextBudget();
  await mapLimit(needHashed, IO_CONCURRENCY, async (rel) => {
    const got = await sha1Of(root, rel);
    const meta = stats.get(rel)!;
    if (!got) {
      unreadable.push(rel);
      return;
    }
    spend(rel, got.text, contents);
    if (isGeneratedSource(rel, got.text)) {
      store.generated.add(rel);
      store.tainted.delete(rel);
      store.failedSha.delete(rel);
      store.meta.set(rel, meta);
      store.facts.set(rel, emptyFileFacts(got.sha1));
      cacheDirty = true;
      return;
    }
    store.generated.delete(rel);
    const failedSha = store.failedSha.get(rel);
    if (failedSha === got.sha1) {
      store.meta.set(rel, meta);
      cacheDirty = true;
      return;
    }
    const cached = store.facts.get(rel);
    if (cached && cached.sha1 === got.sha1 && !store.tainted.has(rel)) {
      // Content identical under a moved mtime (checkout, touch): reuse.
      store.meta.set(rel, meta);
      cacheDirty = true;
      return;
    }
    dirty.push(rel);
    cacheDirty = true;
    store.meta.set(rel, meta);
    store.facts.set(rel, pendingFileFacts(rel, got.sha1, got.text));
  });

  const active = resolveRulePack(store, await loadRepoRules(root));
  clearTaint(store, dirty);
  await extractInto(root, store, dirty, contents, active);
  settleTaint(store, new Set(files));
  await reanchorStaleClean(root, store, files, dirty, active);
  // A pack move can re-anchor clean records after the dirty extraction drain.
  settleTaint(store, new Set(files));
  if (active.sha !== active.previousSha) cacheDirty = true;

  for (const f of unreadable) {
    store.unreadable.add(f);
    if (store.facts.delete(f)) cacheDirty = true;
    if (store.meta.delete(f)) cacheDirty = true;
    store.oversized.delete(f);
    store.generated.delete(f);
    store.failedSha.delete(f);
  }
  for (const f of oversized) store.oversized.add(f);
  store.unreadable.forEach((f) => { if (!unreadable.includes(f) && files.includes(f)) store.unreadable.delete(f); });
  store.oversized.forEach((f) => { if (!oversized.includes(f) && files.includes(f)) store.oversized.delete(f); });

  if (cacheDirty) await persistFacts(store);
  return {
    store,
    report: {
      failed: [...store.tainted].sort(),
      unreadable: [...new Set(unreadable)].sort(),
      oversized: [...store.oversized].sort(),
      generated: [...store.generated].sort(),
    },
    dirty: dirty.sort(),
  };
};

export interface RefreshStats {
  /** Files whose semantic facts were rebuilt (content moved). */
  reExtracted: string[];
  /** Files that vanished since the last pass. */
  deleted: string[];
  /** Files whose facts now exist and did not before. */
  added: string[];
}

/**
 * Incremental refresh against the live store. `changed` is the union of the
 * caller's drift knowledge (git probe, tool hints) — stat+hash arbitrates,
 * so an optimistic hint set is cheap and an under-inclusive one is merely
 * stale until the next full sweep.
 */
export const refreshFacts = async (
  root: string,
  store: FactStore,
  files: string[],
  changed: readonly string[],
  deletedPaths: readonly string[] = [],
): Promise<{ report: ExtractionReport; stats: RefreshStats }> => {
  drainExtractionFailures();
  const fileSet = new Set(files);
  const deleted: string[] = [];
  const removeFile = (known: string): void => {
    store.facts.delete(known);
    store.meta.delete(known);
    store.tainted.delete(known);
    store.failedSha.delete(known);
    store.unreadable.delete(known);
    store.oversized.delete(known);
    store.generated.delete(known);
    deleted.push(known);
  };
  const knownFiles = new Set([...store.facts.keys(), ...store.failedSha.keys(), ...store.unreadable, ...store.oversized]);
  for (const known of knownFiles) {
    if (!fileSet.has(known)) removeFile(known);
  }
  // Callers with a deletion oracle (git status, listing diff) pass names
  // explicitly so a vanished file is never mislabeled unreadable.
  for (const gone of deletedPaths) {
    if ((store.facts.has(gone) || store.failedSha.has(gone) || store.unreadable.has(gone) || store.oversized.has(gone)) && !deleted.includes(gone)) removeFile(gone);
  }
  const added = files.filter((f) => !knownFiles.has(f));
  const candidates = new Set<string>([...changed, ...added]);
  for (const gone of deleted) candidates.delete(gone);
  // Known failures pay one stat per refresh; only a content/stat change
  // re-enters expensive ast-grep extraction.
  for (const f of store.tainted) if (fileSet.has(f)) candidates.add(f);

  const stats = await statMany(root, [...candidates]);
  const contents = new Map<string, string>();
  const spend = makeTextBudget();
  const dirty: string[] = [];
  const unreadable: string[] = [];
  const oversized: string[] = [];
  for (const rel of candidates) {
    const meta = stats.get(rel);
    if (!meta) {
      // Still listed but unstatable: genuinely unreadable this pass.
      unreadable.push(rel);
      continue;
    }
    const cachedMeta = store.meta.get(rel);
    if (store.failedSha.has(rel) && metaEquals(meta, cachedMeta)) continue;
    store.meta.set(rel, meta);
    if (meta.size > maxFileBytes(rel)) {
      oversized.push(rel);
      store.facts.delete(rel);
      store.tainted.delete(rel);
      store.failedSha.delete(rel);
      store.unreadable.delete(rel);
      store.generated.delete(rel);
      continue;
    }
    store.oversized.delete(rel);
    const got = await sha1Of(root, rel);
    if (!got) {
      unreadable.push(rel);
      continue;
    }
    store.unreadable.delete(rel);
    spend(rel, got.text, contents);
    if (isGeneratedSource(rel, got.text)) {
      store.generated.add(rel);
      store.tainted.delete(rel);
      store.failedSha.delete(rel);
      store.facts.set(rel, emptyFileFacts(got.sha1));
      continue;
    }
    store.generated.delete(rel);
    if (store.failedSha.get(rel) === got.sha1) continue;
    const prev = store.facts.get(rel);
    if (prev && prev.sha1 === got.sha1 && !store.tainted.has(rel)) continue;
    dirty.push(rel);
    store.facts.set(rel, pendingFileFacts(rel, got.sha1, got.text));
  }

  const active = resolveRulePack(store, await loadRepoRules(root));
  clearTaint(store, dirty);
  await extractInto(root, store, dirty, contents, active);
  settleTaint(store, candidates);
  await reanchorStaleClean(root, store, files, dirty, active);
  // A pack move can re-anchor clean records after the dirty extraction drain.
  settleTaint(store, new Set(files));

  for (const f of unreadable) {
    store.unreadable.add(f);
    store.facts.delete(f);
    store.meta.delete(f);
    store.oversized.delete(f);
    store.generated.delete(f);
    store.failedSha.delete(f);
  }
  for (const f of oversized) store.oversized.add(f);

  persistFactsSoon(store);
  return {
    report: {
      failed: [...store.tainted].sort(),
      unreadable: [...store.unreadable].sort(),
      oversized: [...store.oversized].sort(),
      generated: [...store.generated].sort(),
    },
    stats: {
      reExtracted: dirty.sort(),
      deleted: deleted.sort(),
      added: added.filter((f) => !unreadable.includes(f) && !store.oversized.has(f) && !store.generated.has(f) && !store.tainted.has(f)).sort(),
    },
  };
};

export interface GraphAssembly { graph: Graph; joinIndex: JoinIndex }

export const assembleGraphWithIndex: (
  root: string,
  files: string[],
  factsMap: Map<string, FileFacts> | Record<string, FileFacts>,
) => Promise<GraphAssembly> = assembleGraph;
