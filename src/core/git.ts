// Async git plumbing for drift probes and history mining. Every call goes
// through execFile behind the shared spawn gate: pi's event loop is the UI,
// so even a 50ms spawnSync per turn is a hang tax we no longer pay.

import { execFile } from "node:child_process";
import { posix } from "node:path";
import { ROOT_CACHE_LIMIT, spawnGate } from "./asyncutil.js";

const GIT_TIMEOUT = 15_000;

/** Run git, returning stdout or undefined on any failure (not a repo, timeout). */
export const gitOut = async (
  root: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string | undefined> =>
  spawnGate.run(
    () =>
      new Promise<string | undefined>((resolve) => {
        execFile(
          "git",
          ["-C", root, ...args],
          {
            encoding: "utf8",
            timeout: opts.timeout ?? GIT_TIMEOUT,
            maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
          },
          (error, stdout) => {
            if (error) {
              resolve(undefined);
              return;
            }
            resolve(stdout);
          },
        );
      }),
  );

export const gitHead = async (root: string): Promise<string | undefined> => {
  const out = await gitOut(root, ["rev-parse", "HEAD"]);
  const head = out?.trim();
  return head ? head : undefined;
};

/**
 * Subject of the most recent HEAD reflog entry, e.g. "checkout: moving from
 * main to feature". Tells branch switches (re-baseline quietly) apart from
 * commits/pulls/rebases (foreign drift worth reporting). Undefined when the
 * reflog is unavailable or disabled — callers fall back to the loud path.
 */
export const gitReflogAction = async (root: string): Promise<string | undefined> => {
  const out = await gitOut(root, ["reflog", "-1", "--format=%gs"]);
  const line = out?.trim();
  return line ? line : undefined;
};

interface WorktreeChange {
  /** X+Y status columns, e.g. " M", "??", "D ". */
  code: string;
  /** Path as reported by git, relative to root. */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
}

/**
 * Cheap drift probe: HEAD + `status --porcelain -z`.
 * Returns undefined when root is not (inside) a git work tree.
 * Any parse surprise yields `relist: true` so callers can fall back to a
 * full rescan instead of trusting partial change sets.
 */
export interface GitProbe {
  head: string;
  changes: WorktreeChange[];
  relist: boolean;
}

const gitPrefixes = new Map<string, string>();
export const gitPrefix = async (root: string): Promise<string | undefined> => {
  if (gitPrefixes.has(root)) {
    const hit = gitPrefixes.get(root)!;
    gitPrefixes.delete(root);
    gitPrefixes.set(root, hit);
    return hit;
  }
  const out = await gitOut(root, ["rev-parse", "--show-prefix"]);
  if (out === undefined) return undefined;
  const prefix = out.trim().replace(/\\/g, "/");
  gitPrefixes.delete(root);
  gitPrefixes.set(root, prefix);
  while (gitPrefixes.size > ROOT_CACHE_LIMIT) gitPrefixes.delete(gitPrefixes.keys().next().value!);
  return prefix;
};

const gitRelativePath = (path: string, prefix: string): string | undefined => {
  const normalized = path.replace(/\\/g, "/");
  if (!prefix) return normalized;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
};

export const gitProbe = async (root: string): Promise<GitProbe | undefined> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return undefined;
  const out = await gitOut(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--", ".",
  ]);
  if (out === undefined) return undefined;
  const head = (await gitHead(root)) ?? "";
  const fields = out.split("\0").filter((f) => f.length > 0);
  const changes: WorktreeChange[] = [];
  let relist = false;
  for (const field of fields) {
    if (field.length < 4) {
      relist = true;
      continue;
    }
    const code = field.slice(0, 2);
    const path = gitRelativePath(field.slice(3), prefix);
    if (!path) {
      relist = true;
      continue;
    }
    // --no-renames keeps the format to a single path per record; anything
    // else unexpected marks the probe unreliable rather than lossy.
    if (!/^[ MARCUD?!]{2}$/.test(code)) relist = true;
    changes.push({ code, path });
  }
  return { head, changes, relist };
};

/** Files differing from the index/HEAD or untracked, for impact seeding. */
export const uncommittedFiles = async (root: string): Promise<string[]> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return [];
  const out = await gitOut(root, ["status", "--porcelain", "-z", "--no-renames", "--", "."]);
  if (!out) return [];
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => gitRelativePath(entry.slice(3), prefix))
    .filter((path): path is string => !!path);
};

export const prFiles = async (root: string, base: string): Promise<string[]> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return [];
  const out = await gitOut(root, ["diff", "--name-only", `${base}...HEAD`, "--", "."]);
  return out
    ? out.split("\n").map((s) => gitRelativePath(s.trim(), prefix)).filter((s): s is string => !!s)
    : [];
};

interface DiffHunk {
  /** First line on the post-change side (1-indexed; 0 is valid for an empty range). */
  newStart: number;
  /** Number of post-change lines in this zero-context hunk. */
  newLines: number;
}

export interface FileDiffHunks {
  hunks: DiffHunk[];
  /** The file must use coarse file-node seeding instead of line nuclei. */
  fallback: boolean;
}

/** Per-file guard against adversarial/generated patches becoming seed work. */
export const MAX_DIFF_HUNKS_PER_FILE = 200;
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;

interface PendingDiff {
  oldPath?: string;
  newPath?: string;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  hunks: DiffHunk[];
  hunkCount: number;
  fallback: boolean;
  newFile: boolean;
  deletedFile: boolean;
}

// Git's quoted paths are C strings, including octal UTF-8 bytes. Decode only
// that deliberately small grammar; a surprise makes the section coarse rather
// than risking attribution to the wrong source path.
const decodeGitPath = (raw: string): string | undefined => {
  if (!raw.startsWith("\"")) return raw;
  if (raw.length < 2 || !raw.endsWith("\"")) return undefined;
  const bytes: number[] = [];
  const escaped: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    e: 27,
    "\\": 92,
    "\"": 34,
  };
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      const cp = raw.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(cp)));
      if (cp > 0xffff) i++;
      continue;
    }
    const next = raw[++i];
    if (next === undefined || i >= raw.length - 1) return undefined;
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && i + 1 < raw.length - 1 && /[0-7]/.test(raw[i + 1]!)) {
        octal += raw[++i]!;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const value = escaped[next];
    if (value === undefined) return undefined;
    bytes.push(value);
  }
  return Buffer.from(bytes).toString("utf8");
};

const boundedHunkLimit = (requested: number): number =>
  Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : MAX_DIFF_HUNKS_PER_FILE;

/**
 * Parse a `git diff --unified=0` patch into post-change line ranges. Parsing is
 * fail-coarse per file: new/deleted/renamed/binary/malformed sections and files
 * above the hunk cap are retained as fallback records, never partial nuclei.
 */
export const parseZeroContextDiff = (
  patch: string,
  prefix = "",
  maxHunksPerFile = MAX_DIFF_HUNKS_PER_FILE,
): Map<string, FileDiffHunks> => {
  const limit = boundedHunkLimit(maxHunksPerFile);
  const result = new Map<string, FileDiffHunks>();
  let pending: PendingDiff | undefined;

  const relativePath = (raw: string, side?: "a" | "b"): string | undefined => {
    const decoded = decodeGitPath(raw);
    if (decoded === undefined || decoded === "/dev/null") return undefined;
    const repoPath = side && decoded.startsWith(`${side}/`) ? decoded.slice(2) : decoded;
    const relative = gitRelativePath(repoPath, prefix);
    return relative ? posix.normalize(relative) : undefined;
  };

  const merge = (path: string, hunks: DiffHunk[], fallback: boolean): void => {
    const previous = result.get(path);
    if (!previous) {
      result.set(path, fallback ? { hunks: [], fallback: true } : { hunks: [...hunks], fallback: false });
      return;
    }
    if (previous.fallback || fallback || previous.hunks.length + hunks.length > limit) {
      result.set(path, { hunks: [], fallback: true });
      return;
    }
    previous.hunks.push(...hunks);
  };

  const flush = (): void => {
    if (!pending) return;
    const renamed = !!(
      pending.renameFrom || pending.renameTo || pending.copyFrom || pending.copyTo ||
      (pending.oldPath && pending.newPath && pending.oldPath !== pending.newPath)
    );
    const fallback = pending.fallback || pending.newFile || pending.deletedFile || renamed ||
      pending.hunkCount === 0 || pending.hunkCount > limit;
    const primary = pending.newPath ?? pending.renameTo ?? pending.copyTo ?? pending.oldPath ??
      pending.renameFrom ?? pending.copyFrom;
    if (primary) merge(primary, pending.hunks, fallback);
    // Status --no-renames can report either side, and stale callers can still
    // hold the old graph generation. Keep both names coarse for safety.
    if (renamed) {
      for (const path of [pending.oldPath, pending.renameFrom, pending.copyFrom]) {
        if (path && path !== primary) merge(path, [], true);
      }
    }
    pending = undefined;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      pending = {
        hunks: [],
        hunkCount: 0,
        fallback: false,
        newFile: false,
        deletedFile: false,
      };
      continue;
    }
    if (!pending) continue;

    // Patch body lines can themselves begin with "---" or "+++". Those are
    // headers only before the first hunk.
    if (pending.hunkCount === 0) {
      if (line.startsWith("new file mode ")) {
        pending.newFile = true;
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        pending.deletedFile = true;
        continue;
      }
      if (line.startsWith("rename from ")) {
        pending.renameFrom = relativePath(line.slice("rename from ".length));
        pending.fallback ||= pending.renameFrom === undefined;
        continue;
      }
      if (line.startsWith("rename to ")) {
        pending.renameTo = relativePath(line.slice("rename to ".length));
        pending.fallback ||= pending.renameTo === undefined;
        continue;
      }
      if (line.startsWith("copy from ")) {
        pending.copyFrom = relativePath(line.slice("copy from ".length));
        pending.fallback ||= pending.copyFrom === undefined;
        continue;
      }
      if (line.startsWith("copy to ")) {
        pending.copyTo = relativePath(line.slice("copy to ".length));
        pending.fallback ||= pending.copyTo === undefined;
        continue;
      }
      if (line.startsWith("--- ")) {
        const raw = line.slice(4);
        pending.newFile ||= raw === "/dev/null";
        pending.oldPath = relativePath(raw, "a");
        pending.fallback ||= raw !== "/dev/null" && pending.oldPath === undefined;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const raw = line.slice(4);
        pending.deletedFile ||= raw === "/dev/null";
        pending.newPath = relativePath(raw, "b");
        pending.fallback ||= raw !== "/dev/null" && pending.newPath === undefined;
        continue;
      }
      if (line.startsWith("Binary files ")) {
        const match = /^Binary files (.+) and (.+) differ$/.exec(line);
        if (match) {
          pending.oldPath ??= relativePath(match[1]!, "a");
          pending.newPath ??= relativePath(match[2]!, "b");
        }
        pending.fallback = true;
        continue;
      }
      if (line === "GIT binary patch") {
        pending.fallback = true;
        continue;
      }
    }

    if (!line.startsWith("@@")) continue;
    pending.hunkCount++;
    if (pending.hunkCount > limit) {
      pending.hunks.length = 0;
      pending.fallback = true;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (!match) {
      pending.hunks.length = 0;
      pending.fallback = true;
      continue;
    }
    const oldStart = Number(match[1]);
    const oldLines = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newLines = match[4] === undefined ? 1 : Number(match[4]);
    const valid = [oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger) &&
      oldStart >= 0 && oldLines >= 0 && newStart >= 0 && newLines >= 0 &&
      (newLines === 0 || newStart >= 1) && Number.isSafeInteger(newStart + newLines);
    if (!valid) {
      pending.hunks.length = 0;
      pending.fallback = true;
      continue;
    }
    if (!pending.fallback) pending.hunks.push({ newStart, newLines });
  }
  flush();
  return result;
};

/** Read the bounded patch used to refine impact's changed-file seeds. */
export const diffHunks = async (
  root: string,
  base?: string,
): Promise<Map<string, FileDiffHunks> | undefined> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return undefined;
  const range = base ? `${base}...HEAD` : "HEAD";
  const out = await gitOut(root, [
    "-c", "core.quotePath=false",
    "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames",
    range, "--", ".",
  ], { maxBuffer: DIFF_MAX_BUFFER });
  return out === undefined ? undefined : parseZeroContextDiff(out, prefix);
};
