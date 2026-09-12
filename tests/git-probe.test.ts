import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gitProbe } from "../src/core/git.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
const fixture = () => {
  const temp = mkdtempSync(join(tmpdir(), "fovea-git-probe-"));
  roots.push(temp);
  const root = join(temp, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "--template=");
  return root;
};
const put = (root: string, path: string, text = "value\n") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const commit = (root: string) => { git(root, "add", "-A"); git(root, "commit", "-qm", "test(git): fixture"); };
const uncached = (root: string) => {
  const source = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  const index = join(dirname(root), "reference-index");
  rmSync(index, { force: true });
  if (existsSync(source)) copyFileSync(source, index);
  const prefix = git(root, "rev-parse", "--show-prefix").trim();
  const text = execFileSync("git", ["-C", root, "-c", "core.untrackedCache=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--", "."], { encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: index } });
  return text.split("\0").filter(Boolean).map(field => ({ code: field.slice(0, 2), path: field.slice(3 + prefix.length) }));
};
const parity = async (root: string) => {
  const probe = await gitProbe(root);
  expect(probe).toBeDefined();
  expect(probe!.relist).toBe(false);
  expect(probe!.changes).toEqual(uncached(root));
  return probe!;
};
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps a warm native cache fresh for edits, new directories, ignores, renames, and removals", async () => {
  const root = fixture();
  put(root, "src/a.ts"); commit(root);
  await parity(root); await parity(root);
  const index = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  expect(readFileSync(index).includes(Buffer.from("UNTR"))).toBe(true);
  for (const mutate of [
    () => put(root, "src/a.ts", "changed\n"),
    () => put(root, "src/new directory/new\nfile.ts"),
    () => put(root, "new-root/file.ts"),
    () => put(root, ".gitignore", "new-root/\n"),
    () => rmSync(join(root, ".gitignore")),
    () => renameSync(join(root, "src/a.ts"), join(root, "src/renamed file.ts")),
    () => git(root, "add", "-A"),
    () => commit(root),
    () => rmSync(join(root, "new-root"), { recursive: true }),
  ]) { mutate(); await parity(root); }
  vi.stubEnv("FOVEA_GIT_UNTRACKED_CACHE", "0");
  await parity(root);
  expect(readFileSync(index).includes(Buffer.from("UNTR"))).toBe(false);
});

it("reports unborn, committed, and detached HEAD without a separate HEAD probe", async () => {
  const root = fixture();
  put(root, "hello.ts");
  expect((await parity(root)).head).toBe("");
  commit(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  expect((await parity(root)).head).toBe(head);
  git(root, "checkout", "-q", "--detach", head);
  expect((await parity(root)).head).toBe(head);
});

it("keeps subroots scoped and parses unmerged records", async () => {
  const root = fixture();
  put(root, "src/a.ts", "base\n"); put(root, "other/b.ts"); commit(root);
  const branch = git(root, "branch", "--show-current").trim();
  git(root, "checkout", "-qb", "side"); put(root, "src/a.ts", "side\n"); commit(root);
  git(root, "checkout", "-q", branch); put(root, "src/a.ts", "main\n"); commit(root);
  try { git(root, "merge", "--no-edit", "side"); } catch { /* expected conflict */ }
  put(root, "other/new.ts"); put(root, "src/new.ts");
  const probe = await parity(join(root, "src"));
  expect(probe.changes).toContainEqual({ code: "UU", path: "a.ts" });
  expect(probe.changes.some(change => change.path.includes("other"))).toBe(false);
});

it("refreshes a stale root prefix without scanning parent siblings", async () => {
  const parent = fixture(); put(parent, "child/a.ts"); put(parent, "outside.ts"); commit(parent);
  const child = join(parent, "child");
  git(child, "init", "-q", "--template="); commit(child);
  await gitProbe(child);
  rmSync(join(child, ".git"), { recursive: true });
  put(parent, "outside.ts", "outside drift\n"); put(child, "a.ts", "inside drift\n");
  const result = await gitProbe(child);
  expect(result!.changes).toEqual([{ code: " M", path: "a.ts" }]);
  expect(result!.relist).toBe(false);
});

it.each(["unsupported", "malformed"])("falls back safely when porcelain v2 is %s", async mode => {
  const root = fixture(); put(root, "a.ts"); commit(root); put(root, "new.ts");
  const actualGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dirname(root), "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--porcelain=v2" ]; then\n    ${mode === "unsupported" ? "exit 129" : "printf 'unexpected protocol'; exit 0"}\n  fi\ndone\nexec "$REAL_GIT_BIN" "$@"\n`, { mode: 0o755 });
  vi.stubEnv("REAL_GIT_BIN", actualGit);
  vi.stubEnv("PATH", bin + delimiter + process.env.PATH);
  expect((await parity(root)).changes).toContainEqual({ code: "??", path: "new.ts" });
});
