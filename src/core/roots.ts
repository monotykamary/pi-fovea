import { realpathSync, statSync } from "node:fs";
import { dirname, basename, join, relative, resolve, sep, isAbsolute } from "node:path";
import { ROOT_CACHE_LIMIT } from "./asyncutil.js";

// Resolve aliases without collapsing linked worktrees to their common git dir.
export const canonicalPath = (cwd: string, input = "."): string => {
  const absolute = resolve(cwd, input);
  try { return realpathSync(absolute); } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
};

const contains = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Explicit session enrollment only; never discovers parents or siblings. */
export class ExecutionRoots {
  private observed = new Set<string>();
  private active?: string;

  clear(): void { this.observed.clear(); this.active = undefined; }
  list(cwd: string): string[] {
    return this.observed.size ? [...this.observed].sort() : [canonicalPath(cwd)];
  }
  target(cwd: string, root?: string): string {
    return root === undefined ? this.active ?? canonicalPath(cwd) : canonicalPath(cwd, root);
  }
  check(root: string): void {
    if (!statSync(root).isDirectory()) throw new Error(`Fovea root is not a directory: ${root}`);
    if (!this.observed.has(root) && this.observed.size >= ROOT_CACHE_LIMIT) {
      throw new Error(`Fovea observed-root limit (${ROOT_CACHE_LIMIT}) reached; use /fovea reset or set FOVEA_MAX_ROOTS before startup.`);
    }
  }
  bind(root: string): void {
    this.check(root);
    this.observed.add(root);
    this.active = root;
  }
  owner(cwd: string, path: string): { root: string; path: string } | undefined {
    const absolute = canonicalPath(cwd, path);
    const root = this.list(cwd).filter((r) => contains(r, absolute)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
    return root ? { root, path: relative(root, absolute).split(sep).join("/") } : undefined;
  }
}
