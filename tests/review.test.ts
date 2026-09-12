import { beforeEach, describe, expect, it } from "vitest";
import { observeReviewRevision, recordReviewRead, reviewReport, reviewTrailer, updateReviewMemory, type ReviewSample } from "../src/core/review.js";
import { clearSessionFocus, getSession, refreshSessionReviews, resetSessions } from "../src/core/session.js";

const samples = (salience = 1, revision: string | undefined = "v1") =>
  new Map<string, ReviewSample>([["client.ts", { salience, revision, reasons: ["call dependency"] }]]);
const sessionFor = () => getSession("/tmp/pi-fovea-review");

beforeEach(() => resetSessions());

describe("hysteretic review memory", () => {
  it("replaces salience without accumulating invocation-count debt", () => {
    const session = sessionFor();
    const memory = updateReviewMemory(session, ["server.ts"], samples(2));
    const first = reviewReport(memory);
    for (let i = 0; i < 20; i++) updateReviewMemory(session, ["server.ts"], samples(2));
    expect(reviewReport(memory)).toEqual(first);
    updateReviewMemory(session, ["server.ts"], samples(0.25));
    expect(memory.entries.get("client.ts")?.salience).toBe(0.25);
    expect(reviewReport(memory)).toMatchObject({ total: 1, unseen: 1 });
  });

  it("keeps cold unseen markers and exposure independently of disclosure", () => {
    const session = sessionFor();
    const memory = updateReviewMemory(session, ["server.ts"], samples());
    updateReviewMemory(session, ["server.ts"], new Map());
    clearSessionFocus(session);
    session.disclosed.add("client.ts");
    expect(reviewReport(memory)).toMatchObject({ unseen: 1, entries: [{ salience: 0, status: "unseen" }] });
    recordReviewRead(memory, "client.ts", "v1", { start: 8, end: 12 });
    updateReviewMemory(session, ["server.ts"], samples(10));
    expect(reviewReport(memory)).toMatchObject({ seen: 1, unseen: 0,
      entries: [{ salience: 10, exposure: { revision: "v1", windows: [{ start: 8, end: 12 }] } }] });
    expect(reviewTrailer(reviewReport(memory))).toContain("1 seen (windows only)");
    expect(reviewTrailer(reviewReport(memory))).not.toMatch(/verified|complete|unresolved|obligation/);
  });

  it("latches stale exposure across edits, unavailable revisions, and reverts", () => {
    const memory = updateReviewMemory(sessionFor(), ["server.ts"], samples());
    recordReviewRead(memory, "client.ts", "v1", { start: 2, end: 4 });
    observeReviewRevision(memory, "client.ts", "v1");
    expect(reviewReport(memory).seen).toBe(1);
    observeReviewRevision(memory, "client.ts", "v2");
    expect(reviewReport(memory)).toMatchObject({ unseen: 0, seen: 0, stale: 1 });
    observeReviewRevision(memory, "client.ts", undefined);
    observeReviewRevision(memory, "client.ts", "v1");
    expect(reviewReport(memory).stale).toBe(1);
    recordReviewRead(memory, "client.ts", "v3", { start: 20, end: 21 });
    expect(reviewReport(memory)).toMatchObject({ seen: 1, stale: 0,
      entries: [{ exposure: { revision: "v3", windows: [{ start: 20, end: 21 }] } }] });
  });

  it("reconciles revision drift without creating sessions or treating it as heat", () => {
    const session = sessionFor();
    const memory = updateReviewMemory(session, ["server.ts"], samples());
    recordReviewRead(memory, "client.ts", "v1", { start: 1, end: 1 });
    refreshSessionReviews(session.root, () => "shell-edit");
    expect(reviewReport(memory)).toMatchObject({ stale: 1, entries: [{ salience: 1 }] });
    refreshSessionReviews("/tmp/unobserved", () => { throw new Error("must not enumerate an absent session"); });
  });

  it("merges returned windows, bounds history, and returns detached snapshots", () => {
    const memory = updateReviewMemory(sessionFor(), ["server.ts"], samples());
    for (const window of [{ start: 2, end: 3 }, { start: 4, end: 5 }, { start: 2, end: 3 }]) {
      recordReviewRead(memory, "client.ts", "v1", window);
    }
    expect(memory.entries.get("client.ts")?.exposure?.windows).toEqual([{ start: 2, end: 5 }]);
    for (let i = 0; i < 20; i++) recordReviewRead(memory, "client.ts", "v1", { start: 10 + i * 3, end: 10 + i * 3 });
    const report = reviewReport(memory);
    expect(report.entries[0]?.exposure?.windows).toHaveLength(16);
    expect(report.entries[0]?.exposure?.windowsOmitted).toBe(true);
    report.entries[0]!.exposure!.windows[0]!.end = 999;
    report.entries[0]!.reasons.push("not real");
    expect(memory.entries.get("client.ts")?.exposure?.windows[0]?.end).toBe(5);
    expect(memory.entries.get("client.ts")?.reasons).toEqual(["call dependency"]);
  });

  it("ignores invalid salience and read windows", () => {
    const session = sessionFor();
    const memory = updateReviewMemory(session, ["server.ts"], samples());
    for (const value of [0, -1, NaN, Infinity]) updateReviewMemory(session, ["server.ts"], samples(value));
    for (const window of [{ start: 0, end: 1 }, { start: 2, end: 1 }, { start: 1.5, end: 3 }]) {
      recordReviewRead(memory, "client.ts", "v1", window);
    }
    expect(reviewReport(memory)).toMatchObject({ unseen: 1, seen: 0, entries: [{ salience: 0 }] });
  });

  it("reports bounded omissions and actual evictions without inflating repeated omissions", () => {
    const session = sessionFor();
    const many = new Map<string, ReviewSample>();
    for (let i = 0; i < 514; i++) many.set(`file-${i}.ts`, { salience: i + 1, revision: "v1", reasons: [] });
    const memory = updateReviewMemory(session, ["seed.ts"], many);
    expect(reviewReport(memory)).toMatchObject({ total: 512, omitted: 2, evicted: 0 });
    updateReviewMemory(session, ["seed.ts"], many);
    expect(reviewReport(memory)).toMatchObject({ total: 512, omitted: 2, evicted: 0 });
    updateReviewMemory(session, ["seed.ts"], new Map([["new.ts", { salience: 99, revision: "v1", reasons: [] }]]));
    expect(reviewReport(memory)).toMatchObject({ total: 512, omitted: 0, evicted: 1 });
    expect(reviewTrailer(reviewReport(memory))).toContain("1 entries evicted");
  });

  it("reports epoch rotation, preserves growing changes, and clears old captures on reset", () => {
    const session = sessionFor();
    const memory = updateReviewMemory(session, ["a.ts"], samples());
    expect(updateReviewMemory(session, ["a.ts", "b.ts"], samples())).toBe(memory);
    expect(updateReviewMemory(session, [], new Map())).toBe(memory);
    const next = updateReviewMemory(session, ["other.ts"], new Map());
    expect(next).not.toBe(memory);
    expect(memory.entries.size).toBe(0);
    expect(reviewReport(next)).toMatchObject({ total: 0, previous: { total: 1, unseen: 1 } });
    expect(reviewTrailer(reviewReport(next))).toContain("prior epoch cleared: 1 entries");
    updateReviewMemory(session, ["other.ts"], samples());
    expect(reviewReport(next).previous?.total).toBe(1);
    resetSessions();
    recordReviewRead(next, "client.ts", "v1", { start: 1, end: 1 });
    expect(next.entries.size).toBe(0);
    expect(session.reviewMemory).toBeUndefined();
  });
});
