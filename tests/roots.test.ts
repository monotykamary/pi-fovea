import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath, ExecutionRoots } from "../src/core/roots.js";

describe("execution root ownership", () => {
  it("uses cwd-relative paths, longest enrolled ownership, and physical symlink boundaries", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "pi-fovea-owner-")));
    const a = join(parent, "a");
    const nested = join(a, "nested");
    const sibling = join(parent, "ab");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling);
    symlinkSync(nested, join(parent, "alias"), "dir");
    symlinkSync(sibling, join(a, "escape"), "dir");
    const roots = new ExecutionRoots();
    try {
      roots.bind(a);
      roots.bind(nested);
      expect(roots.target(parent, "alias")).toBe(nested);
      expect(roots.target(parent)).toBe(nested);
      expect(roots.owner(parent, "alias/new/deep.ts")).toEqual({ root: nested, path: "new/deep.ts" });
      expect(roots.owner(parent, "a/new.ts")).toEqual({ root: a, path: "new.ts" });
      expect(roots.owner(parent, "ab/file.ts")).toBeUndefined();
      expect(roots.owner(parent, "a/escape/new.ts")).toBeUndefined();
      expect(canonicalPath(parent, "alias")).toBe(nested);
      roots.clear();
      expect(roots.list(parent)).toEqual([parent]);
      expect(roots.target(parent)).toBe(parent);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
