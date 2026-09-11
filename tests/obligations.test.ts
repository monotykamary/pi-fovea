import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureEpoch,
  epochStats,
  markEdited,
  markRead,
  markVerified,
  mergeWarmed,
  openEpoch,
  residual,
} from "../src/core/obligations.js";
import { getSession, resetSessions } from "../src/core/session.js";

const sessionFor = (name: string) => getSession(`/tmp/pi-fovea-obligations-${name}`);

describe("persistent residual obligations", () => {
  beforeEach(() => resetSessions());

  it("merges mass additively and retains distinct reasons", () => {
    const session = sessionFor("merge");
    openEpoch(session, ["seed.ts"]);

    mergeWarmed(session, new Map([
      ["client.ts", 1.25],
      ["schema.ts", 0.5],
    ]), "call dependency");
    mergeWarmed(session, new Map([["client.ts", 0.75]]), "call dependency");
    mergeWarmed(session, new Map([["client.ts", 0.25]]), "shared route");

    expect(session.obligationEpoch?.ledger.get("client.ts")).toEqual({
      mass: 2.25,
      reasons: ["call dependency", "shared route"],
      generation: 0,
      status: "unresolved",
    });
    expect(epochStats(session)).toEqual({
      total: 2,
      unresolved: 2,
      inspected: 0,
      changed: 0,
      verified: 0,
      mass: 2.75,
    });
  });

  it("tracks reads and edits against the current file generation", () => {
    const session = sessionFor("generation");
    openEpoch(session, []);
    mergeWarmed(session, new Map([["worker.py", 1]]), "graph path");
    const entry = session.obligationEpoch!.ledger.get("worker.py")!;

    markRead(session, ["worker.py"]);
    expect(entry).toMatchObject({ generation: 0, status: "inspected" });

    markEdited(session, ["worker.py"]);
    expect(entry).toMatchObject({ generation: 1, status: "changed" });

    markRead(session, ["worker.py"]);
    expect(entry).toMatchObject({ generation: 1, status: "inspected" });

    markVerified(session, ["worker.py"]);
    markRead(session, ["worker.py"]);
    expect(entry).toMatchObject({ generation: 1, status: "verified" });

    markEdited(session, ["worker.py"]);
    expect(entry).toMatchObject({ generation: 2, status: "changed" });
  });

  it("bounds the ledger at 512 files by evicting the lowest mass", () => {
    const session = sessionFor("bound");
    openEpoch(session, []);
    const masses = new Map<string, number>();
    for (let i = 0; i < 513; i++) masses.set(`file-${i.toString().padStart(3, "0")}.ts`, i + 1);

    mergeWarmed(session, masses, "diffusion residual");

    expect(session.obligationEpoch!.ledger.size).toBe(512);
    expect(session.obligationEpoch!.ledger.has("file-000.ts")).toBe(false);
    expect(session.obligationEpoch!.ledger.get("file-512.ts")?.mass).toBe(513);
  });

  it("returns only unresolved entries in descending mass order", () => {
    const session = sessionFor("order");
    openEpoch(session, []);
    mergeWarmed(session, new Map([
      ["z.ts", 2],
      ["b.ts", 4],
      ["a.ts", 4],
      ["read.ts", 9],
    ]), "impact cascade");
    markRead(session, ["read.ts"]);

    expect(residual(session)).toEqual([
      { file: "a.ts", mass: 4, reasons: ["impact cascade"], generation: 0, status: "unresolved" },
      { file: "b.ts", mass: 4, reasons: ["impact cascade"], generation: 0, status: "unresolved" },
      { file: "z.ts", mass: 2, reasons: ["impact cascade"], generation: 0, status: "unresolved" },
    ]);
  });

  it("does not consume obligations when they are queried or disclosed", () => {
    const session = sessionFor("durable");
    openEpoch(session, ["server.go"]);
    mergeWarmed(session, new Map([["client.ts", 3]]), "shared route");

    const rendered = residual(session);
    rendered[0]!.reasons.push("renderer-only mutation");
    session.disclosed.add("symbol@client.ts");

    expect(residual(session)).toEqual([
      { file: "client.ts", mass: 3, reasons: ["shared route"], generation: 0, status: "unresolved" },
    ]);
    expect(epochStats(session).mass).toBe(3);

    markRead(session, ["client.ts"]);
    expect(residual(session)).toEqual([]);
    expect(epochStats(session)).toMatchObject({ total: 1, inspected: 1, mass: 3 });
  });

  it("clears retained ledgers on an explicit epoch or session reset", () => {
    const session = sessionFor("reset");
    const first = openEpoch(session, ["seed.ts"]);
    mergeWarmed(session, new Map([["client.ts", 2]]), "call dependency");

    const second = openEpoch(session, ["seed.ts"]);
    expect(second.epochId).not.toBe(first.epochId);
    expect(first.ledger.size).toBe(0);
    expect(residual(session)).toEqual([]);

    mergeWarmed(session, new Map([["schema.yaml", 1]]), "shared route");
    resetSessions();

    expect(second.ledger.size).toBe(0);
    expect(residual(session)).toEqual([]);
    expect(epochStats(session)).toEqual({
      total: 0,
      unresolved: 0,
      inspected: 0,
      changed: 0,
      verified: 0,
      mass: 0,
    });
    expect(getSession(session.root)).not.toBe(session);
  });
});

describe("change-epoch rotation", () => {
  it("opens an epoch on the first cascade and keeps it while the diff grows", () => {
    const session = sessionFor("rotate-open");
    expect(ensureEpoch(session, ["a.ts", "b.ts"]).rotated).toBe(false);
    mergeWarmed(session, new Map([["client.ts", 1]]), "diffusion residual");
    expect(session.obligationEpoch?.seeds).toEqual(new Set(["a.ts", "b.ts"]));

    // An uncommitted diff that keeps growing retains every earlier seed, so the
    // change in flight never loses the checklist it is still working through.
    expect(ensureEpoch(session, ["a.ts", "b.ts", "client.ts"]).rotated).toBe(false);
    expect(residual(session).map((entry) => entry.file)).toEqual(["client.ts"]);
  });

  it("rotates when the cascade shares no seed with the active change", () => {
    const session = sessionFor("rotate-disjoint");
    ensureEpoch(session, ["a.ts"]);
    mergeWarmed(session, new Map([["client.ts", 2]]), "diffusion residual");
    const first = session.obligationEpoch!.epochId;

    const decision = ensureEpoch(session, ["unrelated.ts"]);

    expect(decision).toEqual({
      rotated: true,
      previous: {
        total: 1,
        unresolved: 1,
        inspected: 0,
        changed: 0,
        verified: 0,
        mass: 2,
      },
    });
    expect(session.obligationEpoch!.epochId).not.toBe(first);
    expect(session.obligationEpoch!.seeds).toEqual(new Set(["unrelated.ts"]));
    expect(residual(session)).toEqual([]);
  });

  it("never discards a ledger for a seedless or repeated cascade", () => {
    const session = sessionFor("rotate-guard");
    ensureEpoch(session, ["a.ts"]);
    mergeWarmed(session, new Map([["client.ts", 1]]), "diffusion residual");

    expect(ensureEpoch(session, []).rotated).toBe(false);
    expect(ensureEpoch(session, ["a.ts"]).rotated).toBe(false);
    expect(residual(session).map((entry) => entry.file)).toEqual(["client.ts"]);
  });

  it("does not resurrect an obligation that a rotation dropped", () => {
    const session = sessionFor("rotate-drop");
    ensureEpoch(session, ["a.ts"]);
    mergeWarmed(session, new Map([["client.ts", 1]]), "diffusion residual");
    ensureEpoch(session, ["b.ts"]);

    markRead(session, ["client.ts"]);
    expect(epochStats(session)).toEqual({
      total: 0,
      unresolved: 0,
      inspected: 0,
      changed: 0,
      verified: 0,
      mass: 0,
    });
  });
});
