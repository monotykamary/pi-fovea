import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributeChanges,
  captureMutation,
  finishMutation,
  provenancePathFor,
  recordMutationTransition,
  recordMutationTransitions,
} from "../src/core/provenance.js";

const hash = (text: string): string => createHash("sha1").update(text).digest("hex");
const roots: string[] = [];
const journals: string[] = [];

const rootWithFile = (content = "one\n"): { root: string; file: string } => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-provenance-test-"));
  const file = join(root, "file.ts");
  writeFileSync(file, content);
  roots.push(root);
  return { root, file };
};

const mutate = async (root: string, file: string, sessionId: string, next: string, toolCallId: string): Promise<void> => {
  const capture = await captureMutation(root, file);
  expect(capture).toBeDefined();
  writeFileSync(file, next);
  expect(await finishMutation(capture!, sessionId, toolCallId)).toBe(true);
  journals.push(provenancePathFor(root, sessionId));
};

afterEach(() => {
  for (const path of new Set(journals.splice(0))) {
    try { unlinkSync(path); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sync provenance", () => {
  it("attributes an exact content transition to the current or another session", async () => {
    const { root, file } = rootWithFile();
    await mutate(root, file, "session-a", "two\n", "tool-a");

    const change = [{ file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") }];
    await expect(attributeChanges(root, "session-a", 0, change)).resolves.toEqual({
      kind: "current-session",
      files: { "file.ts": "current-session" },
    });
    await expect(attributeChanges(root, "session-b", 0, change)).resolves.toEqual({
      kind: "other-session",
      files: { "file.ts": "other-session" },
    });
  });

  it("attributes an explicit trusted hash transition", async () => {
    const { root, file } = rootWithFile();
    await expect(recordMutationTransition(
      root, file, hash("one\n"), hash("two\n"), "session-a", "receipt-a",
    )).resolves.toBe(true);
    journals.push(provenancePathFor(root, "session-a"));
    await expect(attributeChanges(root, "session-a", 0, [{
      file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n"),
    }])).resolves.toEqual({ kind: "current-session", files: { "file.ts": "current-session" } });
  });

  it("persists and attributes a multi-file receipt batch", async () => {
    const { root } = rootWithFile();
    writeFileSync(join(root, "other.ts"), "alpha\n");
    await expect(recordMutationTransitions(root, [
      { path: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") },
      { path: "other.ts", beforeSha: hash("alpha\n"), afterSha: hash("beta\n") },
    ], "session-a", "receipt-batch")).resolves.toBe(2);
    journals.push(provenancePathFor(root, "session-a"));
    await expect(attributeChanges(root, "session-a", 0, [
      { file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") },
      { file: "other.ts", beforeSha: hash("alpha\n"), afterSha: hash("beta\n") },
    ])).resolves.toEqual({
      kind: "current-session",
      files: { "file.ts": "current-session", "other.ts": "current-session" },
    });
  });

  it("uses receipt commit order when timestamps cannot order one session's transitions", async () => {
    const { root } = rootWithFile();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      await recordMutationTransitions(root, [{
        path: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n"), commitOrder: 4,
      }], "session-a", "z-call");
      await recordMutationTransitions(root, [{
        path: "file.ts", beforeSha: hash("two\n"), afterSha: hash("three\n"), commitOrder: 5,
      }], "session-a", "a-call");
      journals.push(provenancePathFor(root, "session-a"));
      await expect(attributeChanges(root, "session-a", 0, [{
        file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("three\n"),
      }])).resolves.toEqual({ kind: "current-session", files: { "file.ts": "current-session" } });
    } finally {
      now.mockRestore();
    }
  });

  it("reports a transition chain owned by multiple sessions as mixed", async () => {
    const { root, file } = rootWithFile();
    // This case needs chronological cross-session receipts, not a same-ms tie.
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    try {
      await mutate(root, file, "session-a", "two\n", "tool-a");
      await mutate(root, file, "session-b", "three\n", "tool-b");

      const result = await attributeChanges(root, "session-a", 0, [{
        file: "file.ts",
        beforeSha: hash("one\n"),
        afterSha: hash(readFileSync(file, "utf8")),
      }]);
      expect(result).toEqual({ kind: "mixed", files: { "file.ts": "mixed" } });
    } finally {
      now.mockRestore();
    }
  });

  it("leaves uninstrumented writes unattributed", async () => {
    const { root, file } = rootWithFile();
    writeFileSync(file, "external\n");
    await expect(attributeChanges(root, "session-a", 0, [{
      file: "file.ts",
      beforeSha: hash("one\n"),
      afterSha: hash("external\n"),
    }])).resolves.toEqual({
      kind: "unattributed",
      files: { "file.ts": "unattributed" },
    });
  });
});
