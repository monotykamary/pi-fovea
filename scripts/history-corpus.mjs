import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const exec = (bin, argv, options) => new Promise((resolve, reject) => {
  const child = execFile(bin, argv, { ...options, detached: true }, (error, stdout, stderr) => {
    if (error) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
      reject(Object.assign(error, { stderr }));
    } else resolve({ stdout });
  });
});
const cwd = process.cwd();
const BASE = '29a190cd19b154e7274124c1dd90f471bf62ba09';
const OUT = resolve(process.env.FOVEA_HISTORY_OUTPUT ?? 'docs/evaluations');
const POINTER = process.env.FOVEA_HISTORY_POINTER ?? '/tmp/fovea-history-root.txt';
const args = process.argv.slice(2);
const mode = args[0] ?? 'all';
const target = Number(args[1] ?? 100);
if (['all', 'acquire'].includes(mode) && (!Number.isInteger(target) || target < 1 || target > 100)) throw Error('Target must be an integer in 1..100');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' };
const run = async (bin, argv, options = {}) => (await exec(bin, argv, { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, env, ...options })).stdout;
const git = (root, argv, options) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', root, ...argv], options);
const hash = text => createHash('sha256').update(text).digest('hex');
const finalArgs = sha => ['log', '--first-parent', '--diff-merges=first-parent', '--root', '--format=%x00FOVEA%x00%H%x00%P%x00%ct%x00%s%x00', '--name-status', '-z', '-n', '400', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-notes', '--no-show-signature', '--no-color', sha, '--'];
const baseArgs = sha => ['log', '--format=%x00%ct', '--name-only', '-n', '400', '--no-renames', '--diff-filter=AMR', sha, '--', '.'];
const numstatTransport = text => text.split('\n').map(line => !line.trim() || line.includes('\0') ? line : `0\t0\t${line}`).join('\n');
const sourceFile = path => /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|[ch]|[ch]pp|cc|hh|ex|exs|erl|hrl|swift|[rR]|scala|jl|cs|fs|fsx|sh|lua|dart|hs|ml|mli|clj|cljs|vue|svelte)$/.test(path) && !/(^|\/)(?:vendor|node_modules|third_party|dist|build)\//.test(path);
async function acquire(root) {
  const manifest = JSON.parse(await readFile('scripts/history-manifest.json', 'utf8'));
  const sample = Object.entries(manifest.groups).flatMap(([ecosystem, repos]) => repos.map(repo => ({ repo, ecosystem })));
  sample.push(...manifest.reserves.map(repo => ({ repo, ecosystem: 'reserve' })));
  const pinsFile = args.find(a => a.startsWith('--pins='))?.slice(7);
  if (pinsFile === '') throw Error('Pins must name a nonempty file path');
  const pins = pinsFile ? JSON.parse(await readFile(pinsFile, 'utf8'))?.repos : null;
  if (pinsFile !== undefined) {
    if (!Array.isArray(pins) || pins.length !== target
      || pins.some(p => !p || typeof p.canonical !== 'string'
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.canonical)
        || typeof p.sha !== 'string' || !/^[0-9a-f]{40}$/.test(p.sha))
      || new Set(pins.map(p => p.canonical.toLowerCase())).size !== target) throw Error('Pins must contain exactly target distinct canonical repositories with exact SHAs');
    sample.splice(0, sample.length, ...pins.map(p => ({ repo: p.canonical, ecosystem: p.ecosystem, sha: p.sha })));
  }
  const successes = [], failures = [], seen = new Set();
  let next = 0;
  async function one(item) {
    const start = Date.now();
    const clone = await mkdtemp(join(root, 'clone-'));
    let monitor, exceeded = false;
    try {
      const info = JSON.parse(await run('gh', ['api', `repos/${item.repo}`, '--jq', '{full_name,private,default_branch}']));
      if (info.private) throw Error('Not public');
      const canonical = info.full_name.toLowerCase();
      if (seen.has(canonical)) throw Error('Duplicate canonical repository');
      seen.add(canonical);
      const timeout = () => Math.max(1, 180000 - (Date.now() - start));
      monitor = setInterval(async () => {
        try {
          const size = Number((await run('du', ['-sk', clone], { timeout: 10000 })).split(/\s/)[0]);
          if (size > 256 * 1024) exceeded = true;
        } catch { /* final command/error owns diagnostics */ }
      }, 2000);
      const abort = new AbortController();
      const guard = setInterval(() => { if (exceeded) abort.abort(); }, 250);
      try {
        const pinned = item.sha;
        if (pinned) {
          await git(clone, ['init', '--template=']);
          await git(clone, ['remote', 'add', 'origin', `https://github.com/${info.full_name}.git`]);
          await git(clone, ['config', 'remote.origin.promisor', 'true']);
          await git(clone, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
          await git(clone, ['-c', 'remote.origin.promisor=true', '-c', 'remote.origin.partialclonefilter=blob:none', 'fetch', '--depth=450', '--filter=blob:none', '--no-tags', 'origin', pinned], { timeout: timeout(), signal: abort.signal });
          await git(clone, ['update-ref', 'HEAD', 'FETCH_HEAD']);
        } else {
          await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--template=', '--depth=450', '--filter=blob:none', '--no-checkout', '--single-branch', '--no-tags', `https://github.com/${info.full_name}.git`, clone], { timeout: timeout(), signal: abort.signal });
        }
        const sha = (await git(clone, ['rev-parse', 'HEAD'], { timeout: timeout() })).trim();
        const files = (await git(clone, ['ls-tree', '-rz', '--name-only', sha], { timeout: timeout(), signal: abort.signal })).split('\0').filter(sourceFile).sort();
        if (!files.length || files.length > 100000) throw Error(`Tracked source file safeguard: ${files.length}`);
        const shallow = await readFile(join(clone, '.git/shallow'), 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
        const collect = async head => {
          const final = await git(clone, finalArgs(head), { timeout: timeout(), signal: abort.signal, maxBuffer: 16 * 1024 * 1024 });
          const baseline = numstatTransport(await git(clone, baseArgs(head), { timeout: timeout(), signal: abort.signal }));
          return { head, final, baseline };
        };
        const full = await collect(sha);
        const boundaries = (await git(clone, ['rev-list', '--first-parent', '-n', '400', sha], { timeout: timeout() })).trim().split('\n');
        const cutoff = boundaries.length > 100 ? boundaries[80] : null;
        const train = cutoff ? await collect(cutoff) : null;
        const sizeKiB = Number((await run('du', ['-sk', clone])).split(/\s/)[0]);
        if (exceeded || sizeKiB > 256 * 1024) throw Error(`Size safeguard exceeded: ${sizeKiB} KiB`);
        const entry = { ...item, canonical: info.full_name, url: `https://github.com/${info.full_name}`, sha, depthRequested: 450, shallow: !!shallow, shallowBoundaries: shallow.trim().split(/\s+/).filter(Boolean).length, firstParentBoundaries: boundaries.length, cutoff, sourceFiles: files.length, sizeKiB, acquisitionMs: Date.now() - start };
        await writeFile(join(root, `${successes.length}-${item.repo.replace('/', '_')}.json`), JSON.stringify({ entry, files, shallow, full, train }));
        successes.push(entry);
      } finally { clearInterval(guard); }
    } catch (error) {
      failures.push({ ...item, acquisitionMs: Date.now() - start, error: String(error.message).slice(0, 1400) });
    } finally {
      clearInterval(monitor);
      await rm(clone, { recursive: true, force: true });
      await writeFile(join(root, 'progress.json'), JSON.stringify({ successes, failures, clonesRemoved: true }, null, 2));
      console.log(`${successes.length}/${target} success; ${failures.length} failures; ${item.repo}`);
    }
  }
  // Batch reservations avoid exceeding the requested successful count.
  while (successes.length < target && next < sample.length) {
    const count = Math.min(4, target - successes.length, sample.length - next);
    const settled = await Promise.allSettled(sample.slice(next, next += count).map(one));
    const failure = settled.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (successes.length !== target) throw Error(`Corpus incomplete: ${successes.length}/${target}; inspect ${join(root, 'progress.json')}`);
  return { successes, failures };
}
async function snapshot(root) {
  const fingerprints = {};
  for (const version of ['baseline', 'final']) {
    const dest = join(root, version);
    await mkdir(dest, { recursive: true });
    fingerprints[version] = {};
    for (const file of ['cochange.ts', 'git.ts', 'asyncutil.ts']) {
      const text = version === 'baseline' ? await git(cwd, ['show', `${BASE}:src/core/${file}`]) : await readFile(`src/core/${file}`, 'utf8');
      await writeFile(join(dest, file), text);
      fingerprints[version][file] = hash(text);
    }
  }
  return fingerprints;
}
async function evaluate(root) {
  await mkdir(OUT, { recursive: true });
  const fingerprints = await snapshot(root);
  const results = [];
  const metadata = (await readdir(root)).filter(f => /^\d+-.*\.json$/.test(f)).sort();
  const worker = resolve('scripts/history-worker.mjs');
  for (let index = 0; index < metadata.length; index += 4) {
    const settled = await Promise.allSettled(metadata.slice(index, index + 4).map(async name => {
      const data = JSON.parse(await readFile(join(root, name), 'utf8'));
      const output = await run('bun', [worker, root, name], { timeout: 120000, env: { ...env, TMPDIR: root } });
      return { ...data.entry, metadataSha256: hash(await readFile(join(root, name), 'utf8')), ...JSON.parse(output) };
    }));
    const failure = settled.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...settled.map(r => r.value));
    console.log(`Evaluated ${results.length}/${metadata.length}`);
  }
  for (const [file, expected] of Object.entries(fingerprints.final)) {
    if (hash(await readFile(`src/core/${file}`, 'utf8')) !== expected) throw Error(`Production changed during evaluation: ${file}; rerun evaluate`);
  }
  const progress = JSON.parse(await readFile(join(root, 'progress.json'), 'utf8'));
  const report = { baselineCommit: BASE, modelProvenance: { requested: 'openai-codex/gpt-5.6-sol', managerRecorded: 'openai-codex/gpt-5.6-sol', agentId: 'd6b9e2ed1bf246639d943ea9c155d6d9', inheritedHostEnvironment: process.env.PI_MODEL ?? null }, evaluatedAt: new Date().toISOString(), fingerprints, successfulCount: results.length, failedAttempts: progress.failures, repos: results };
  await writeFile(join(OUT, 'history-corpus-results.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
const verified = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
const packageInfo = JSON.parse(await readFile(join(verified, 'package.json'), 'utf8'));
if (verified !== cwd || packageInfo.name !== 'pi-fovea' || resolve(fileURLToPath(new URL('..', import.meta.url))) !== cwd) throw Error('Run from this pi-fovea checkout root');
await git(cwd, ['cat-file', '-e', `${BASE}:src/core/cochange.ts`]);
let root;
if (mode === 'acquire' || mode === 'all') {
  root = await mkdtemp(join(tmpdir(), 'fovea-history-eval-'));
  console.log(`TEMP_ROOT=${root}`);
  await writeFile(POINTER, root);
  try {
    await acquire(root);
    if (mode === 'all') await evaluate(root);
  } finally {
    if (mode === 'all') { await rm(root, { recursive: true, force: true }); await rm(POINTER, { force: true }); }
  }
} else {
  root = args[1] ?? (await readFile(POINTER, 'utf8')).trim();
  if (!/\/fovea-history-eval-[^/]+$/.test(root)) throw Error('Invalid experiment root');
  if (mode === 'evaluate') await evaluate(root);
  else if (mode === 'cleanup') { await rm(root, { recursive: true, force: true }); await rm(POINTER, { force: true }); }
  else throw Error(`Unknown mode ${mode}`);
}
