import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = new URL("../scripts/performance-corpus.mjs", import.meta.url);
const { withMeasurementScratch } = await import(script.href) as {
  withMeasurementScratch<T>(output: string, task: (path: string) => Promise<T>): Promise<T>;
};
const run = promisify(execFile);
let output: string;
beforeEach(async () => { output = await mkdtemp(join(tmpdir(), "performance-scratch-test-")); });
afterEach(async () => { await rm(output, { recursive: true, force: true }); });

it.each([0, 7])("cleans owned scratch after child exit %i while retaining named reports", async code => {
  await writeFile(join(output, "raw.json"), "raw");
  await writeFile(join(output, "summary.json"), "summary");
  const paths: string[] = [];
  const launch = () => withMeasurementScratch(output, async path => {
    paths.push(path);
    expect(path.startsWith(join(output, "scratch-"))).toBe(true);
    await run(process.execPath, ["-e", `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync(path.join(process.env.TMPDIR, 'facts.json'), 'scratch');
      fs.writeFileSync(path.join(process.env.TMPDIR, 'git-index'), 'scratch');
      process.exit(${code});
    `], { env: { ...process.env, TMPDIR: path, TMP: path, TEMP: path } });
    return "result";
  });
  if (code === 0) expect(await Promise.all([launch(), launch()])).toEqual(["result", "result"]);
  else await expect(launch()).rejects.toThrow();
  expect(new Set(paths).size).toBe(paths.length);
  expect((await readdir(output)).sort()).toEqual(["raw.json", "summary.json"]);
  expect(await readFile(join(output, "raw.json"), "utf8")).toBe("raw");
  expect(await readFile(join(output, "summary.json"), "utf8")).toBe("summary");
});

it("places reports under the configured temp directory, even when input loading fails", async () => {
  const failure = await run("bun", [fileURLToPath(script), output, output, output, "2"], {
    env: { ...process.env, TMPDIR: output, TMP: output, TEMP: output },
  }).then(() => undefined, error => error as { stdout: string });
  expect(failure?.stdout).toContain(`Measurements: ${join(output, "fovea-performance.")}`);
  expect((await readdir(output)).every(name => name.startsWith("fovea-performance."))).toBe(true);
});
