// Paired latency measurements with output parity, not a timing gate in check.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const distribution = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samples };
};
const measure = async task => {
  for (let i = 0; i < 3; i++) await task();
  const samples = [];
  for (let i = 0; i < 15; i++) { const t = performance.now(); await task(); samples.push(performance.now() - t); }
  return distribution(samples);
};
if (process.argv[2] === 'worker') {
  const [engine, root, query, sharedCache] = process.argv.slice(3);
  const load = name => import(pathToFileURL(join(engine, 'src/core', name + '.ts')).href);
  const { ensureState, focus, dwell, sketch, resolveSeeds, evictState } = await load('ops');
  const { revealFoveated } = await load('render');
  const { resetSessions } = await load('session');
  const { cachePathFor } = await load('build');
  const sourceHash = createHash('sha256');
  for (const name of (await readdir(join(engine, 'src/core'))).filter(name => name.endsWith('.ts')).sort()) {
    sourceHash.update(name).update(await readFile(join(engine, 'src/core', name)));
  }
  // Isolate the runtime optimization from pre-existing cold capture-order
  // variability. Both versions consume the same real, content-hash-checked facts.
  await copyFile(join(sharedCache, basename(cachePathFor(root))), cachePathFor(root));
  const start = performance.now();
  const state = await ensureState(root);
  const cachedBuildMs = performance.now() - start;
  const graphHash = digest(JSON.stringify([state.graph.nodes, state.graph.edges, state.graph.files, state.graph.importCoverage]));
  const refresh = await measure(() => ensureState(root));
  const matching = await measure(() => resolveSeeds(state, query));
  let last;
  const freshFocus = await measure(async () => { last = await focus(root, query, 512, { fresh: true }); assert(last.tokens <= 512); });
  const focusArtifact = last.details.overflowPath;
  const focusArtifactBytes = focusArtifact ? (await stat(focusArtifact)).size : 0;
  const preparedFocus = await measure(() => focus(root, query, 512, { fresh: true }, state));
  const field = new Float64Array(state.graph.nodes.length).fill(1);
  const options = { header: 'uniform-field performance stress', budget: 16000, overflowTo: join(tmpdir(), 'uniform.txt') };
  const uniformRender = await measure(() => revealFoveated(state.graph, field, options));
  const fieldRender = revealFoveated(state.graph, field, options);
  assert.equal(fieldRender.litTotal, state.graph.nodes.length);
  const uniformBody = fieldRender.overflowPath ? await readFile(fieldRender.overflowPath, 'utf8') : fieldRender.text;
  const parity = [];
  const snapshot = async result => {
    assert.equal(result.tokens, Math.ceil(result.text.length / 4));
    assert(result.tokens <= 512);
    const artifact = result.details.overflowPath;
    const normalized = JSON.parse(JSON.stringify(result).replaceAll(tmpdir(), '$CACHE'));
    delete normalized.details.version; delete normalized.details.generation;
    parity.push({ result: normalized,
      artifactHash: artifact ? digest(await readFile(artifact)) : null });
  };
  resetSessions();
  const symbol = state.graph.nodes.find(node => node.kind !== 'file' && node.kind !== 'anchor')?.name;
  for (const target of [query, ...(symbol ? [symbol, 'z' + symbol.slice(1)] : []), 'loadUsr']) {
    await snapshot(await focus(root, target, 512, { fresh: true }, state));
  }
  await snapshot(await focus(root, query, 512, { fresh: true, path: query }, state));
  await snapshot(await focus(root, query, 512, { fresh: true }, state));
  for (let i = 0; i < 5; i++) await snapshot(await dwell(root, 2, 512));
  await snapshot(await focus(root, query, 512, {}, state));
  await snapshot(await sketch(root, 512));
  const result = { engineFingerprint: sourceHash.digest('hex'), runtime: { host: process.versions.bun ? 'bun' : 'node', bun: process.versions.bun, nodeCompatibility: process.version },
    files: state.graph.files.length, nodes: state.graph.nodes.length, query, graphHash, cachedBuildMs,
    refresh, matching, freshFocus, preparedFocus, uniformRender, uniformHash: digest(uniformBody),
    uniformArtifactBytes: fieldRender.overflowPath ? (await stat(fieldRender.overflowPath)).size : 0,
    focusArtifactBytes, parity };
  evictState(root);
  console.log(JSON.stringify(result));
} else {
  const [workArg, beforeArg, afterArg, roundsArg = '3'] = process.argv.slice(2);
  if (!workArg || !beforeArg || !afterArg) throw Error('Usage: bun run corpus:performance <coverage-work> <before-source> <after-source> [rounds]');
  const work = resolve(workArg), before = resolve(beforeArg), after = resolve(afterArg);
  const rounds = Number(roundsArg);
  assert(Number.isInteger(rounds) && rounds >= 2 && rounds <= 10);
  const output = await mkdtemp('/tmp/fovea-performance.');
  console.log(`Measurements: ${output}`);
  const pins = JSON.parse(await readFile(join(work, 'pins.json'), 'utf8'));
  const run = promisify(execFile), rows = [];
  for (const repo of ['prettier/prettier', 'encode/starlette', 'vuejs/core', 'sveltejs/svelte']) {
    const pin = pins.successes.find(pin => pin.repo === repo);
    assert(pin, `Missing pin: ${repo}`);
    const root = join(work, 'repos', pin.id, pin.scope);
    assert.equal((await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), pin.sha, `${repo}: checkout moved from its pin`);
    assert.equal((await run('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', '.'])).stdout, '', `${repo}: selected checkout is dirty`);
    const measured = JSON.parse(await readFile(join(work, 'results', pin.id + '-baseline.json'), 'utf8'));
    const queries = measured.probes.filter(probe => !probe.name.startsWith('uniform-field')).sort((a, b) => b.eligible - a.eligible);
    const query = repo === 'vuejs/core' ? 'scripts/utils.js' : queries[0].name;
    const indexSource = (await run('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim();
    for (let round = 0; round < rounds; round++) {
      const pair = {};
      for (const label of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
        const cache = join(output, pin.id, String(round), label === 'before' ? 'A' : 'B');
        await mkdir(cache, { recursive: true });
        const index = join(cache, 'git-index');
        await copyFile(indexSource, index);
        const env = { ...process.env, TMPDIR: cache, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '1',
          FOVEA_MAX_FILES: '8000', FOVEA_MAX_FILE_BYTES: '1048576', FOVEA_SPAWN_CONCURRENCY: '2',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
        // Native Git caches must not leak from an optimized run into its baseline.
        await run('git', ['-C', root, 'update-index', '--no-untracked-cache'], { env });
        const { stdout } = await run(process.execPath, [fileURLToPath(import.meta.url), 'worker', label === 'before' ? before : after, root, query, join(work, 'cache', pin.id + '-candidate')], {
          env, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
        });
        pair[label] = JSON.parse(stdout);
        rows.push({ repo, sha: pin.sha, round, label, ...pair[label] });
        await writeFile(join(output, 'raw.json'), JSON.stringify(rows, null, 2));
      }
      assert.equal(pair.before.graphHash, pair.after.graphHash, `${repo}: cached graph changed`);
      assert.equal(pair.before.uniformHash, pair.after.uniformHash, `${repo}: overflow content changed`);
      assert.deepEqual(pair.before.parity, pair.after.parity, `${repo}: focus/dwell/sketch output changed`);
    }
  }
  for (const label of ['before', 'after']) {
    assert.equal(new Set(rows.filter(row => row.label === label).map(row => row.engineFingerprint)).size, 1, 'Source changed during measurement');
  }
  const summary = [...new Set(rows.map(row => row.repo))].map(repo => {
    const value = { repo };
    for (const label of ['before', 'after']) {
      const data = rows.filter(row => row.repo === repo && row.label === label);
      value[label] = { cachedBuildMs: distribution(data.map(row => row.cachedBuildMs)).medianMs };
      for (const phase of ['refresh', 'matching', 'freshFocus', 'preparedFocus', 'uniformRender']) {
        const combined = distribution(data.flatMap(row => row[phase].samples));
        value[label][phase] = { medianMs: +combined.medianMs.toFixed(2), p95Ms: +combined.p95Ms.toFixed(2) };
      }
    }
    return value;
  });
  const report = { method: 'Sequential alternating AB/BA; isolated fresh processes, Fovea caches, and Git indexes; 3 warmups + 15 samples per phase per round. Warm-query benchmark only: all workers load a common production extraction snapshot. Independent cold extraction can choose different literal-join occurrences because of capture ordering; cold speedups are not claimed. Cached state construction and query timings retain exact graph and output parity. OS caches and external load are uncontrolled. Byte/structured-output parity (excluding opaque generation IDs and cache paths) is gated, timings are not.', rounds, summary,
    fingerprints: { before: rows.find(row => row.label === 'before').engineFingerprint, after: rows.find(row => row.label === 'after').engineFingerprint },
    runtime: rows[0].runtime, sourceRows: join(output, 'raw.json') };
  await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: join(output, 'summary.json'), ...report }, null, 2));
}
