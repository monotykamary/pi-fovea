import { realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, basename, join, relative, resolve, sep, isAbsolute, parse } from "node:path";
import { OBSERVED_ROOT_LIMIT } from "./asyncutil.js";

const absolutePath = (cwd: string, input: string): string => {
  const raw = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
};
// Resolve aliases without collapsing linked worktrees to their common git dir.
export const canonicalPath = (cwd: string, input = "."): string => {
  const absolute = absolutePath(cwd, input);
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
};
const contains = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(path);

/** A recency-ordered circular working set. Polling never refreshes residency. */
export class ExecutionRoots {
  private observed = new Map<string, number>();
  private serial = 0;
  private retired: string[] = [];
  private retirements = 0;
  revision = 0;
  constructor(readonly capacity = OBSERVED_ROOT_LIMIT) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32) throw new Error("Workspace capacity must be 1..32");
  }
  clear(): void { this.observed.clear(); this.retired = []; this.retirements = 0; this.revision++; }
  list(_cwd?: string): string[] { return [...this.observed.keys()].sort(); }
  recent(): string[] { return [...this.observed.keys()]; }
  has(root: string): boolean { return this.observed.has(root); }
  lease(root: string): number | undefined { return this.observed.get(root); }
  target(cwd: string, root?: string): string {
    return root === undefined ? this.recent().at(-1) ?? canonicalPath(cwd) : canonicalPath(cwd, root);
  }
  check(root: string): void {
    if (!validPath(root) || !statSync(root).isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
  }
  bind(root: string): { fresh: boolean; evicted?: string } {
    this.check(root);
    const existing = this.observed.get(root);
    if (this.recent().at(-1) === root) return { fresh: false };
    this.observed.delete(root);
    let evicted: string | undefined;
    if (this.observed.size >= this.capacity) {
      evicted = this.observed.keys().next().value!;
      this.observed.delete(evicted);
      this.retired.push(evicted); this.retired = this.retired.slice(-this.capacity); this.retirements++;
    }
    this.observed.set(root, existing ?? ++this.serial); this.revision++;
    return { fresh: existing === undefined, ...(evicted === undefined ? {} : { evicted }) };
  }
  owner(cwd: string, path: string): { root: string; path: string } | undefined {
    if (!validPath(path)) return undefined;
    const absolute = canonicalPath(cwd, path);
    const root = this.list().filter(r => contains(r, absolute)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    return root ? { root, path: relative(root, absolute).split(sep).join("/") } : undefined;
  }
  snapshot(): { version: 1; roots: string[] } { return { version: 1, roots: this.recent() }; }
  restore(data: unknown): void {
    this.clear();
    if (!data || typeof data !== "object") return;
    const saved = data as { version?: unknown; roots?: unknown };
    if (saved.version !== 1 || !Array.isArray(saved.roots)) return;
    // Only bounded, previously recorded identities: no startup filesystem access.
    for (const root of saved.roots.slice(-this.capacity)) {
      if (validPath(root) && isAbsolute(root) && resolve(root) === root) this.observed.set(root, ++this.serial);
    }
  }
  details(): { capacity: number; observedRoots: string[]; retiredRoots: string[]; retirements: number; continuity: string } {
    return { capacity: this.capacity, observedRoots: this.list(), retiredRoots: [...this.retired], retirements: this.retirements,
      continuity: "Roots outside the ring are not monitored. New and re-entered roots establish a fresh baseline; inactive changes are not certified." };
  }
}

const EXCLUDED = new Set([".git", ".pi", ".agents", ".env", ".npmrc", ".netrc", ".ssh", ".aws", ".gnupg", ".config", ".cache", "node_modules", "vendor", "dist", "build", "coverage", ".venv", "venv", "target"]);
const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "mix.exs"];
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|c|cc|cpp|h|cs|swift|exs?|vue|svelte|php|sh)$/iu;
type Project = { root: string; git: boolean };
const optionalStat = async (path: string) => {
  try { return await lstat(path); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
};

/** Upward metadata lookup only. Never enumerates children or runs Git/code. */
export class ProjectDiscovery {
  private cache = new Map<string, { until: number; project: Project | undefined }>();
  private pending = new Map<string, Promise<Project | undefined>>();
  private protectedParents?: string[];
  private epoch = 0;
  readonly stats = { walks: 0, hits: 0 };
  constructor(private ttlMs = 1000, private cacheSize = 256) {}
  clear(): void { this.epoch++; this.cache.clear(); this.pending.clear(); this.protectedParents = undefined; }
  private broad(root: string): boolean {
    this.protectedParents ??= [homedir(), tmpdir(), "/tmp"].map(path => canonicalPath(path));
    return root === parse(root).root || this.protectedParents.some(path => contains(root, path));
  }
  private async walk(start: string): Promise<Project | undefined> {
    this.stats.walks++;
    const visited: string[] = [];
    for (let dir = start, depth = 0; depth < 64 && !this.broad(dir); dir = dirname(dir), depth++) {
      visited.push(dir);
      const marker = await optionalStat(join(dir, ".git"));
      if (marker?.isFile() || marker?.isDirectory()) return { root: dir, git: true };
    }
    for (const dir of visited) {
      const markers = await Promise.all(MANIFESTS.map(name => optionalStat(join(dir, name))));
      if (markers.some(info => info?.isFile())) return { root: dir, git: false };
    }
    return undefined;
  }
  async discover(cwd: string, input: string, gitOnly = false): Promise<Project | undefined> {
    if (!validPath(input)) return undefined;
    const epoch = this.epoch;
    try {
      const absolute = await realpath(absolutePath(cwd, input));
      if (absolute.split(sep).some(part => EXCLUDED.has(part) || part.startsWith(".env."))) return undefined;
      const info = await stat(absolute);
      if (!info.isFile() && !info.isDirectory()) return undefined;
      const dir = info.isDirectory() ? absolute : dirname(absolute);
      if (this.broad(dir)) return undefined;
      let project: Project | undefined;
      const cached = this.cache.get(dir);
      if (cached && cached.until > Date.now()) { this.stats.hits++; project = cached.project; }
      else {
        let task = this.pending.get(dir);
        if (!task) {
          if (this.pending.size >= this.cacheSize) return undefined;
          task = this.walk(dir); this.pending.set(dir, task);
          const held = task;
          void task.finally(() => { if (this.pending.get(dir) === held) this.pending.delete(dir); }).catch(() => {});
        }
        project = await task;
        if (epoch !== this.epoch) return undefined;
        this.cache.delete(dir); this.cache.set(dir, { until: Date.now() + this.ttlMs, project });
        while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      }
      if (gitOnly) return project?.git ? project : undefined;
      return project ?? (info.isFile() && SOURCE.test(absolute) ? { root: dir, git: false } : undefined);
    } catch { return undefined; } // Unreadable/vanished paths never broaden scope.
  }
}

/** Conservative literal shell grammar: no expansion, pipes, redirection, or scripts. */
const shellSegments = (command: string): string[][] => {
  if (command.length > 8192) return [];
  const segments: string[][] = [[]]; let word = "", quote = "", started = false;
  const flush = () => { if (started) segments.at(-1)!.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\n" || c === "\r" || c === "\0") return [];
    if (quote) {
      if (c === quote) { quote = ""; continue; }
      if (quote === '"' && /[$`\\]/u.test(c)) return [];
      word += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "#" || /[$`\\|;<>()[\]{}*?~]/u.test(c)) return [];
    if (c === "&") {
      if (command[++i] !== "&") return [];
      flush(); if (segments.length >= 8) return []; segments.push([]); continue;
    }
    if (/\s/u.test(c)) { flush(); continue; }
    word += c; started = true;
  }
  if (quote) return [];
  flush(); return segments;
};

/** Successful, known local tool arguments only; never harvest paths from output text. */
export function accessedPaths(toolName: string, input: unknown, cwd: string): string[] {
  if (!input || typeof input !== "object") return [];
  const args = input as Record<string, unknown>;
  if (["read", "edit", "write", "grep", "find", "ls"].includes(toolName)) {
    return validPath(args.path) ? [args.path] : ["grep", "find", "ls"].includes(toolName) ? ["."] : [];
  }
  if (toolName !== "bash") return [];
  const paths: string[] = [];
  let current = validPath(args.cwd) ? absolutePath(cwd, args.cwd) : cwd;
  if (validPath(args.cwd)) paths.push(current);
  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  for (const words of shellSegments(command)) {
    if (words[0] === "cd" && words.length === 2 && words[1] && !words[1].startsWith("-")) {
      current = absolutePath(current, words[1]); paths.push(current);
    } else if (words[0] === "git" && words[1] === "-C") {
      let target = current, at = 1;
      while (words[at] === "-C" && words[at + 1] && !words[at + 1]!.startsWith("-")) { target = absolutePath(target, words[at + 1]!); at += 2; }
      if (at > 1) paths.push(target);
    }
  }
  return [...new Set(paths)].slice(0, 8);
}

export const WORKSPACE_ACCESS_EVENT = "pi-workspace:access:v1";
export function peerWorkspaceRoot(data: unknown, sessionId: string | undefined, self: string): string | undefined {
  if (!sessionId || !data || typeof data !== "object") return undefined;
  const event = data as Record<string, unknown>;
  return event.version === 1 && event.sessionId === sessionId && event.source !== self && ["fovea", "contour"].includes(String(event.source))
    && validPath(event.root) && isAbsolute(event.root) ? event.root : undefined;
}
export function latestWorkspaceEntry(entries: readonly unknown[], customType: string): unknown {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry?.type === "custom" && entry.customType === customType) return entry.data;
  }
  return undefined;
}
