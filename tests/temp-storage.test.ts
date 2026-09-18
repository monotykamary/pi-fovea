import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cachePathFor, loadFacts, persistFacts, readEnrolledBoundaries } from "../src/core/build.js";
import { coChangeHistory } from "../src/core/cochange.js";
import { attributeChanges, provenancePathFor, recordMutationTransition } from "../src/core/provenance.js";
import { revealGroups } from "../src/core/render.js";
import { hasAstGrep, scanRules } from "../src/core/astgrep.js";
import { projectFoveaConfigPath, saveFoveaConfig } from "../src/core/config.js";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_FILE_MAX_BYTES, JOURNAL_TTL_MS, maintainTempStorage, pruneTempStorage, readTempText,
  withScanRuleFile, writeAtomicTemp, writeSpill,
} from "../src/core/temp-storage.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const HOUR = 3600_000;
const cache = (n: number) => `pi-fovea-${n.toString(16).padStart(16, "0")}.json`;
const spill = (n: number) => `pi-fovea-focus-${n.toString(16).padStart(8, "0")}.txt`;
let directory: string;
let now: number;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "fovea-retention-test-"));
  vi.stubEnv("TMPDIR", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TEMP", directory);
  now = Date.now();
});
afterEach(async () => {
  // Wait for the activity-triggered sweep before removing our private fixture.
  await maintainTempStorage();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
const put = async (name: string, age = 2 * HOUR, text = "x"): Promise<string> => {
  const path = join(directory, name);
  await fs.writeFile(path, text);
  await fs.utimes(path, new Date(now - age), new Date(now - age));
  return path;
};
const exists = async (path: string) => fs.lstat(path).then(() => true, () => false);

describe("activity-driven temporary retention", () => {
  it("previews explicit maintenance without mutation, then rechecks on apply", async () => {
    const old = await put(cache(0), 8 * 24 * HOUR);
    const fresh = await put(cache(1), 0);
    const before = await fs.stat(old);
    expect(await pruneTempStorage({ directory, now })).toEqual([old]);
    expect((await fs.stat(old)).mtimeMs).toBe(before.mtimeMs);
    await fs.writeFile(old, "refreshed");
    expect(await pruneTempStorage({ directory, now, dryRun: false })).toEqual([]);
    await fs.utimes(old, new Date(now - 8 * 24 * HOUR), new Date(now - 8 * 24 * HOUR));
    expect(await pruneTempStorage({ directory, now, dryRun: false })).toEqual([old]);
    expect(await exists(fresh)).toBe(true);
  });
  it("enforces combined facts/cochange entry pressure oldest-first, protecting fresh entries", async () => {
    for (let i = 0; i < 130; i++) await put(cache(i), 2 * HOUR + (130 - i) * 1000);
    const cochange = await put("pi-fovea-cochange-ffffffffffffffff.json", 0);
    await maintainTempStorage(directory, now);
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(128);
    expect(names).not.toContain(cache(0));
    expect(names).not.toContain(cache(2));
    expect(names).toContain(cache(3));
    expect(await exists(cochange)).toBe(true);
  });

  it("enforces byte pressure and age independently, with a grace window", async () => {
    for (let i = 0; i < 3; i++) {
      const path = await put(cache(i), (4 - i) * HOUR);
      await fs.truncate(path, 50 * 1024 * 1024); // sparse pressure fixture
      await fs.utimes(path, new Date(now - (4 - i) * HOUR), new Date(now - (4 - i) * HOUR));
    }
    const expired = await put(cache(9), 8 * 24 * HOUR);
    const fresh = await put(spill(0), 30 * 60_000);
    await fs.truncate(fresh, 40 * 1024 * 1024);
    const oldSpill = await put(spill(1), 2 * HOUR);
    await maintainTempStorage(directory, now);
    expect(await exists(join(directory, cache(0)))).toBe(false);
    expect(await exists(join(directory, cache(1)))).toBe(true);
    expect(await exists(expired)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(oldSpill)).toBe(false);
  });

  it("expires spills after one day and bounds their count", async () => {
    const expired = await put(spill(999), 25 * HOUR);
    for (let i = 0; i < 130; i++) await put(spill(i));
    await maintainTempStorage(directory, now);
    expect(await exists(expired)).toBe(false);
    expect(await fs.readdir(directory)).toHaveLength(128);
  });

  it("never pressure-evicts fresh journals, including fresh records with an old mtime", async () => {
    const journal = (n: number) => `pi-fovea-provenance-${n.toString(16).padStart(16, "0")}-0123456789abcdef.json`;
    const old = await put(journal(0), JOURNAL_TTL_MS + HOUR, JSON.stringify({ version: 1, records: [{ at: now - JOURNAL_TTL_MS - 1 }] }));
    const live = await put(journal(1), JOURNAL_TTL_MS + HOUR, JSON.stringify({ version: 1, records: [{ at: now }] }));
    const malformed = await put(journal(2), JOURNAL_TTL_MS + HOUR, "broken");
    for (let i = 3; i < 135; i++) await put(journal(i), 0, JSON.stringify({ version: 1, records: [{ at: now }] }));
    await maintainTempStorage(directory, now);
    expect(await exists(old)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect(await exists(malformed)).toBe(true);
    expect(await fs.readdir(directory)).toHaveLength(134);
  });

  it("leaves unknown names, directories, symlinks, hardlinks and other owners alone", async () => {
    const unknown = await put("pi-fovea-not-a-cache.json", 9 * 24 * HOUR);
    const otherRepo = await put("pi-fabric-0123456789abcdef.json", 9 * 24 * HOUR);
    const dir = join(directory, cache(1));
    await fs.mkdir(dir);
    await fs.writeFile(join(dir, "keep"), "keep");
    const symlink = join(directory, cache(2));
    await fs.symlink(unknown, symlink);
    const hardlink = join(directory, cache(3));
    await fs.link(unknown, hardlink);
    const ownedElsewhere = await put(cache(4), 9 * 24 * HOUR);
    const uid = process.getuid!();
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
    await maintainTempStorage(directory, now);
    expect(await exists(ownedElsewhere)).toBe(true);
    vi.restoreAllMocks();
    await maintainTempStorage(directory, now + 6 * 60_000);
    for (const path of [unknown, otherRepo, dir, symlink, hardlink]) expect(await exists(path)).toBe(true);
    expect(await exists(ownedElsewhere)).toBe(false);
    await expect(readTempText(symlink)).rejects.toThrow();
    await expect(writeAtomicTemp(symlink, "bad")).rejects.toThrow();
    expect(() => writeSpill(symlink, "bad")).toThrow();
    expect(await fs.readFile(unknown, "utf8")).toBe("x");
  });

  it("rechecks identity before unlink, preserving a concurrently replaced file", async () => {
    const target = await put(cache(0), 9 * 24 * HOUR);
    const replacement = await put("replacement", 0, "new");
    const original = fs.lstat;
    let calls = 0;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === target && ++calls === 2) await fs.rename(replacement, target);
      return original(...args);
    }) as typeof fs.lstat);
    await maintainTempStorage(directory, now);
    expect(calls).toBe(2);
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });

  it("recovers only old dead-owner partials/scans; protects live, recent and legacy directories", async () => {
    const deadPid = 2147483647;
    const probe = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === deadPid) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });
    const deadPartial = await put(`${cache(0)}.tmp-${deadPid}-${randomUUID()}`);
    const deadScan = await put(`pi-fovea-scan-${deadPid}-${randomUUID()}.yml`);
    const livePartial = await put(`${cache(1)}.tmp-${process.pid}-${randomUUID()}`, 9 * 24 * HOUR);
    const liveScan = await put(`pi-fovea-scan-${process.pid}-${randomUUID()}.yml`, 9 * 24 * HOUR);
    const recent = await put(`${cache(2)}.tmp-${deadPid}-${randomUUID()}`, 1000);
    const unknown = await put(`unrelated.tmp-${deadPid}-${randomUUID()}`);
    const legacy = join(directory, "pi-fovea-scan-Ab12cd");
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, "rules.yml"), "keep");
    await maintainTempStorage(directory, now);
    expect(await exists(deadPartial)).toBe(false);
    expect(await exists(deadScan)).toBe(false);
    for (const path of [livePartial, liveScan, recent, unknown, legacy]) expect(await exists(path)).toBe(true);
    expect(probe).toHaveBeenCalled();
  });

  it("coalesces concurrent sweeps, throttles further activity, and tolerates scan failure", async () => {
    const spy = vi.spyOn(fs, "opendir");
    const first = maintainTempStorage(directory, now);
    expect(maintainTempStorage(directory, now)).toBe(first);
    await first;
    const late = await put(cache(0), 9 * 24 * HOUR);
    await maintainTempStorage(directory, now + 1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await exists(late)).toBe(true);
    await maintainTempStorage(directory, now + 6 * 60_000);
    expect(await exists(late)).toBe(false);
    spy.mockRejectedValueOnce(new Error("EACCES"));
    await expect(maintainTempStorage(directory, now + 12 * 60_000)).resolves.toBeUndefined();
  });
});

describe("runtime storage integration", () => {
  it("facts activity sweeps stale caches, round-trips enrollment, and skips oversized persistence without changing live facts", async () => {
    const expired = await put(cache(999), 9 * 24 * HOUR);
    const root = join(directory, "repo");
    await fs.mkdir(root);
    const { store } = await loadFacts(root, []);
    await maintainTempStorage();
    expect(await exists(expired)).toBe(false);
    store.enrolled.add("nested");
    await persistFacts(store);
    expect(await readEnrolledBoundaries(root)).toEqual(["nested"]);
    const previous = await fs.readFile(cachePathFor(root), "utf8");
    const savedAt = store.savedAt;
    const largeSpec = "x".repeat(1024 * 1024);
    for (let i = 0; i < 65; i++) {
      const file = `file${i}.ts`;
      store.meta.set(file, { size: 1, mtime: 0 });
      store.facts.set(file, { sha1: "hash", symbols: [], imports: [{ file, spec: largeSpec, line: 1 }], calls: [], literals: [], anchors: [] });
    }
    await persistFacts(store);
    expect(store.facts.size).toBe(65);
    expect(store.savedAt).toBe(savedAt);
    expect(await fs.readFile(cachePathFor(root), "utf8")).toBe(previous);
    expect((await fs.readdir(directory)).some(name => name.includes(".tmp-"))).toBe(false);
    // An oversized legacy cache is a miss, not partial extraction or a build failure.
    await fs.truncate(cachePathFor(root), CACHE_FILE_MAX_BYTES + 1);
    expect(await readEnrolledBoundaries(root)).toEqual([]);
    const cold = await loadFacts(root, []);
    expect(cold.store.facts.size).toBe(0);
    expect((await fs.stat(cachePathFor(root))).size).toBeLessThan(CACHE_FILE_MAX_BYTES);
  });

  it("cochange persists atomically and cleans failed writes without changing history", async () => {
    const root = join(directory, "repo");
    await fs.mkdir(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(join(root, "a.ts"), `export const a = ${i};`);
      await fs.writeFile(join(root, "b.ts"), `export const b = ${i};`);
      git("add", ".");
      const message = join(root, ".git", "test-message");
      await fs.writeFile(message, `step ${i}\n`);
      git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-F", message);
    }
    const path = join(directory, `pi-fovea-cochange-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
    const renames = vi.spyOn(fs, "rename");
    const expected = await coChangeHistory(root, ["a.ts", "b.ts"]);
    expect(expected.get("a.ts")?.length).toBeGreaterThan(0);
    expect(renames.mock.calls.some(([source, target]) => String(source).startsWith(`${path}.tmp-`) && target === path)).toBe(true);
    expect(await coChangeHistory(root, ["a.ts", "b.ts"])).toEqual(expected);
    await fs.unlink(path);
    renames.mockRejectedValueOnce(new Error("disk failure"));
    expect(await coChangeHistory(root, ["a.ts", "b.ts"])).toEqual(expected);
    expect((await fs.readdir(directory)).some(name => name.includes(".tmp-"))).toBe(false);
  });

  it("journal activity cleans expired other roots but preserves fresh attribution and cleans failed staging", async () => {
    const other = provenancePathFor("/other-root", "other-session");
    await fs.writeFile(other, JSON.stringify({ version: 1, records: [{ at: now - JOURNAL_TTL_MS - 1 }] }));
    await fs.utimes(other, new Date(now - JOURNAL_TTL_MS - HOUR), new Date(now - JOURNAL_TTL_MS - HOUR));
    await recordMutationTransition(directory, "a.ts", "a", "b", "session", "call");
    await maintainTempStorage();
    expect(await exists(other)).toBe(false);
    expect((await attributeChanges(directory, "session", 0, [{ file: "a.ts", beforeSha: "a", afterSha: "b" }])).kind).toBe("current-session");
    const path = provenancePathFor(directory, "session");
    const before = await fs.readFile(path, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failure"));
    await expect(recordMutationTransition(directory, "a.ts", "b", "c", "session", "next")).rejects.toThrow();
    expect(await fs.readFile(path, "utf8")).toBe(before);
    expect((await fs.readdir(directory)).some(name => name.includes(".tmp-"))).toBe(false);
  });

  it("render spills trigger retention and omit the pointer when the per-file cap rejects output", async () => {
    const expired = await put(spill(999), 25 * HOUR);
    const path = join(directory, spill(0));
    const groups = Array.from({ length: 100 }, (_, n) => ({ label: "test", mass: n, detail: `item ${n} ${"x".repeat(100)}` }));
    const fit = revealGroups(groups, { header: "test", budget: 256, overflowTo: path });
    expect(fit.overflowPath).toBe(path);
    expect(await fs.readFile(path, "utf8")).toContain("item 99");
    await maintainTempStorage();
    expect(await exists(expired)).toBe(false);
    const tooBig = revealGroups([{ label: "test", mass: 1, detail: "x".repeat(8 * 1024 * 1024) }], { header: "test", budget: 256, overflowTo: path });
    expect(tooBig.overflowPath).toBeUndefined();
    expect(tooBig.text).not.toContain("saved to");
    expect(tooBig.tokens).toBeLessThanOrEqual(256);
  });

  it.skipIf(!hasAstGrep())("real concurrent ast-grep scans leave no rule artifacts on success or failure", async () => {
    await fs.writeFile(join(directory, "a.ts"), "console.log(42);\n");
    const rules = [{ id: "log", language: "TypeScript", pattern: "console.log($A)" }];
    const results = await Promise.all([scanRules(rules, ["a.ts"], directory), scanRules(rules, ["a.ts"], directory)]);
    expect(results.map(matches => matches?.length)).toEqual([1, 1]);
    expect(await scanRules([{ id: "invalid", language: "no-such-language", pattern: "x" }], ["a.ts"], directory)).toBeUndefined();
    expect((await fs.readdir(directory)).filter(name => name.startsWith("pi-fovea-scan-"))).toEqual([]);
  });

  it("adjacent config staging is removed after a failed replacement", async () => {
    const target = projectFoveaConfigPath(directory);
    await fs.mkdir(target, { recursive: true }); // forces rename-to-directory failure
    expect(() => saveFoveaConfig({ cwd: directory, agentDir: directory, projectTrusted: true }, { tools: { defaultBudget: 1024 } })).toThrow();
    expect((await fs.readdir(join(target, ".."))).some(name => name.includes(".tmp-"))).toBe(false);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });
});

describe("atomic storage and scan ownership", () => {
  it("cleans exclusively created scan files without UID APIs on success and failure", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
    try {
      await withScanRuleFile("rules", async path => { expect(await fs.readFile(path, "utf8")).toBe("rules"); });
      await expect(withScanRuleFile("rules", async () => { throw new Error("scan failed"); })).rejects.toThrow("scan failed");
      const originalOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => { await handle.write("partial"); throw new Error("disk full"); });
        return handle;
      });
      await expect(withScanRuleFile("rules", async () => {})).rejects.toThrow("disk full");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally { Object.defineProperty(process, "getuid", descriptor); }
  });

  it("does not accumulate persistent files without UID ownership verification", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
    Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
    try {
      await expect(writeAtomicTemp(join(directory, cache(0)), "facts")).rejects.toThrow("ownership");
      expect(() => writeSpill(join(directory, spill(0)), "spill")).toThrow("ownership");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally { Object.defineProperty(process, "getuid", descriptor); }
  });

  it("bounds descriptor reads when a file is growing after validation", async () => {
    const path = await put(cache(0), 0, "1234");
    const originalOpen = fs.open;
    let readHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      readHandle = handle;
      vi.spyOn(handle, "read");
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, "stat").mockImplementation((async () => {
        const snapshot = await originalStat();
        if (++calls === 2) await fs.appendFile(path, "x".repeat(10_000));
        return snapshot;
      }) as typeof handle.stat);
      return handle;
    });
    await expect(readTempText(path, 8)).rejects.toThrow("changed");
    expect(readHandle?.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 5, 0);
    expect((await fs.stat(path)).size).toBe(10_004);
  });
  it("bounds streamed writes, cleans failed partials, and preserves the previous cache", async () => {
    const path = await put(cache(0), 0, "previous");
    async function* oversized() { yield "123"; yield "456"; }
    await expect(writeAtomicTemp(path, oversized(), 5)).rejects.toThrow("size limit");
    expect(await fs.readFile(path, "utf8")).toBe("previous");
    expect(await fs.readdir(directory)).toEqual([cache(0)]);
    async function* broken() { yield "123"; throw new Error("writer failed"); }
    await expect(writeAtomicTemp(path, broken())).rejects.toThrow("writer failed");
    expect(await fs.readdir(directory)).toEqual([cache(0)]);
    await writeAtomicTemp(path, "complete");
    expect(await fs.readFile(path, "utf8")).toBe("complete");
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("cleans partials after rename failure, and rejects oversized cache reads/spills", async () => {
    const path = join(directory, cache(0));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    await expect(writeAtomicTemp(path, "data")).rejects.toThrow("rename failed");
    expect(await fs.readdir(directory)).toEqual([]);
    await fs.writeFile(path, "");
    await fs.truncate(path, CACHE_FILE_MAX_BYTES + 1);
    await expect(readTempText(path)).rejects.toThrow("oversized");
    expect(() => writeSpill(join(directory, spill(0)), "x".repeat(8 * 1024 * 1024 + 1))).toThrow("size limit");
    expect(await exists(join(directory, spill(0)))).toBe(false);
  });

  it("protects an active writer target even if its old version has expired", async () => {
    const path = await put(cache(0), 9 * 24 * HOUR);
    async function* writing() {
      await maintainTempStorage();
      expect(await exists(path)).toBe(true);
      yield "new";
    }
    await writeAtomicTemp(path, writing());
    expect(await fs.readFile(path, "utf8")).toBe("new");
  });

  it("keeps concurrent scan rules through use and always cleans success/failure", async () => {
    const paths: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const scan = (text: string) => withScanRuleFile(text, async path => {
      paths.push(path);
      if (paths.length === 2) entered();
      await gate;
      expect(await fs.readFile(path, "utf8")).toBe(text);
    });
    const first = scan("one");
    const second = scan("two");
    await ready;
    expect(new Set(paths).size).toBe(2);
    await maintainTempStorage(directory, now + 9 * 24 * HOUR);
    for (const path of paths) expect(await exists(path)).toBe(true);
    release();
    await Promise.all([first, second]);
    for (const path of paths) expect(await exists(path)).toBe(false);
    await expect(withScanRuleFile("three", async () => { throw new Error("scan failed"); })).rejects.toThrow("scan failed");
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
