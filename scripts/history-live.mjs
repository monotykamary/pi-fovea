// Direct live-Git parity pilot. Run after acquisition/evaluation, before cleanup.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = process.argv[2] ?? (await readFile('/tmp/fovea-history-root.txt', 'utf8')).trim();
process.env.TMPDIR = root;
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' });
const report = JSON.parse(await readFile('docs/evaluations/history-corpus-results.json', 'utf8'));
const digest = value => createHash('sha256').update(JSON.stringify([...value])).digest('hex');
const results = [];
for (const repo of ['pallets/flask', 'pallets/click']) {
  const name = (await readdir(root)).find(n => n.endsWith(`${repo.replace('/', '_')}.json`));
  const data = JSON.parse(await readFile(join(root, name), 'utf8'));
  const expected = report.repos.find(r => r.repo === repo);
  const clone = await mkdtemp(join(root, 'live-'));
  const started = Date.now();
  const children = new Set();
  const run = (args, maxBuffer = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', clone, ...args], { encoding: 'utf8', detached: true, timeout: Math.max(1, 180000 - (Date.now() - started)), maxBuffer }, (error, stdout) => {
      children.delete(child);
      if (error) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(error); } else resolve(stdout);
    });
    children.add(child);
  });
  let maxKiB = 0, exceeded = false;
  const monitor = setInterval(() => {
    execFile('du', ['-sk', clone], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
      if (error) return;
      maxKiB = Math.max(maxKiB, Number(stdout.split(/\s/)[0]));
      if (maxKiB > 256 * 1024) { exceeded = true; for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
    });
  }, 1000);
  try {
    await run(['init', '--template=']);
    await run(['remote', 'add', 'origin', data.entry.url + '.git']);
    // This two-repo parity pilot needs actual numstat blobs; fetch them in one bounded pack.
    await run(['fetch', '--depth=450', '--no-tags', 'origin', data.entry.sha]);
    await run(['update-ref', 'HEAD', 'FETCH_HEAD']);
    const actual = await run(['log', '--format=%x00%ct', '--numstat', '-n', '400', '--no-renames', '--diff-filter=AMR', '--', '.']);
    const normalize = text => text.split('\n').filter(line => line.trim()).map(line => line.includes('\t') && !line.includes('\0') ? line.replace(/^[^\t]*\t[^\t]*\t/, '0\t0\t') : line).join('\n');
    assert.equal(normalize(actual), normalize(data.full.baseline), 'actual numstat paths/timestamps equal blobless transport');
    const cp = join(root, `pi-fovea-cochange-${createHash('sha1').update(clone).digest('hex').slice(0,16)}.json`);
    const parity = {};
    try {
      for (const version of ['baseline', 'final']) {
        await rm(cp, { force: true });
        const module = await import(join(root, version, 'cochange.ts'));
        const history = await module.coChangeHistory(clone, data.files, expected.evaluationClockMs);
        parity[version] = digest(history);
        assert.equal(parity[version], expected[version].historyDigest, `${version} live-Git and transport replay outputs differ`);
      }
      await run(['fetch', '--depth=20', '--no-tags', 'origin', data.entry.sha]);
      const ids = (await run(['rev-list', '--first-parent', '-n', '400', 'HEAD'])).trim().split('\n');
      const shallow = new Set((await readFile(join(clone, '.git/shallow'), 'utf8')).trim().split(/\s+/));
      const excluded = ids.filter(id => shallow.has(id)).length;
      assert.ok(excluded > 0, 'pilot must reach an actual shallow boundary');
      const module = await import(join(root, 'final/cochange.ts'));
      await module.coChangeHistory(clone, data.files, expected.evaluationClockMs);
      const cached = JSON.parse(await readFile(cp, 'utf8'));
      assert.equal(cached.commits, ids.length - excluded, 'shallow synthetic root excluded and same-HEAD cache invalidated');
      parity.shallowProbe = { depth: 20, observedFirstParent: ids.length, excluded, N: cached.commits };
    } finally { await rm(cp, { force: true }); }
    assert.ok(!exceeded);
    results.push({ repo, sha: data.entry.sha, baselineNumstatPathParity: true, liveHistoryParity: parity, elapsedMs: Date.now() - started, maxObservedKiB: maxKiB });
  } finally {
    clearInterval(monitor);
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await rm(clone, { recursive: true, force: true });
  }
}
await writeFile('docs/evaluations/history-live-results.json', JSON.stringify({ results, clonesAndCachesRemoved: true }, null, 2) + '\n');
console.log(`Direct live-Git parity passed for ${results.length} public repositories; clones/caches removed`);
