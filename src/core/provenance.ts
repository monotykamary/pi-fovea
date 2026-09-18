import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { JOURNAL_TTL_MS, maintainTempStorage, readTempText, writeAtomicTemp } from "./temp-storage.js";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const JOURNAL_VERSION = 1;
const JOURNAL_MAX_RECORDS = 256;

interface MutationRecord {
  file: string;
  beforeSha?: string;
  afterSha?: string;
  owner: string;
  toolCallId: string;
  commitOrder?: number;
  at: number;
}

interface MutationJournal {
  version: number;
  root: string;
  owner: string;
  records: MutationRecord[];
}

export interface MutationCapture {
  root: string;
  file: string;
  absolutePath: string;
  beforeSha?: string;
}

export interface MutationTransition {
  path: string;
  beforeSha?: string | undefined;
  afterSha?: string | undefined;
  commitOrder?: number | undefined;
}

type ProvenanceKind = "current-session" | "other-session" | "mixed" | "unattributed";

export interface SyncProvenance {
  kind: ProvenanceKind;
  files: Record<string, ProvenanceKind>;
}

const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");
const ownerFor = (sessionId: string): string => sha1(sessionId).slice(0, 16);
const rootKey = (root: string): string => sha1(resolve(root)).slice(0, 16);
const prefixFor = (root: string): string => `pi-fovea-provenance-${rootKey(root)}-`;

export const provenancePathFor = (root: string, sessionId: string): string =>
  join(tmpdir(), `${prefixFor(root)}${ownerFor(sessionId)}.json`);

const hashFile = async (path: string): Promise<string | undefined> => {
  try {
    return createHash("sha1").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
};

const repoPath = (root: string, path: string): { file: string; absolutePath: string } | undefined => {
  const absolutePath = resolve(root, path);
  const file = relative(resolve(root), absolutePath);
  if (!file || file === ".." || file.startsWith(`..${sep}`) || isAbsolute(file)) return undefined;
  return { file: file.split(sep).join("/"), absolutePath };
};

export const captureMutation = async (root: string, path: string): Promise<MutationCapture | undefined> => {
  const located = repoPath(root, path);
  if (!located) return undefined;
  return { root: resolve(root), ...located, beforeSha: await hashFile(located.absolutePath) };
};

const writeQueues = new Map<string, Promise<void>>();

const persistRecords = async (
  target: string,
  journal: MutationJournal,
  additions: readonly MutationRecord[],
): Promise<void> => {
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  let records: MutationRecord[] = [];
  try {
    const existing = JSON.parse(await readTempText(target, Infinity)) as MutationJournal;
    if (existing.version === JOURNAL_VERSION && existing.root === journal.root && existing.owner === journal.owner) {
      records = existing.records.filter((item) => item.at >= cutoff);
    }
  } catch {
    // Missing and torn journals both recover as a fresh per-session file.
  }
  records.push(...additions);
  journal.records = records.slice(-JOURNAL_MAX_RECORDS);
  // Attribution is not a regenerable cache: never impose a pressure/byte cap.
  await writeAtomicTemp(target, JSON.stringify(journal), Infinity);
};

export const recordMutationTransitions = async (
  root: string,
  transitions: readonly MutationTransition[],
  sessionId: string,
  toolCallId: string,
): Promise<number> => {
  const resolvedRoot = resolve(root);
  const owner = ownerFor(sessionId);
  const at = Date.now();
  const records = transitions.flatMap((transition): MutationRecord[] => {
    const located = repoPath(root, transition.path);
    if (!located || transition.beforeSha === transition.afterSha) return [];
    return [{
      file: located.file,
      beforeSha: transition.beforeSha,
      afterSha: transition.afterSha,
      owner,
      toolCallId,
      ...(transition.commitOrder === undefined ? {} : { commitOrder: transition.commitOrder }),
      at,
    }];
  });
  if (records.length === 0) return 0;
  const target = provenancePathFor(resolvedRoot, sessionId);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(() => persistRecords(target, {
    version: JOURNAL_VERSION, root: resolvedRoot, owner, records: [],
  }, records));
  writeQueues.set(target, queued);
  try {
    await queued;
    return records.length;
  } finally {
    if (writeQueues.get(target) === queued) writeQueues.delete(target);
  }
};

export const recordMutationTransition = async (
  root: string,
  path: string,
  beforeSha: string | undefined,
  afterSha: string | undefined,
  sessionId: string,
  toolCallId: string,
): Promise<boolean> => (await recordMutationTransitions(
  root, [{ path, beforeSha, afterSha }], sessionId, toolCallId,
)) === 1;

export const finishMutation = async (
  capture: MutationCapture,
  sessionId: string,
  toolCallId: string,
): Promise<boolean> => recordMutationTransition(
  capture.root, capture.file, capture.beforeSha, await hashFile(capture.absolutePath), sessionId, toolCallId,
);

const readRecords = async (root: string, since: number): Promise<MutationRecord[]> => {
  void maintainTempStorage();
  const prefix = prefixFor(root);
  await Promise.all([...writeQueues.entries()]
    .filter(([path]) => path.split(/[/\\]/u).at(-1)?.startsWith(prefix))
    .map(([, pending]) => pending.catch(() => {})));
  const cutoff = Math.max(since, Date.now() - JOURNAL_TTL_MS);
  let names: string[];
  try {
    names = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix) && /^[a-f0-9]{16}\.json$/.test(name.slice(prefix.length)));
  } catch {
    return [];
  }
  const records: MutationRecord[] = [];
  await Promise.all(names.map(async (name) => {
    const path = join(tmpdir(), name);
    try {
      const journal = JSON.parse(await readTempText(path, Infinity)) as MutationJournal;
      if (journal.version !== JOURNAL_VERSION || journal.root !== resolve(root) || !Array.isArray(journal.records)) return;
      const live = journal.records.filter((record) => record.at >= cutoff);
      records.push(...live);
    } catch {
      // A concurrent atomic replacement or malformed journal is unattributed.
    }
  }));
  return records.sort((a, b) => a.at - b.at
    || a.owner.localeCompare(b.owner)
    || (a.commitOrder ?? Number.MAX_SAFE_INTEGER) - (b.commitOrder ?? Number.MAX_SAFE_INTEGER)
    || a.toolCallId.localeCompare(b.toolCallId));
};

const kindForOwners = (owners: Set<string>, currentOwner: string): ProvenanceKind => {
  if (!owners.size) return "unattributed";
  if (owners.size === 1) return owners.has(currentOwner) ? "current-session" : "other-session";
  return "mixed";
};

const ownersForTransition = (
  records: MutationRecord[],
  beforeSha: string | undefined,
  afterSha: string | undefined,
): Set<string> => {
  const states = new Map<string, Set<string>>();
  const key = (sha: string | undefined): string => sha ?? "\0deleted";
  states.set(key(beforeSha), new Set());
  for (const record of records) {
    const owners = states.get(key(record.beforeSha));
    if (!owners) continue;
    const nextKey = key(record.afterSha);
    const next = states.get(nextKey) ?? new Set<string>();
    for (const owner of owners) next.add(owner);
    next.add(record.owner);
    states.set(nextKey, next);
  }
  return states.get(key(afterSha)) ?? new Set();
};

export const attributeChanges = async (
  root: string,
  sessionId: string,
  since: number,
  changes: Array<{ file: string; beforeSha?: string; afterSha?: string }>,
): Promise<SyncProvenance> => {
  const records = await readRecords(root, since);
  const recordsByFile = new Map<string, MutationRecord[]>();
  for (const record of records) {
    const matching = recordsByFile.get(record.file) ?? [];
    matching.push(record);
    recordsByFile.set(record.file, matching);
  }
  const currentOwner = ownerFor(sessionId);
  const files: Record<string, ProvenanceKind> = {};
  for (const change of changes) {
    files[change.file] = kindForOwners(
      ownersForTransition(recordsByFile.get(change.file) ?? [], change.beforeSha, change.afterSha),
      currentOwner,
    );
  }
  const kinds = new Set(Object.values(files));
  return {
    kind: kinds.size === 0 ? "unattributed" : kinds.size === 1 ? [...kinds][0]! : "mixed",
    files,
  };
};
