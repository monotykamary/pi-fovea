import { readFile, writeFile, mkdir, rm, copyFile, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [root, name] = process.argv.slice(2);
const data = JSON.parse(await readFile(join(root, name), 'utf8'));
const work = join(root, `replay-${name}`);
await mkdir(join(work, 'bin'), { recursive: true });
await copyFile(new URL('./history-git.mjs', import.meta.url), join(work, 'bin/git'));
await chmod(join(work, 'bin/git'), 0o700);
process.env.PATH = `${join(work, 'bin')}:${process.env.PATH}`;
const baseline = await import(join(root, 'baseline/cochange.ts'));
const final = await import(join(root, 'final/cochange.ts'));
const tracked = new Set(data.files);
const shallow = new Set(data.shallow.trim().split(/\s+/));
const key = (a, b) => JSON.stringify(a < b ? [a, b] : [b, a]);
function records(log) {
  return log.split('\0FOVEA\0').slice(1).map(part => {
    const [sha, parents, ts, subject, ...tail] = part.split('\0');
    const fields = tail.slice(1).filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i].replace(/^\n/, '');
      if ((status === 'A' || status === 'M') && tracked.has(fields[i + 1])) files.push(fields[i + 1]);
    }
    return { sha, parents: parents.split(' ').filter(Boolean), ts: Number(ts) * 1000, subject, files: [...new Set(files)].sort() };
  }).filter(r => !shallow.has(r.sha));
}
function rawCommitPairs(log) {
  const pairs = new Set();
  for (const part of log.split('\0').slice(1)) {
    const files = [...new Set(part.split('\n').slice(1).filter(l => l.includes('\t')).map(l => l.split('\t').slice(2).join('\t')).filter(f => tracked.has(f)))];
    if (files.length > 24) continue;
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) pairs.add(key(files[i], files[j]));
  }
  return pairs;
}
function mapPairs(history) {
  const out = new Map();
  for (const [a, partners] of history) for (const p of partners) if (a < p.partner) out.set(key(a, p.partner), p);
  return out;
}
function summarize(history, module, now) {
  let maxDegree = 0, maxWeight = 0, maxEffective = 0, totalEffective = 0, totalBase = 0, minSupport = Infinity, maxSupport = 0, N = null;
  for (const [a, partners] of history) {
    maxDegree = Math.max(maxDegree, partners.length);
    assert.equal(new Set(partners.map(p => p.partner)).size, partners.length);
    for (const p of partners) {
      assert.notEqual(a, p.partner);
      assert.ok([p.n_ij, p.n_i, p.n_j, p.N].every(Number.isInteger));
      assert.ok(p.n_ij >= 2 && p.n_ij <= p.n_i && p.n_ij <= p.n_j && p.n_i <= p.N && p.n_j <= p.N);
      assert.ok(Number.isFinite(p.w) && p.w > 0 && p.w <= 0.5 && Number.isFinite(p.lastTs));
      const reverse = history.get(p.partner)?.find(q => q.partner === a);
      assert.ok(reverse);
      assert.deepEqual([reverse.w, reverse.lastTs, reverse.n_ij, reverse.n_i, reverse.n_j, reverse.N], [p.w, p.lastTs, p.n_ij, p.n_j, p.n_i, p.N]);
      const effective = module.effectiveWeight(p.w, Math.max(0, (now - p.lastTs) / 86400000));
      assert.ok(Number.isFinite(effective) && effective >= 0 && effective <= p.w);
      assert.equal(module.effectiveWeight(p.w, module.COCHANGE_HALF_LIFE_DAYS), p.w / 2);
      maxWeight = Math.max(maxWeight, p.w); maxEffective = Math.max(maxEffective, effective);
      totalEffective += effective / 2; totalBase += p.w / 2;
      minSupport = Math.min(minSupport, p.n_ij); maxSupport = Math.max(maxSupport, p.n_ij);
      N = p.N;
    }
  }
  // Endpoint top-16 union bounds edges by 16 times participating vertices, not degree by 16.
  const pairs = mapPairs(history).size;
  assert.ok(pairs <= 16 * history.size);
  const changed = [...history.keys()].sort().slice(0, 5);
  const residuals = module.expectationResiduals(changed, history, now);
  for (const [file, w] of residuals) assert.ok(!changed.includes(file) && Number.isFinite(w) && w > 0 && w <= 1);
  return { halfLifeDays: module.COCHANGE_HALF_LIFE_DAYS, pairs, vertices: history.size, N, maxDegree, maxWeight, maxEffective, totalEffective, totalBase, minSupport: Number.isFinite(minSupport) ? minSupport : null, maxSupport, residualPartnersForFirstFiveSeeds: residuals.size, residualMassForFirstFiveSeeds: [...residuals.values()].reduce((a,b) => a+b,0) };
}
async function mine(version, transport, suffix, now) {
  const repo = join(work, suffix + version);
  await mkdir(repo);
  await writeFile(join(repo, 'transport.json'), JSON.stringify(transport));
  await writeFile(join(repo, 'shallow'), data.shallow);
  const module = version === 'baseline' ? baseline : final;
  const cp = join(root, `pi-fovea-cochange-${createHash('sha1').update(repo).digest('hex').slice(0,16)}.json`);
  const start = performance.now();
  const cold = await module.coChangeHistory(repo, data.files, now);
  const coldMs = performance.now() - start;
  const cache = JSON.parse(await readFile(cp, 'utf8').catch(async error => { throw Error(`${version}/${suffix}: ${error.message}; calls=${await readFile(join(repo, 'calls.jsonl'), 'utf8').catch(() => 'NONE')}; history=${cold.size}`); }));
  const hit = await module.coChangeHistory(repo, [...data.files].reverse(), now);
  assert.deepEqual([...cold], [...hit], 'cache hit/input-order determinism');
  await rm(cp);
  const repeat = await module.coChangeHistory(repo, [...data.files].reverse(), now);
  assert.deepEqual([...cold], [...repeat], 'cold recompute determinism');
  const calls = (await readFile(join(repo, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'log').length, 2, 'exactly cold and recompute scans');
  await rm(cp, { force: true });
  const summary = summarize(cold, module, now);
  summary.N = cache.commits;
  summary.historyDigest = createHash('sha256').update(JSON.stringify([...cold])).digest('hex');
  return { history: cold, summary: { ...summary, coldMs, cacheDeterministic: true, invariantViolations: 0 } };
}
function compare(base, fin, transport) {
  const bp = mapPairs(base), fp = mapPairs(fin), raw = rawCommitPairs(transport.baseline);
  const added = [...fp.keys()].filter(k => !bp.has(k));
  const removed = [...bp.keys()].filter(k => !fp.has(k));
  const sameDir = added.filter(k => { const [a,b] = JSON.parse(k); return dirname(a) === dirname(b); }).length;
  return { retained: [...fp.keys()].filter(k => bp.has(k)).length, added: added.length, removed: removed.length, addedNeverJointInBaselineEligibleCommit: added.filter(k => !raw.has(k)).length, addedSameDirectory: sameDir, addedCrossDirectory: added.length - sameDir, addedExamples: added.slice(0, 3).map(k => JSON.parse(k)) };
}
try {
  // Frozen evaluation clock: recorded HEAD committer time, not machine date.
  const fullRecords = records(data.full.final);
  const now = Number(data.full.final.split('\0FOVEA\0')[1].split('\0')[2]) * 1000;
  const b = await mine('baseline', data.full, 'full-', now);
  const f = await mine('final', data.full, 'full-', now);
  const mergeRecords = fullRecords.filter(r => r.parents.length > 1);
  const controls = { observedFirstParent: fullRecords.length, mergeBoundaries: mergeRecords.length, oversizedMergeBoundaries: mergeRecords.filter(r => r.files.length > 24).length, oversizedAllBoundaries: fullRecords.filter(r => r.files.length > 24).length, explicitFixupSubjects: fullRecords.filter(r => /^(fixup!|squash!) /.test(r.subject)).length, shallowBoundariesExcluded: data.full.final.split('\0FOVEA\0').length - 1 - fullRecords.length, nearTimeDisjointNonmergeNeighbors: 0 };
  for (let i = 0; i + 1 < fullRecords.length; i++) {
    const a = fullRecords[i], b = fullRecords[i+1];
    if (a.parents.length <= 1 && b.parents.length <= 1 && Math.abs(a.ts-b.ts) <= 86400000 && a.files.length && b.files.length && !a.files.some(f => b.files.includes(f)) && !/^(fixup!|squash!) /.test(a.subject)) controls.nearTimeDisjointNonmergeNeighbors++;
  }
  let heldout = null;
  if (data.train) {
    const tb = await mine('baseline', data.train, 'train-', now), tf = await mine('final', data.train, 'train-', now);
    const boundary = fullRecords.findIndex(r => r.sha === data.entry.cutoff);
    assert.ok(boundary >= 0);
    const test = fullRecords.slice(0, boundary);
    const truth = new Set(), mergedTruth = new Set();
    for (const r of test) {
      if (r.files.length > 24) continue;
      for (let i=0;i<r.files.length;i++) for(let j=i+1;j<r.files.length;j++) {
        const k=key(r.files[i],r.files[j]); truth.add(k); if(r.parents.length>1) mergedTruth.add(k);
      }
    }
    const bp=mapPairs(tb.history), fp=mapPairs(tf.history);
    const score = pairs => ({ predicted: pairs.size, laterJoint: [...pairs.keys()].filter(k=>truth.has(k)).length, laterMergeJoint: [...pairs.keys()].filter(k=>mergedTruth.has(k)).length });
    const added = new Map([...fp].filter(([k])=>!bp.has(k)));
    heldout = { boundaries: test.length, eligibleObservedPairs: truth.size, baseline: score(bp), final: score(fp), added: score(added), trainBaseline: tb.summary, trainFinal: tf.summary };
  }
  assert.equal(f.summary.N <= fullRecords.length, true);
  // Independent raw-boundary accounting is applicable without explicit fixup grouping.
  if (controls.explicitFixupSubjects === 0) {
    assert.equal(f.summary.N, fullRecords.length, 'no near-time or bulk-boundary observation collapse');
    const touches = new Map(), support = new Map();
    for (const r of fullRecords) {
      for (const file of r.files) touches.set(file, (touches.get(file) ?? 0) + 1);
      if (r.files.length > 24) continue;
      for (let i=0;i<r.files.length;i++) for(let j=i+1;j<r.files.length;j++) {
        const k = key(r.files[i], r.files[j]); support.set(k, (support.get(k) ?? 0) + 1);
      }
    }
    for (const [a, partners] of f.history) for (const p of partners) {
      assert.equal(p.n_i, touches.get(a)); assert.equal(p.n_j, touches.get(p.partner));
      assert.equal(p.n_ij, support.get(key(a, p.partner)), 'only <=24-path boundaries contribute support');
    }
    controls.independentBoundaryCountsVerified = true;
  }
  console.log(JSON.stringify({ evaluationClockMs: now, baseline: b.summary, final: f.summary, comparison: compare(b.history, f.history, data.full), controls, heldout }));
} finally { await rm(work, { recursive: true, force: true }); }
