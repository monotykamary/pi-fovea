import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { captureReviewRead, finishReviewRead } from "../src/core/review-read.js";
import { recordReviewRead, reviewReport, updateReviewMemory } from "../src/core/review.js";
import { getSession, resetSessions } from "../src/core/session.js";

let root: string;
beforeEach(() => { resetSessions(); root = mkdtempSync(join(tmpdir(), "pi-fovea-review-read-")); });
afterEach(() => { resetSessions(); rmSync(root, { recursive: true, force: true }); });
const setup = (text: string) => {
  writeFileSync(join(root, "file.ts"), text);
  return updateReviewMemory(getSession(root), ["seed.ts"], new Map([
    ["file.ts", { salience: 1, revision: undefined, reasons: ["test"] }],
  ]));
};

// Use the real native tool, including its actual truncation metadata and notices.
describe("revision-bound read exposure", () => {
  it("records only the returned offset/limit window", async () => {
    const memory = setup("zero\none\ntwo\nthree\nfour");
    const args = { path: "file.ts", offset: 2, limit: 2 };
    const capture = await captureReviewRead(memory, root, "file.ts", args);
    const result = await createReadTool(root).execute("read", args);
    await finishReviewRead(capture!, result);
    expect(reviewReport(memory)).toMatchObject({ seen: 1, entries: [{ exposure: { windows: [{ start: 2, end: 3 }] } }] });
  });

  it.each(["lines", "bytes"])("uses returned lines after %s truncation, not the requested limit", async (mode) => {
    const text = Array.from({ length: mode === "lines" ? 2200 : 100 }, (_, i) => `${i}:${"x".repeat(mode === "lines" ? 1 : 2000)}`).join("\n");
    const memory = setup(text);
    const capture = await captureReviewRead(memory, root, "file.ts", { limit: 3000 });
    const result = await createReadTool(root).execute("read", { path: "file.ts", limit: 3000 });
    await finishReviewRead(capture!, result);
    expect(result.details?.truncation?.truncatedBy).toBe(mode);
    expect(reviewReport(memory).entries[0]?.exposure?.windows).toEqual([
      { start: 1, end: result.details!.truncation!.outputLines },
    ]);
  });

  it("does not acknowledge diagnostic-only or rewritten results", async () => {
    const memory = setup("x".repeat(60_000));
    const capture = await captureReviewRead(memory, root, "file.ts", {});
    const result = await createReadTool(root).execute("read", { path: "file.ts" });
    await finishReviewRead(capture!, result);
    await finishReviewRead(capture!, { content: [{ type: "text", text: "summary instead of source" }] });
    await finishReviewRead(capture!, {});
    expect(reviewReport(memory).unseen).toBe(1);
  });

  it("rejects a racing read without erasing earlier exposure", async () => {
    const memory = setup("old source");
    const capture = await captureReviewRead(memory, root, "file.ts", {});
    recordReviewRead(memory, "file.ts", capture!.before.revision, { start: 1, end: 1 });
    const result = await createReadTool(root).execute("read", { path: "file.ts" });
    writeFileSync(join(root, "file.ts"), "new source");
    await finishReviewRead(capture!, result);
    expect(reviewReport(memory)).toMatchObject({ stale: 1, seen: 0 });
  });

  it("does not acknowledge a late read after epoch rotation or session reset", async () => {
    const memory = setup("source");
    const capture = await captureReviewRead(memory, root, "file.ts", {});
    const result = await createReadTool(root).execute("read", { path: "file.ts" });
    updateReviewMemory(getSession(root), ["new-seed.ts"], new Map());
    await finishReviewRead(capture!, result);
    expect(memory.entries.size).toBe(0);
    resetSessions();
    await finishReviewRead(capture!, result);
    expect(memory.entries.size).toBe(0);
  });

  it("bounds snapshot work and skips unretained files or invalid arguments", async () => {
    const memory = setup("x".repeat(1024 * 1024 + 1));
    expect(await captureReviewRead(memory, root, "file.ts", {})).toBeUndefined();
    expect(await captureReviewRead(memory, root, "other.ts", {})).toBeUndefined();
    expect(await captureReviewRead(memory, root, "file.ts", { offset: -1 })).toBeUndefined();
    expect(await captureReviewRead(memory, root, "file.ts", { limit: 0 })).toBeUndefined();
  });
});
