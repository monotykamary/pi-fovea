#!/usr/bin/env bun
// Transport replay only: production cochange.ts and git.ts are unmodified.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] !== '-C') throw Error('Unexpected git transport invocation');
const root = argv[1], args = argv.slice(2);
const data = JSON.parse(readFileSync(join(root, 'transport.json'), 'utf8'));
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])) process.stdout.write(data.head + '\n');
else if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--show-prefix'])) process.stdout.write('\n');
else if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--git-path', 'shallow'])) process.stdout.write('shallow\n');
else if (args[0] === 'log' && args.includes('--numstat')) {
  const expected = ['log', '--format=%x00%ct', '--numstat', '-n', '400', '--no-renames', '--diff-filter=AMR', '--', '.'];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw Error('Baseline Git contract changed');
  process.stdout.write(data.baseline);
} else if (args[0] === 'log' && args.includes('--first-parent')) {
  const expected = ['log', '--first-parent', '--diff-merges=first-parent', '--root', '--format=%x00FOVEA%x00%H%x00%P%x00%ct%x00%s%x00', '--name-status', '-z', '-n', '400', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-notes', '--no-show-signature', '--no-color', data.head, '--'];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw Error('Final Git contract changed; reacquire metadata');
  process.stdout.write(data.final);
} else throw Error(`Unsupported replay: ${JSON.stringify(args)}`);
