import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor } from "../src/core/build.js";
import { ensureState, evictState, impact } from "../src/core/ops.js";
import { captureReviewRead, finishReviewRead } from "../src/core/review-read.js";
import { reviewReport } from "../src/core/review.js";
import { getSession, resetSessions } from "../src/core/session.js";
import { resetSyncBaselines, sync } from "../src/core/sync.js";

const fixture = new URL("./fixtures/mini", import.meta.url).pathname;

describe.skipIf(!hasAstGrep())("review exposure across mutation paths", () => {
  it.each(["plain", "git"])("stales on hintless content changes in a %s root without semantic steering", async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-fovea-review-drift-")));
    resetSessions();
    resetSyncBaselines();
    try {
      cpSync(fixture, root, { recursive: true });
      if (kind === "git") {
        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync("git", ["-c", "user.name=Review Test", "-c", "user.email=review@example.test", "commit", "-qm", "test: review fixture"], { cwd: root });
      }
      const params = { files: [], budget: 512, steerThreshold: 0.15, scope: "repository" as const };
      await sync(root, params, await ensureState(root));
      await impact(root, { files: ["server/users.go"], includeUncommitted: false });
      const memory = getSession(root).reviewMemory!;
      expect(memory.entries.has("web/api.ts")).toBe(true);
      const file = join(root, "web/api.ts");
      const original = readFileSync(file, "utf8");
      const read = async () => {
        const capture = await captureReviewRead(memory, root, "web/api.ts", { limit: 2 });
        const result = await createReadTool(root).execute("read", { path: file, limit: 2 });
        await finishReviewRead(capture!, result);
        expect(memory.entries.get("web/api.ts")?.status).toBe("seen");
      };
      await read();
      // No host mutation hooks: an editor save is noticed by the hash refresh.
      writeFileSync(file, original + "\n// editor comment\n");
      await ensureState(root, { force: true });
      expect(memory.entries.get("web/api.ts")?.status).toBe("stale");
      const comment = await sync(root, params);
      expect(comment.red).toBe(false);
      expect(comment.details.semanticChangedFiles).toEqual([]);
      await read();
      // Exercise an actual shell mutation, again without a path hint.
      execFileSync("sh", ["-c", "printf '\\n// shell comment\\n' >> \"$1\"", "_", file]);
      await ensureState(root, { force: true });
      expect(memory.entries.get("web/api.ts")?.status).toBe("stale");
      writeFileSync(file, original);
      await ensureState(root, { force: true });
      expect(memory.entries.get("web/api.ts")?.status).toBe("stale");
      await read();
      rmSync(file);
      await ensureState(root, { force: true });
      expect(memory.entries.get("web/api.ts")?.status).toBe("stale");
      const noSeeds = await impact(root, { files: [], includeUncommitted: false, budget: 256 });
      expect(noSeeds.details.review).toMatchObject({ stale: reviewReport(memory).stale });
      expect(noSeeds.tokens).toBeLessThanOrEqual(256);
    } finally {
      evictState(root);
      resetSyncBaselines();
      resetSessions();
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });
});
