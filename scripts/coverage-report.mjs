import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

const [directory, candidateArg = '.', outputArg = 'docs/coverage-corpus.md'] = process.argv.slice(2);
if (!directory) throw Error('Usage: bun scripts/coverage-report.mjs <work-dir> <candidate-source> [report.md]');
const work = resolve(directory), candidate = resolve(candidateArg), output = resolve(outputArg);
const pins = JSON.parse(await readFile(join(work, 'pins.json'), 'utf8'));
const runs = JSON.parse(await readFile(join(work, 'runs.json'), 'utf8'));
const baselineCommit = (await readFile(join(work, 'baseline-commit.txt'), 'utf8')).trim();
const fingerprint = async root => {
  const hash = createHash('sha256');
  for (const file of ['types', 'extract', 'graph', 'render', 'ops', 'build', 'heat', 'state']) hash.update(file).update(await readFile(join(root, 'src/core', file + '.ts')));
  return hash.digest('hex');
};
const baselineFingerprint = await fingerprint(join(work, 'baseline'));
const candidateFingerprint = await fingerprint(candidate);
const rows = [], failures = [...pins.failures];
const total = { selected: 0, nodes: 0, missingFiles: 0, baselineLostCandidates: 0, candidateLostCandidates: 0,
  baselineNaturalLost: 0, candidateNaturalLost: 0, probes: 0, exactImportsLost: 0, exactImportsAdded: 0,
  oracleFamilies: 0, oracleTargets: 0, baselineTargetsCovered: 0, candidateTargetsCovered: 0, possibleEdges: 0,
  unsupportedFiles: 0, excludedEntries: 0, omittedSupported: 0, partialExtractions: 0, generatedFiles: 0, oversizedFiles: 0 };
for (const record of runs.outcomes) {
  if (!record.baseline.ok || !record.candidate.ok) { failures.push(record); continue; }
  const before = JSON.parse(await readFile(record.baseline.output, 'utf8'));
  const after = JSON.parse(await readFile(record.candidate.output, 'utf8'));
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  require(before.engineFingerprint === baselineFingerprint && after.engineFingerprint === candidateFingerprint, 'source fingerprint mismatch');
  const pin = pins.successes.find(pin => pin.repo === record.repo);
  require(pin?.sha === record.sha && pin?.scope === record.scope, 'evaluation does not match acquisition pin');
  require(JSON.stringify(before.selectedFiles) === JSON.stringify(after.selectedFiles), 'selection changed');
  require(!after.missingFiles.length && after.represented === after.selected, 'selected files missing from graph');
  const counts = edges => {
    const values = new Map();
    for (const edge of edges) values.set(edge, (values.get(edge) ?? 0) + 1);
    return values;
  };
  const priorEdges = counts(before.exactImports), nextEdges = counts(after.exactImports);
  const difference = (left, right) => [...left].flatMap(([edge, count]) => Array(Math.max(0, count - (right.get(edge) ?? 0))).fill(edge));
  const lostEdges = difference(priorEdges, nextEdges);
  const addedEdges = difference(nextEdges, priorEdges);
  require(!lostEdges.length, `${lostEdges.length} existing exact imports lost`);
  const coverage = after.importCoverage;
  require(coverage && coverage.sites === after.capturedImports && coverage.sites === coverage.resolved + coverage.possible + coverage.unresolved, 'import diagnostics do not account for every captured site');
  require(coverage && coverage.capped <= coverage.unresolved && coverage.examples.length <= 20 &&
    coverage.examples.length + coverage.examplesOmitted === coverage.possible + coverage.unresolved, 'import diagnostic limits are inconsistent');
  for (const probe of after.probes) {
    require(probe.eligible === probe.reported && probe.missing === 0 && probe.extra === 0, `candidate loss in ${probe.name} at B=${probe.budget}`);
    require(probe.tokens <= probe.budget && probe.actualTokens <= probe.budget && probe.tokens === probe.actualTokens, `budget violation in ${probe.name}`);
  }
  const familyKey = family => JSON.stringify([family.file, family.line, family.expression, family.targets]);
  require(JSON.stringify(before.families.map(familyKey)) === JSON.stringify(after.families.map(familyKey)), 'independent oracle population changed');
  const targets = after.families.reduce((sum, family) => sum + family.targets.length, 0);
  const beforeCovered = before.families.reduce((sum, family) => sum + family.covered.length, 0);
  const afterCovered = after.families.reduce((sum, family) => sum + family.covered.length, 0);
  require(targets === afterCovered, `${targets - afterCovered} bounded-oracle targets unconnected`);
  const loss = result => result.probes.reduce((sum, probe) => sum + probe.missing, 0);
  const naturalLoss = result => result.probes.filter(probe => !probe.name.startsWith('uniform-field')).reduce((sum, probe) => sum + probe.missing, 0);
  const row = { repo: record.repo, sha: record.sha, ecosystem: record.ecosystem, scope: record.scope, selected: after.selected,
    nodes: after.nodes, missingFiles: after.missingFiles.length, unsupported: after.discovery.unsupportedFilesSeen,
    excluded: after.discovery.excludedEntriesSeen, cappedFiles: after.discovery.omittedSupported,
    baselineLost: loss(before), candidateLost: loss(after), baselineNaturalLost: naturalLoss(before), candidateNaturalLost: naturalLoss(after),
    probes: after.probes.length, oracleFamilies: after.families.length, oracleTargets: targets, beforeCovered, afterCovered,
    possibleEdges: after.possibleEdges, exactImportsLost: lostEdges, exactImportsAdded: addedEdges.length,
    importCoverage: coverage, oracleFiles: after.oracleFiles, oracleParseFailures: after.oracleParseFailures,
    familySources: after.families.map(family => ({ file: family.file, line: family.line, expression: family.expression })),
    uncoveredFamilies: after.families.filter(family => family.covered.length !== family.targets.length), errors };
  rows.push(row);
  total.selected += after.selected; total.nodes += after.nodes; total.missingFiles += row.missingFiles;
  total.baselineLostCandidates += row.baselineLost; total.candidateLostCandidates += row.candidateLost;
  total.baselineNaturalLost += row.baselineNaturalLost; total.candidateNaturalLost += row.candidateNaturalLost;
  total.probes += row.probes; total.exactImportsLost += lostEdges.length; total.exactImportsAdded += addedEdges.length;
  total.oracleFamilies += row.oracleFamilies; total.oracleTargets += targets;
  total.baselineTargetsCovered += beforeCovered; total.candidateTargetsCovered += afterCovered;
  total.possibleEdges += row.possibleEdges; total.unsupportedFiles += row.unsupported; total.excludedEntries += row.excluded;
  total.omittedSupported += row.cappedFiles ?? 0;
  total.partialExtractions += after.extraction.failed.length; total.generatedFiles += after.extraction.generated.length; total.oversizedFiles += after.extraction.oversized.length;
}
const complete = runs.outcomes.length === pins.successes.length && new Set(runs.outcomes.map(record => record.repo)).size === pins.successes.length && new Set(pins.successes.map(pin => pin.repo)).size === pins.successes.length;
const passed = complete && rows.length >= 31 && !failures.length && rows.every(row => !row.errors.length);
const summary = { evaluatedAt: new Date().toISOString(), selection: pins.selection, baselineCommit, baselineFingerprint, candidateFingerprint,
  acquired: pins.successes.length, paired: rows.length, complete, passed, total, failures, rows };
await mkdir('docs/evaluations', { recursive: true });
await writeFile('docs/evaluations/coverage-summary.json', JSON.stringify(summary, null, 2) + '\n');
const table = rows.map(row => `| [${row.repo}](https://github.com/${row.repo}/tree/${row.sha}) | ${row.ecosystem} | ${row.selected} / ${row.unsupported} | ${row.baselineNaturalLost} → ${row.candidateNaturalLost} | ${row.beforeCovered} → ${row.afterCovered} / ${row.oracleTargets} | ${row.errors.length ? 'FAIL' : 'pass'} |`).join('\n');
const markdown = `# Coverage boundary corpus\n\n` +
  `Status: **${passed ? 'PASS' : 'NOT GREEN'}**. ${rows.length}/${pins.successes.length} repositories have paired results.\n\n` +
  `Baseline: \`${baselineCommit}\`. Candidate evaluated-core fingerprint: \`${candidateFingerprint}\`.\n\n` +
  `## Method\n\n${pins.selection}\n\n` +
  `Each repository is pinned in \`scripts/coverage-manifest.json\`. Both engines inspect the same depth-one checkout, with isolated cold caches, an 8,000-file graph cap, and a 1 MiB ordinary source cap. No useful co-change history is available in this experiment. Repository build scripts, tests, dependencies, and application code are never executed. Timings are diagnostic only, not a controlled performance comparison.\n\n` +
  `Inventory checks compare selected paths with actual file nodes. Selected means after declared root, file-type, exclusion, and cap policies—not every tracked file. Extraction failures and unsupported languages are limitations, not proof of semantic coverage.\n\n` +
  `Disclosure probes use real repository graphs: one uniform-field stress probe at B=16,000, plus t=2 diffused file seeds at B=256 and 1,024. Seeds are the first/middle/last selected source paths and the first bounded-family source when available. An independent eligibility calculation checks candidate counts; every candidate must be individually returned or present in the overflow artifact. Counts below are candidate occurrences across probes, not unique source files. Artifact hashes are retained in raw results; temporary artifact bodies are removed to bound disk usage.\n\n` +
  `A separate TypeScript AST walk supplies candidate-family expectations for the supported JS/TS one-hole relative-import grammar. Files with extraction failures/skips or TypeScript parse diagnostics are excluded from this oracle, and their counts are recorded. Family targets come from the selected file set, with runtime-extension aliases and the documented 32-target/4,096-file scan limits. This checks bounded possible-target recovery—not actual runtime dependencies, arbitrary dynamic expressions, model task success, or business requirements. Existing exact import edges must not disappear.\n\n` +
  `## Results\n\n` +
  `- Selected files represented: ${total.selected - total.missingFiles}/${total.selected}.\n` +
  `- Evaluated graph nodes: ${total.nodes}; disclosure probes: ${total.probes}.\n` +
  `- Missing recoverable candidate occurrences: ${total.baselineLostCandidates} → ${total.candidateLostCandidates}.\n` +
  `- Missing occurrences in diffused (non-uniform) probes: ${total.baselineNaturalLost} → ${total.candidateNaturalLost}.\n` +
  `- Bounded-family targets connected: ${total.baselineTargetsCovered} → ${total.candidateTargetsCovered}/${total.oracleTargets}, across ${total.oracleFamilies} observed ${total.oracleFamilies === 1 ? 'family' : 'families'}.\n` +
  `- Possible import edges emitted: ${total.possibleEdges}; exact imports added: ${total.exactImportsAdded}; existing exact imports lost: ${total.exactImportsLost}.\n` +
  `- Visible inventory limits: ${total.unsupportedFiles} unsupported files, ${total.excludedEntries} excluded entries, ${total.omittedSupported} supported files omitted at the cap.\n` +
  `- Visible extraction limits: ${total.partialExtractions} partial failures, ${total.generatedFiles} generated files, ${total.oversizedFiles} oversized files.\n\n` +
  `Bounded-family source repositories: ${rows.filter(row => row.oracleFamilies).map(row => row.repo).join(', ') || 'none'}. Source locations and expressions are retained in the machine-readable report. This is not broad empirical evidence for runtime plugin recovery; the executable regression fixture covers that separately. Additional cap and extraction-failure paths rely on targeted regression tests. Unsupported-file counts matter: a passing C#, Erlang, or Haskell repository row does not imply those languages' application source was modeled.\n\n` +
  `| Repository (pinned source) | Ecosystem | Selected / unsupported files | Lost diffused candidates before → after | Family targets before → after / expected | Gate |\n|---|---|---:|---:|---:|---|\n${table}\n\n` +
  `## Reproduction\n\n` +
  '```sh\n' +
  'WORK=$(mktemp -d /tmp/fovea-coverage.XXXXXX)\nmkdir "$WORK/baseline"\n' +
  `git archive ${baselineCommit} | tar -x -C "$WORK/baseline"\n` +
  'ln -s "$PWD/node_modules" "$WORK/baseline/node_modules"\n' +
  `printf '%s\\n' '${baselineCommit}' > "$WORK/baseline-commit.txt"\n` +
  'bun run corpus:coverage acquire "$WORK"\nbun run corpus:coverage run "$WORK" "$WORK/baseline" "$PWD"\nbun scripts/coverage-report.mjs "$WORK" "$PWD"\n```\n\n' +
  `Run from an unchanged checkout after installing this project's development dependencies. Raw pinned acquisition data and per-engine measurements remain under WORK. The compact machine-readable report is \`docs/evaluations/coverage-summary.json\` (git-ignored). Failed acquisitions and evaluations are retained rather than silently replaced.\n\n` +
  `## Interpretation\n\nThis evaluates an honest representation/disclosure boundary, not guaranteed feature completeness. File membership was already a construction property; the changes make more bounded relationships available to the same heat operator and prevent the display cap from silently dropping recoverable candidates. Unsupported or unbounded relationships remain explicit limitations. No second kernel, review memory, or workflow ledger is introduced.\n`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, markdown);
console.log(JSON.stringify({ paired: rows.length, complete, passed, total, failures: failures.map(item => ({ repo: item.repo, error: item.error ?? { baseline: item.baseline, candidate: item.candidate } })), errors: rows.filter(row => row.errors.length).map(row => ({ repo: row.repo, errors: row.errors, uncoveredFamilies: row.uncoveredFamilies, exactImportsLost: row.exactImportsLost })) }, null, 2));
if (!passed) process.exitCode = 1;
