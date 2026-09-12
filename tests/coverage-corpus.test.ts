import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-corpus-retry-"));
  roots.push(root);
  const work = join(root, "work"), checkout = join(work, "repos", "example--project");
  mkdirSync(checkout, { recursive: true });
  copyFileSync(resolve("scripts/coverage-corpus.mjs"), join(root, "coverage-corpus.mjs"));
  return { root, work, checkout };
};
const acquire = (root: string, work: string, sha: string) => {
  writeFileSync(join(root, "coverage-manifest.json"), JSON.stringify({ selection: "offline retry fixture", repos: [{ repo: "example/project", sha }] }));
  let status = 0;
  try { execFileSync(process.execPath, [join(root, "coverage-corpus.mjs"), "acquire", work], { stdio: "pipe", timeout: 30000 }); }
  catch (error) { status = (error as { status: number }).status; }
  // The real harness requires 31+ repos; this offline fixture deliberately has one.
  expect(status).toBe(1);
  return JSON.parse(readFileSync(join(work, "pins.json"), "utf8"));
};

it("leaves an occupied non-checkout untouched rather than cloning over or deleting it", () => {
  const { root, work, checkout } = fixture();
  const marker = join(checkout, "keep.txt");
  writeFileSync(marker, "keep me");
  const result = acquire(root, work, "0".repeat(40));
  expect(result.successes).toHaveLength(0);
  expect(result.failures).toHaveLength(1);
  expect(readFileSync(marker, "utf8")).toBe("keep me");
});

it("reuses a clean matching pin and preserves a dirty retry without network access", () => {
  const { root, work, checkout } = fixture();
  execFileSync("git", ["init", "-q", "--template=", checkout]);
  execFileSync("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "test(corpus): create retry fixture"]);
  const sha = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const clean = acquire(root, work, sha);
  expect(clean.successes).toHaveLength(1);
  expect(clean.successes[0]).toMatchObject({ sha, reused: true });
  const marker = join(checkout, "keep.txt");
  writeFileSync(marker, "uncommitted work");
  const dirty = acquire(root, work, sha);
  expect(dirty.failures[0].error).toContain("dirty; left untouched");
  expect(readFileSync(marker, "utf8")).toBe("uncommitted work");
  expect(existsSync(join(checkout, ".git"))).toBe(true);
});
