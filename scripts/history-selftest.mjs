import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
async function sandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fovea-history-test-'));
  const env = { ...process.env, TMPDIR: root, FOVEA_HISTORY_POINTER: join(root, 'pointer'), FOVEA_HISTORY_OUTPUT: join(root, 'out') };
  try { await fn(root, env); } finally { await rm(root, { recursive: true, force: true }); }
}
test('sample has 100 distinct primary public repository names and distinct reserves', async () => {
  const m = JSON.parse(await readFile('scripts/history-manifest.json', 'utf8'));
  const primary = Object.values(m.groups).flat();
  assert.equal(primary.length, 100);
  assert.equal(new Set([...primary, ...m.reserves].map(s=>s.toLowerCase())).size, 110);
});
test('invalid target and incomplete pins fail closed and remove all-mode temporary roots', async () => sandbox(async (root, env) => {
  await assert.rejects(exec(process.execPath, ['scripts/history-corpus.mjs', 'all', '0'], { env }), /Target must/);
  const pins = join(root, 'pins.json');
  for (const malformed of [{}, null, { repos: null }, { repos: [] }, { repos: 'not-an-array' }, { repos: [null] }]) {
    await writeFile(pins, JSON.stringify(malformed));
    await assert.rejects(exec(process.execPath, ['scripts/history-corpus.mjs', 'all', '1', `--pins=${pins}`], { env }), /Pins must/);
  }
  await assert.rejects(exec(process.execPath, ['scripts/history-corpus.mjs', 'all', '1', '--pins='], { env }), /Pins must/);
  await writeFile(pins, JSON.stringify({ repos: [{ canonical: 'pallets/flask', ecosystem: 'Python' }] }));
  await assert.rejects(exec(process.execPath, ['scripts/history-corpus.mjs', 'all', '1', `--pins=${pins}`], { env }), /Pins must/);
  assert.deepEqual(await readdir(root), ['pins.json']);
}));
test('pinned real public repos reproduce selection, use configured half-life, and clean all-mode state', { timeout: 240000 }, async () => sandbox(async (root, env) => {
  const recorded = JSON.parse(await readFile('docs/evaluations/history-corpus-results.json', 'utf8'));
  const repos = recorded.repos.filter(r => ['pallets/flask', 'pallets/click'].includes(r.repo));
  assert.equal(repos.length, 2);
  const pins = join(root, 'pins.json');
  await writeFile(pins, JSON.stringify({ repos }));
  await exec(process.execPath, [resolve('scripts/history-corpus.mjs'), 'all', '2', `--pins=${pins}`], { env: { ...env, FOVEA_COCHANGE_HALF_LIFE_DAYS: '45' }, timeout: 220000 });
  const result = JSON.parse(await readFile(join(root, 'out/history-corpus-results.json'), 'utf8'));
  assert.equal(result.successfulCount, 2);
  assert.equal(result.failedAttempts.length, 0);
  assert.deepEqual(result.repos.map(r=>r.sha).sort(), repos.map(r=>r.sha).sort());
  for (const r of result.repos) { assert.equal(r.final.halfLifeDays, 45); assert.equal(r.final.invariantViolations, 0); }
  assert.deepEqual((await readdir(root)).sort(), ['out', 'pins.json']);
}));
