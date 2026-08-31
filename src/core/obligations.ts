// Persistent review obligations are deliberately separate from sync's
// wall-clock-decayed novelty heat. This module has no timers or IO: callers
// drive every state transition explicitly on the active Fovea session.

import type { FoveaSession } from "./session.js";

type ObligationEpoch = NonNullable<FoveaSession["obligationEpoch"]>;
type ObligationEntry = ObligationEpoch["ledger"] extends Map<string, infer Entry> ? Entry : never;

type ResidualObligation = ObligationEntry & { file: string };
type EpochStats = {
  total: number;
  unresolved: number;
  inspected: number;
  changed: number;
  verified: number;
  mass: number;
};

const LEDGER_LIMIT = 512;

const seedFingerprint = (seedFiles: Iterable<string>): string => {
  // Canonicalizing a copy freezes the epoch's seed baseline without retaining
  // a second mutable collection alongside the prescribed ledger state.
  const files = [...new Set(seedFiles)].sort();
  let hash = 0x811c9dc5;
  for (const file of files) {
    for (let i = 0; i < file.length; i++) {
      hash = Math.imul(hash ^ file.charCodeAt(i), 0x01000193);
    }
    hash = Math.imul(hash ^ 0, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const nextEpochOrdinal = (session: FoveaSession): number => {
  const encoded = session.obligationEpoch?.epochId.match(/^obligation-([0-9a-z]+)-/)?.[1];
  const previous = encoded === undefined ? 0 : Number.parseInt(encoded, 36);
  return Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
};

/** Start a fresh obligation epoch and discard every obligation from the old one. */
export const openEpoch = (session: FoveaSession, seedFiles: Iterable<string>): ObligationEpoch => {
  const ordinal = nextEpochOrdinal(session);
  session.obligationEpoch?.ledger.clear();
  const epoch: ObligationEpoch = {
    epochId: `obligation-${ordinal.toString(36)}-${seedFingerprint(seedFiles)}`,
    ledger: new Map(),
  };
  session.obligationEpoch = epoch;
  return epoch;
};

const activeEpoch = (session: FoveaSession): ObligationEpoch =>
  session.obligationEpoch ?? openEpoch(session, []);

const enforceBound = (ledger: ObligationEpoch["ledger"]): void => {
  if (ledger.size <= LEDGER_LIMIT) return;
  // Keep the strongest obligations. Path order makes equal-mass eviction
  // deterministic; lexically earlier paths survive a tie.
  const weakest = [...ledger.entries()].sort(
    (a, b) => a[1].mass - b[1].mass || b[0].localeCompare(a[0]),
  );
  for (let i = 0; i < weakest.length - LEDGER_LIMIT; i++) {
    ledger.delete(weakest[i]![0]);
  }
};

/** Add durable file-level warmth to the current epoch. Existing state is preserved. */
export const mergeWarmed = (
  session: FoveaSession,
  fileMass: ReadonlyMap<string, number>,
  reason: string,
): void => {
  const ledger = activeEpoch(session).ledger;
  for (const [file, mass] of fileMass) {
    // Heat mass is non-negative. Ignoring invalid input keeps a malformed
    // producer from reducing or poisoning an already-durable obligation.
    if (!Number.isFinite(mass) || mass <= 0) continue;
    const entry = ledger.get(file);
    if (entry) {
      const sum = entry.mass + mass;
      entry.mass = Number.isFinite(sum) ? sum : Number.MAX_VALUE;
      if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason);
      continue;
    }
    ledger.set(file, {
      mass,
      reasons: reason ? [reason] : [],
      generation: 0,
      status: "unresolved",
    });
  }
  enforceBound(ledger);
};

/** Record that the latest generation was inspected; verification remains explicit. */
export const markRead = (session: FoveaSession, files: Iterable<string>): void => {
  const ledger = session.obligationEpoch?.ledger;
  if (!ledger) return;
  for (const file of files) {
    const entry = ledger.get(file);
    if (entry?.status === "unresolved" || entry?.status === "changed") {
      entry.status = "inspected";
    }
  }
};

/** Record a new file generation. A subsequent read can inspect this generation again. */
export const markEdited = (session: FoveaSession, files: Iterable<string>): void => {
  const ledger = session.obligationEpoch?.ledger;
  if (!ledger) return;
  for (const file of files) {
    const entry = ledger.get(file);
    if (!entry) continue;
    entry.generation++;
    entry.status = "changed";
  }
};

/** Mark obligations verified without deleting their epoch history. */
export const markVerified = (session: FoveaSession, files: Iterable<string>): void => {
  const ledger = session.obligationEpoch?.ledger;
  if (!ledger) return;
  for (const file of files) {
    const entry = ledger.get(file);
    if (entry) entry.status = "verified";
  }
};

/** Return a non-consuming, strongest-first snapshot for the checklist renderer. */
export const residual = (session: FoveaSession): ResidualObligation[] => {
  const ledger = session.obligationEpoch?.ledger;
  if (!ledger) return [];
  return [...ledger.entries()]
    .filter(([, entry]) => entry.status === "unresolved")
    .sort((a, b) => b[1].mass - a[1].mass || a[0].localeCompare(b[0]))
    .map(([file, entry]) => ({
      file,
      mass: entry.mass,
      reasons: [...entry.reasons],
      generation: entry.generation,
      status: "unresolved",
    }));
};

/** Summarize all retained entries and their total, non-decaying mass. */
export const epochStats = (session: FoveaSession): EpochStats => {
  const stats: EpochStats = {
    total: 0,
    unresolved: 0,
    inspected: 0,
    changed: 0,
    verified: 0,
    mass: 0,
  };
  for (const entry of session.obligationEpoch?.ledger.values() ?? []) {
    stats.total++;
    stats.mass += entry.mass;
    stats[entry.status]++;
  }
  return stats;
};
