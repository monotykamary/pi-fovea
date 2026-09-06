import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const input = process.argv[2] ?? 'docs/evaluations/history-corpus-results.json';
const data = JSON.parse(await readFile(input, 'utf8'));
const sum = fn => data.repos.reduce((total, repo) => total + fn(repo), 0);
assert.equal(data.successfulCount, 100);
assert.equal(new Set(data.repos.map(r => r.canonical.toLowerCase())).size, 100);
for (const [file, expected] of Object.entries(data.fingerprints.final)) {
  assert.equal(createHash('sha256').update(await readFile(`src/core/${file}`, 'utf8')).digest('hex'), expected, `delivered ${file} differs from evaluated source`);
}
const summary = {
  successfulDistinctPublicRepos: data.successfulCount,
  failedCorpusAttempts: data.failedAttempts.length,
  sourceFiles: sum(r=>r.sourceFiles),
  baseline: { pairs: sum(r=>r.baseline.pairs), observations: sum(r=>r.baseline.N), basePriorSum: sum(r=>r.baseline.totalBase), effectivePriorSum: sum(r=>r.baseline.totalEffective) },
  final: { pairs: sum(r=>r.final.pairs), observations: sum(r=>r.final.N), basePriorSum: sum(r=>r.final.totalBase), effectivePriorSum: sum(r=>r.final.totalEffective), maximumDegree: Math.max(...data.repos.map(r=>r.final.maxDegree)) },
  comparison: Object.fromEntries(['retained','added','removed','addedNeverJointInBaselineEligibleCommit','addedSameDirectory','addedCrossDirectory'].map(key=>[key,sum(r=>r.comparison[key])])),
  controls: Object.fromEntries(['observedFirstParent','mergeBoundaries','oversizedMergeBoundaries','oversizedAllBoundaries','explicitFixupSubjects','shallowBoundariesExcluded','nearTimeDisjointNonmergeNeighbors','independentBoundaryCountsVerified'].map(key=>[key,sum(r=>Number(r.controls[key]))])),
  heldout: { repositories: data.repos.filter(r=>r.heldout).length, boundaries: sum(r=>r.heldout?.boundaries ?? 0), eligibleObservedPairs: sum(r=>r.heldout?.eligibleObservedPairs ?? 0) },
  acquisition: { summedMs: sum(r=>r.acquisitionMs), maxCloneKiB: Math.max(...data.repos.map(r=>r.sizeKiB)), summedCloneKiB: sum(r=>r.sizeKiB), requestedDepth: 450, concurrency: 4, repoDeadlineSeconds: 180, cloneLimitMiB: 256 },
  checks: { independentBoundaryCountRepos: sum(r=>Number(r.controls.independentBoundaryCountsVerified)), invariantViolations: sum(r=>r.baseline.invariantViolations+r.final.invariantViolations+r.heldout.trainBaseline.invariantViolations+r.heldout.trainFinal.invariantViolations), cacheDeterministicRepos: sum(r=>Number(r.baseline.cacheDeterministic && r.final.cacheDeterministic && r.heldout.trainBaseline.cacheDeterministic && r.heldout.trainFinal.cacheDeterministic)) },
  fingerprints: data.fingerprints,
};
for (const version of ['baseline','final','added']) {
  const predicted=sum(r=>r.heldout?.[version].predicted ?? 0), laterJoint=sum(r=>r.heldout?.[version].laterJoint ?? 0);
  summary.heldout[version]={ predicted, laterJoint, observedHitFraction: laterJoint / predicted, laterMergeJoint: sum(r=>r.heldout?.[version].laterMergeJoint ?? 0) };
}
await writeFile('docs/evaluations/history-corpus-summary.json', JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
