// Runtime-only, activity-driven housekeeping. Never imported by registration.
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, opendir, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1024 * 1024;
const HOUR = 3600_000;
export const JOURNAL_TTL_MS = 7 * 24 * HOUR;
export const CACHE_FILE_MAX_BYTES = 64 * MiB;
const SPILL_FILE_MAX_BYTES = 8 * MiB;
const INTERVAL = 5 * 60_000;
const policies = {
  cache: { bytes: 128 * MiB, entries: 128, ttl: 7 * 24 * HOUR, grace: INTERVAL },
  spill: { bytes: 32 * MiB, entries: 128, ttl: 24 * HOUR, grace: HOUR },
};
const cacheName = /^pi-fovea-(?:cochange-)?[a-f0-9]{16}\.json$/;
const spillName = /^pi-fovea-(?:focus|dwell|impact|sketch)-[a-f0-9]{8}\.txt$/;
const journalName = /^pi-fovea-provenance-[a-f0-9]{16}-[a-f0-9]{16}\.json$/;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const partialName = new RegExp(`^(.+)\\.tmp-([1-9][0-9]*)-(${uuid})$`);
const scanName = new RegExp(`^pi-fovea-scan-([1-9][0-9]*)-(${uuid})\\.yml$`);
const active = new Map<string, number>();
const hold = (path: string): (() => void) => {
  active.set(path, (active.get(path) ?? 0) + 1);
  return () => {
    const count = (active.get(path) ?? 1) - 1;
    if (count) active.set(path, count); else active.delete(path);
  };
};
const owned = (s: Stats): boolean => typeof process.getuid === "function"
  && s.uid === process.getuid() && s.isFile() && s.nlink === 1;
// A matching exclusive-creation snapshot proves our own staging ownership even
// where UID APIs are absent; sweeps independently require current-UID ownership.
const same = (a: Stats, b: Stats): boolean => b.isFile() && b.nlink === 1 && a.uid === b.uid
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const dead = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
const removeUnchanged = async (path: string, snapshot: Stats): Promise<boolean> => {
  try {
    if (active.has(path) || !same(snapshot, await lstat(path)) || active.has(path)) return false;
    await unlink(path);
    return true;
  } catch { return false; }
};

/** No symlink following, other-user reads, or unbounded cache reads. Caller closes. */
export const openTempRead = async (path: string, maxBytes = CACHE_FILE_MAX_BYTES) => {
  const before = await lstat(path);
  if (!owned(before) || before.size > maxBytes) throw new Error("Unsafe or oversized temporary file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(before, await handle.stat())) throw new Error("Temporary file changed");
    return handle;
  } catch (error) { await handle.close(); throw error; }
};
export const readTempText = async (path: string, maxBytes = CACHE_FILE_MAX_BYTES): Promise<string> => {
  const handle = await openTempRead(path, maxBytes);
  try {
    const before = await handle.stat();
    if (!owned(before) || before.size > maxBytes) throw new Error("Unsafe or oversized temporary file");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== before.size || !same(before, await handle.stat())) throw new Error("Temporary file changed");
    return bytes.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
};

interface Entry { path: string; stat: Stats }
const sweep = async (directory: string, now: number, dryRun = false): Promise<string[]> => {
  const removed: string[] = [];
  const remove = async (path: string, stat: Stats): Promise<boolean> => {
    try {
      const eligible = dryRun
        ? !active.has(path) && same(stat, await lstat(path)) && !active.has(path)
        : await removeUnchanged(path, stat);
      if (eligible) removed.push(path);
      return eligible;
    } catch { return false; }
  };
  const groups: Record<keyof typeof policies, Entry[]> = { cache: [], spill: [] };
  // opendir avoids a giant array of unrelated names in a shared OS temp dir.
  const dir = await opendir(directory);
  for await (const item of dir) {
    const name = item.name;
    const kind = cacheName.test(name) ? "cache" : spillName.test(name) ? "spill" : undefined;
    const journal = journalName.test(name);
    const partial = partialName.exec(name);
    const scan = scanName.exec(name);
    const pid = scan ? Number(scan[1]) : partial && (cacheName.test(partial[1]!)
      || spillName.test(partial[1]!) || journalName.test(partial[1]!)) ? Number(partial[2]) : undefined;
    if (!kind && !journal && pid === undefined) continue;
    const path = join(directory, name);
    try {
      const stat = await lstat(path);
      if (!owned(stat)) continue;
      if (kind) { groups[kind].push({ path, stat }); continue; }
      if (active.has(path)) continue;
      if (pid !== undefined) {
        // A PID reuse/EPERM keeps the orphan, never risks a live writer/scan.
        if (now - stat.mtimeMs > HOUR && dead(pid)) await remove(path, stat);
      } else if (now - stat.mtimeMs > JOURNAL_TTL_MS) {
        // Mtime is only a cheap prefilter. Attribution expires by record time,
        // never by disk pressure or the caller's narrower `since` window.
        const data = JSON.parse(await readTempText(path)) as { version?: number; records?: { at?: number }[] };
        if (data.version === 1 && Array.isArray(data.records)
          && data.records.every(r => typeof r.at === "number" && Number.isFinite(r.at) && r.at < now - JOURNAL_TTL_MS)) {
          await remove(path, stat);
        }
      }
    } catch { /* missing, malformed, inaccessible, concurrent replacement */ }
  }
  for (const kind of ["cache", "spill"] as const) {
    const entries = groups[kind].sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path));
    const policy = policies[kind];
    let bytes = entries.reduce((n, e) => n + e.stat.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      const age = now - entry.stat.mtimeMs;
      if (age <= policy.grace) continue;
      if (age <= policy.ttl && count <= policy.entries && bytes <= policy.bytes) continue;
      if (await remove(entry.path, entry.stat)) { count--; bytes -= entry.stat.size; }
    }
  }
  return removed;
};

/** Explicit maintenance is preview-only unless apply is deliberately requested. */
export const pruneTempStorage = (options: { directory: string; dryRun?: boolean; now?: number }): Promise<string[]> =>
  sweep(options.directory, options.now ?? Date.now(), options.dryRun ?? true);

let maintenance: { directory: string; at: number; pending?: Promise<void> } | undefined;
/** Coalesced, at most once / five minutes per process, only on actual activity. */
export const maintainTempStorage = (directory = tmpdir(), now = Date.now()): Promise<void> => {
  if (maintenance?.directory === directory) {
    if (maintenance.pending) return maintenance.pending;
    if (now >= maintenance.at && now - maintenance.at < INTERVAL) return Promise.resolve();
  }
  const state = { directory, at: now, pending: undefined as Promise<void> | undefined };
  maintenance = state;
  state.pending = sweep(directory, now).then(() => undefined).catch(() => {}).finally(() => { state.pending = undefined; });
  return state.pending;
};

const checkTarget = async (path: string): Promise<void> => {
  try { if (!owned(await lstat(path))) throw new Error("Unsafe temporary target"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
};

/** Exclusive 0600 staging, bounded streaming, atomic replacement, finally cleanup. */
export const writeAtomicTemp = async (
  target: string, content: string | AsyncIterable<string>, maxBytes = CACHE_FILE_MAX_BYTES,
): Promise<void> => {
  if (typeof process.getuid !== "function") throw new Error("Cannot verify temporary-file ownership");
  const release = hold(target);
  void maintainTempStorage();
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let snapshot: Stats | undefined;
  try {
    await checkTarget(target);
    const handle = await open(temporary, "wx", 0o600);
    try {
      snapshot = await handle.stat();
      let bytes = 0;
      for await (const chunk of typeof content === "string" ? [content] : content) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) throw new Error("Temporary file size limit exceeded");
        await handle.writeFile(chunk);
      }
    } finally {
      // Include all writes in the identity used to clean a partial failure.
      snapshot = await handle.stat().catch(() => snapshot);
      await handle.close();
    }
    await checkTarget(target);
    await rename(temporary, target);
  } finally {
    if (snapshot) await removeUnchanged(temporary, snapshot);
    release();
    void maintainTempStorage();
  }
};

/** Renderers are synchronous; retention is still asynchronous and coalesced. */
export const writeSpill = (target: string, text: string): void => {
  if (typeof process.getuid !== "function") throw new Error("Cannot verify temporary-file ownership");
  void maintainTempStorage();
  if (Buffer.byteLength(text) > SPILL_FILE_MAX_BYTES) throw new Error("Spill size limit exceeded");
  const check = (): void => {
    try { if (!owned(lstatSync(target))) throw new Error("Unsafe spill target"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  check();
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  let snapshot: Stats | undefined;
  try {
    snapshot = fstatSync(fd);
    writeFileSync(fd, text);
    check();
    renameSync(temporary, target);
  } finally {
    try { snapshot = fstatSync(fd); } finally { closeSync(fd); }
    try { if (snapshot && same(snapshot, lstatSync(temporary))) unlinkSync(temporary); } catch { /* best effort */ }
  }
};

/** Each invocation owns its rule file until all of its child scans settle. */
export const withScanRuleFile = async <T>(text: string, run: (path: string) => Promise<T>): Promise<T> => {
  const path = join(tmpdir(), `pi-fovea-scan-${process.pid}-${randomUUID()}.yml`);
  void maintainTempStorage();
  const handle = await open(path, "wx", 0o600);
  let snapshot: Stats | undefined;
  try {
    try {
      snapshot = await handle.stat();
      await handle.writeFile(text);
    } finally {
      snapshot = await handle.stat().catch(() => snapshot);
      await handle.close();
    }
    return await run(path);
  } finally {
    if (snapshot) await removeUnchanged(path, snapshot);
  }
};
