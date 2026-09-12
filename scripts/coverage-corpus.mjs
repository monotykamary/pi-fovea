import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory, baseline, candidate] = process.argv.slice(2);
if (!directory) throw Error('Usage: bun scripts/coverage-corpus.mjs acquire|run <work-dir> [baseline-source candidate-source]');
const work = resolve(directory);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' };
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, detached: true, ...options }, (error, stdout, stderr) => {
    if (error) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      reject(Error(`${error.message}\n${stderr}`));
    } else resolve(stdout);
  });
});
const git = (root, args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', root, ...args]);
const save = (name, value) => writeFile(join(work, name), JSON.stringify(value, null, 2) + '\n');
await mkdir(work, { recursive: true });
if (mode === 'acquire') {
  const manifest = JSON.parse(await readFile(new URL('./coverage-manifest.json', import.meta.url), 'utf8'));
  const successes = [], failures = [];
  await mkdir(join(work, 'repos'), { recursive: true });
  for (let at = 0; at < manifest.repos.length; at += 3) {
    const batch = await Promise.all(manifest.repos.slice(at, at + 3).map(async item => {
      const id = item.repo.toLowerCase().replace('/', '--');
      const root = join(work, 'repos', id);
      let owned = false;
      try {
        if (!/^[\w.-]+\/[\w.-]+$/.test(item.repo) || (item.sha && !/^[a-f0-9]{40}$/.test(item.sha))) throw Error('Invalid repository pin');
        const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing) {
          if (!existing.isDirectory()) throw Error('Existing checkout path is not a directory; left untouched');
          const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
          const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
          if (await realpath(top) !== await realpath(root) || !item.sha || sha !== item.sha || (await git(root, ['status', '--porcelain', '--untracked-files=normal'])).trim()) {
            throw Error('Existing checkout is unpinned, mismatched, or dirty; left untouched. Use a fresh work directory.');
          }
          const sizeKiB = Number((await run('du', ['-sk', root])).split(/\s+/)[0]);
          if (sizeKiB > 512 * 1024) throw Error(`Checkout exceeds 512 MiB: ${sizeKiB} KiB`);
          return { ...item, id, sha, sizeKiB, scope: item.scope ?? '.', reused: true };
        }
        owned = true;
        if (item.sha) {
          await mkdir(root, { recursive: true });
          await git(root, ['init', '-q', '--template=']);
          await git(root, ['remote', 'add', 'origin', `https://github.com/${item.repo}.git`]);
          await git(root, ['fetch', '--depth=1', '--no-tags', 'origin', item.sha]);
          await git(root, ['checkout', '--detach', 'FETCH_HEAD']);
        } else {
          await run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--template=', '--depth=1', '--single-branch', '--no-tags', `https://github.com/${item.repo}.git`, root]);
        }
        const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
        const sizeKiB = Number((await run('du', ['-sk', root])).split(/\s+/)[0]);
        if (sizeKiB > 512 * 1024) throw Error(`Checkout exceeds 512 MiB: ${sizeKiB} KiB`);
        return { ...item, id, sha, sizeKiB, scope: item.scope ?? '.' };
      } catch (error) {
        if (owned) await rm(root, { recursive: true, force: true });
        return { ...item, error: String(error.message).slice(0, 2000) };
      }
    }));
    for (const item of batch) {
      (item.error ? failures : successes).push(item);
      console.log(`${item.error ? 'FAIL' : 'OK'} ${item.repo}`);
    }
    await save('pins.json', { selection: manifest.selection, successes, failures });
  }
  await save('acquisition-done.json', { successful: successes.length, failed: failures.length });
  if (successes.length < 31) throw Error(`Need at least 31 repositories; acquired ${successes.length}`);
} else if (mode === 'run') {
  if (!baseline || !candidate) throw Error('Run requires both baseline and candidate source directories');
  const pins = JSON.parse(await readFile(join(work, 'pins.json'), 'utf8'));
  const worker = fileURLToPath(new URL('./coverage-worker.ts', import.meta.url));
  await mkdir(join(work, 'results'), { recursive: true });
  const outcomes = [];
  for (let at = 0; at < pins.successes.length; at += 2) {
    const batch = await Promise.all(pins.successes.slice(at, at + 2).map(async pin => {
      const record = { ...pin };
      for (const [label, engine] of [['baseline', resolve(baseline)], ['candidate', resolve(candidate)]]) {
        const output = join(work, 'results', `${pin.id}-${label}.json`);
        const cache = join(work, 'cache', `${pin.id}-${label}`);
        await mkdir(cache, { recursive: true });
        try {
          await run(process.execPath, [worker, engine, join(work, 'repos', pin.id, pin.scope), output], {
            timeout: 300000,
            env: { ...env, TMPDIR: cache, FOVEA_MAX_FILES: '8000', FOVEA_MAX_FILE_BYTES: '1048576', FOVEA_SPAWN_CONCURRENCY: '2' },
          });
          record[label] = { ok: true, output };
        } catch (error) {
          record[label] = { ok: false, error: String(error.message).slice(0, 3000) };
        }
      }
      console.log(`${record.baseline.ok && record.candidate.ok ? 'OK' : 'FAIL'} ${pin.repo}`);
      return record;
    }));
    outcomes.push(...batch);
    await save('runs.json', { outcomes });
  }
  await save('run-done.json', { paired: outcomes.filter(item => item.baseline.ok && item.candidate.ok).length, attempted: outcomes.length });
} else throw Error(`Unknown mode: ${mode}`);
