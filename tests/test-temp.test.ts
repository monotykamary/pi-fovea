import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

describe("test temporary-storage isolation", () => {
  it("keeps workers and inherited child tools away from real session caches", () => {
    expect(tmpdir()).toBe(process.env.TMPDIR);
    expect(process.env.TMP).toBe(tmpdir());
    expect(process.env.TEMP).toBe(tmpdir());
    expect(basename(tmpdir())).toMatch(/^pi-(fabric|fovea|contour)-vitest-/);
    expect(statSync(tmpdir()).isDirectory()).toBe(true);
  });

  it.each([0, 7])("removes private artifacts when the runner exits with %i", (exitCode) => {
    const helper = new URL("../scripts/test-temp.ts", import.meta.url).href;
    const result = spawnSync("bun", ["-e", `
      import { isolatedTestTemp } from ${JSON.stringify(helper)};
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const env = isolatedTestTemp("test-temp-probe-");
      writeFileSync(join(env.TMPDIR, "cache.json"), "temporary");
      process.stdout.write(JSON.stringify(env));
      process.exit(${exitCode});
    `], { encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exitCode);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.TMPDIR).toBe(env.TMP);
    expect(env.TEMP).toBe(env.TMP);
    expect(existsSync(env.TMPDIR!)).toBe(false);
  });
});
