import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor, discoverFiles } from "../src/core/build.js";
import { coverageSummary, dwell, ensureState, evictState, focus, impact, sketch } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import { explainPathCoverage } from "../src/core/state.js";

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-coverage-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  resetSessions();
  for (const root of roots.splice(0)) {
    evictState(root);
    rmSync(root, { recursive: true, force: true });
    rmSync(cachePathFor(root), { force: true });
  }
});

describe("discovery coverage ledger", () => {
  it("counts an entire Git-visible listing even when the graph file cap is smaller", async () => {
    const root = temporaryRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "node_modules/\nignored.ts\n");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "notes.txt"), "not source\n");
    writeFileSync(join(root, "ignored.ts"), "export const ignored = true;\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "hidden.ts"), "export const hidden = true;\n");

    const listing = await discoverFiles(root, undefined, new Set(), 1);
    expect(listing.files).toEqual(["a.ts"]);
    expect(listing.report).toMatchObject({
      source: "git",
      recording: "complete",
      candidateFilesSeen: 4,
      supportedFilesSeen: 2,
      indexedFiles: 1,
      unsupportedFilesSeen: 2,
      capped: true,
      omittedSupported: 1,
    });
    expect(listing.report.unsupportedExamples).toEqual([".gitignore", "notes.txt"]);
    expect(listing.report.excludedPolicies).toContain("Git ignore rules for untracked files");
  });

  it("marks a capped filesystem walk as truncated instead of inventing an omission count", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "notes.txt"), "not reached after the cap\n");

    const listing = await discoverFiles(root, undefined, new Set(), 1);
    expect(listing.files).toEqual(["a.ts"]);
    expect(listing.report).toMatchObject({
      source: "walk",
      recording: "truncated",
      candidateFilesSeen: 2,
      supportedFilesSeen: 2,
      indexedFiles: 1,
      capped: true,
      omittedSupported: null,
    });
  });

  it("records closed nested repository boundaries", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "nested", ".git"), { recursive: true });
    writeFileSync(join(root, "nested", "hidden.ts"), "export const hidden = true;\n");
    writeFileSync(join(root, "visible.ts"), "export const visible = true;\n");

    const listing = await discoverFiles(root);
    expect(listing.files).toEqual(["visible.ts"]);
    expect(listing.report.closedBoundaries).toEqual(["nested"]);
    expect(listing.report.excludedEntriesSeen).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasAstGrep())("incremental Git coverage", () => {
  it("refreshes supported and unsupported counts when the porcelain path set changes", async () => {
    const root = temporaryRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "fovea@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fovea Test"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });

    const before = await ensureState(root);
    expect(before.discovery).toMatchObject({ supportedFilesSeen: 1, unsupportedFilesSeen: 0 });

    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "notes.txt"), "unsupported\n");
    const added = await ensureState(root);
    expect(added.files).toEqual(["a.ts", "b.ts"]);
    expect(added.discovery).toMatchObject({ supportedFilesSeen: 2, unsupportedFilesSeen: 1 });

    rmSync(join(root, "b.ts"));
    rmSync(join(root, "notes.txt"));
    const removed = await ensureState(root);
    expect(removed.files).toEqual(["a.ts"]);
    expect(removed.discovery).toMatchObject({ supportedFilesSeen: 1, unsupportedFilesSeen: 0 });

    rmSync(join(root, "a.ts"));
    const unavailable = await ensureState(root);
    expect(unavailable.files).toEqual([]);
    expect(unavailable.discovery).toMatchObject({
      recording: "partial", unavailableFilesSeen: 1, unavailableFiles: ["a.ts"],
    });
    expect(await explainPathCoverage(unavailable, ["a.ts"]))
      .toMatchObject([{ path: "a.ts", status: "unavailable" }]);
  });
});

describe.skipIf(!hasAstGrep())("reported state coverage", () => {
  it("classifies explicit indexed, skipped, unsupported, excluded, and absent paths", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "a.ts"), "export function active() { return 1; }\n");
    writeFileSync(join(root, "huge.ts"), `export const huge = "${"x".repeat(1024 * 1024 + 64)}";\n`);
    writeFileSync(join(root, "vendor.min.ts"), "export const generated = 1;\n");
    writeFileSync(join(root, "notes.txt"), "plain text\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "hidden.ts"), "export const hidden = true;\n");

    const state = await ensureState(root);
    const coverage = await explainPathCoverage(state, [
      "a.ts",
      "huge.ts",
      "vendor.min.ts",
      "notes.txt",
      "node_modules/hidden.ts",
      "missing.ts",
      "../outside.ts",
    ]);
    expect(Object.fromEntries(coverage.map((entry) => [entry.requested, entry.status]))).toEqual({
      "a.ts": "indexed",
      "huge.ts": "oversized",
      "vendor.min.ts": "generated",
      "notes.txt": "unsupported",
      "node_modules/hidden.ts": "excluded",
      "missing.ts": "missing",
      "../outside.ts": "outside-root",
    });

    const map = await sketch(root, 800);
    expect(map.details).toMatchObject({ generation: state.generation, version: state.version });
    expect(coverageSummary(map.details)).toMatch(/supported files selected \(walk\/complete\)/);
    expect(map.details.coverage).toMatchObject({
      recording: "complete",
      oversizedFiles: ["huge.ts"],
      generatedFiles: ["vendor.min.ts"],
    });

    const miss = await impact(root, { files: ["notes.txt"], includeUncommitted: false });
    expect(miss.text).toContain("file type has no structural or protocol extractor");
    expect(miss.details.requestedCoverage).toMatchObject([{ path: "notes.txt", status: "unsupported" }]);
  });

  it("expires rather than applying a focus vector after a graph generation changes", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "mod.ts"), [
      "export function alpha() { return 1; }",
      "export function beta() { return alpha(); }",
      "",
    ].join("\n"));

    const before = await ensureState(root);
    const focused = await focus(root, "alpha", 800);
    expect(focused.details.generation).toBe(before.generation);

    writeFileSync(join(root, "mod.ts"), [
      "export function renamedAlpha(value: number) { return value + 1; }",
      "export function beta() { return renamedAlpha(1); }",
      "",
    ].join("\n"));
    const after = await ensureState(root, { hints: ["mod.ts"], force: true });
    expect(after.generation).not.toBe(before.generation);

    const stale = await dwell(root, 2, 800);
    expect(stale.details.staleFocus).toBe(true);
    expect(stale.text).toContain("no stale vector was applied");
    expect(stale.details.generation).toBe(after.generation);
  });
});
