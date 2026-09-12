// Hysteretic review memory: salience changes with each cascade, while exposure
// survives cooling. This is bounded navigation memory, never completion evidence.
import type { FoveaSession } from "./session.js";

interface ReadWindow { start: number; end: number }
interface Exposure {
  revision: string;
  windows: ReadWindow[];
  windowsOmitted: boolean;
}
interface ReviewEntry {
  salience: number;
  reasons: string[];
  revision: string | undefined;
  status: "unseen" | "seen" | "stale";
  exposure?: Exposure;
}
interface ReviewCounts {
  total: number;
  unseen: number;
  seen: number;
  stale: number;
  evicted: number;
  omitted: number;
}
export interface ReviewMemory {
  epoch: number;
  seeds: Set<string>;
  entries: Map<string, ReviewEntry>;
  evicted: number;
  omitted: number;
  previous?: ReviewCounts;
}
export interface ReviewSample {
  salience: number;
  reasons: string[];
  revision: string | undefined;
}
const FILE_LIMIT = 512;
const WINDOW_LIMIT = 16;
const counts = (memory?: ReviewMemory): ReviewCounts => {
  const result = { total: memory?.entries.size ?? 0, unseen: 0, seen: 0, stale: 0,
    evicted: memory?.evicted ?? 0, omitted: memory?.omitted ?? 0 };
  for (const entry of memory?.entries.values() ?? []) result[entry.status]++;
  return result;
};
const bySalience = (a: [string, ReviewEntry], b: [string, ReviewEntry]): number =>
  b[1].salience - a[1].salience || a[0].localeCompare(b[0]);

/** A changed or unavailable source makes previous exposure stale, even on revert. */
export const observeReviewRevision = (memory: ReviewMemory | undefined, file: string, revision: string | undefined): void => {
  const entry = memory?.entries.get(file);
  if (!entry || entry.revision === revision) return;
  entry.revision = revision;
  entry.status = entry.exposure ? "stale" : "unseen";
};

/** Replace current salience, never accumulate invocation-count debt. */
export const updateReviewMemory = (
  session: FoveaSession,
  seeds: Iterable<string>,
  samples: ReadonlyMap<string, ReviewSample>,
): ReviewMemory => {
  const incoming = [...new Set(seeds)];
  let memory = session.reviewMemory;
  if (!memory || (incoming.length && !incoming.some((file) => memory!.seeds.has(file)))) {
    const previous = memory ? counts(memory) : undefined;
    const epoch = (memory?.epoch ?? 0) + 1;
    memory?.entries.clear();
    memory = { epoch, seeds: new Set(incoming), entries: new Map(), evicted: 0, omitted: 0, previous };
    session.reviewMemory = memory;
  }
  const retained = new Set(memory.entries.keys());
  for (const entry of memory.entries.values()) entry.salience = 0;
  for (const [file, sample] of samples) {
    if (!Number.isFinite(sample.salience) || sample.salience <= 0) continue;
    let entry = memory.entries.get(file);
    if (!entry) {
      entry = { salience: 0, reasons: [], revision: sample.revision, status: "unseen" };
      memory.entries.set(file, entry);
    }
    observeReviewRevision(memory, file, sample.revision);
    entry.salience = sample.salience;
    entry.reasons = [...new Set(sample.reasons)].sort();
  }
  memory.omitted = 0;
  for (const [file] of [...memory.entries].sort(bySalience).slice(FILE_LIMIT)) {
    memory.entries.delete(file);
    if (retained.has(file)) memory.evicted++;
    else memory.omitted++;
  }
  return memory;
};

/** Record returned source lines, not whole-file inspection or understanding. */
export const recordReviewRead = (memory: ReviewMemory, file: string, revision: string, window: ReadWindow): void => {
  const entry = memory.entries.get(file);
  if (!entry || !revision || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) ||
    window.start < 1 || window.end < window.start) return;
  observeReviewRevision(memory, file, revision);
  const previous = entry.exposure?.revision === revision ? entry.exposure : undefined;
  const windows = [...(previous?.windows ?? []), { ...window }].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ReadWindow[] = [];
  for (const next of windows) {
    const last = merged[merged.length - 1];
    if (last && next.start <= last.end + 1) last.end = Math.max(last.end, next.end);
    else merged.push({ ...next });
  }
  entry.exposure = { revision, windows: merged.slice(0, WINDOW_LIMIT),
    windowsOmitted: !!previous?.windowsOmitted || merged.length > WINDOW_LIMIT };
  entry.status = "seen";
};

/** Snapshot all retained entries, pending first. Presentation never consumes them. */
export const reviewReport = (memory?: ReviewMemory) => ({
  ...counts(memory),
  epoch: memory?.epoch,
  previous: memory?.previous ? { ...memory.previous } : undefined,
  entries: [...(memory?.entries ?? [])]
    .sort((a, b) => Number(a[1].status === "seen") - Number(b[1].status === "seen") || bySalience(a, b))
    .map(([file, entry]) => ({ ...entry, file, reasons: [...entry.reasons],
      exposure: entry.exposure ? { ...entry.exposure, windows: entry.exposure.windows.map((w) => ({ ...w })) } : undefined })),
});

export const reviewTrailer = (report: ReturnType<typeof reviewReport>): string => {
  if (!report.total && !report.previous && !report.evicted && !report.omitted) return "";
  const files = report.entries.filter((entry) => entry.status !== "seen").slice(0, 3).map((entry) => entry.file);
  const notes = [
    files.length ? files.join(", ") : "",
    report.evicted ? `${report.evicted} entries evicted` : "",
    report.omitted ? `${report.omitted} candidates not retained` : "",
    report.previous ? `prior epoch cleared: ${report.previous.total} entries (${report.previous.unseen} unread, ${report.previous.stale} stale)` : "",
  ].filter(Boolean);
  return `review memory · ${report.unseen} unread · ${report.stale} stale · ${report.seen} seen (windows only)` +
    (notes.length ? ` · ${notes.join(" · ")}` : "");
};
