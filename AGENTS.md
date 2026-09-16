# AGENTS.md

## Golden rule: check the change, not the suite

Finish a change with the change-scoped check:

```sh
bun run check:fast
```

Typecheck plus only the tests your working tree touches, seconds instead of the
55-second, 250-test suite. There is **no build step**: pi loads the extension
from `src/` via jiti, so green checks on the files you touched mean the change
is live.

## Checks are incremental, never a full sweep

Never run the whole suite as a gate. Verify the files a change touches:

```sh
bun run check:fast                             # typecheck + affected tests
bun run test:changed                           # dirty src/tests files vs HEAD
bun run test:affected                          # CI mode: $PI_TEST_BASE vs HEAD
bun run test:smoke                             # curated pipeline floor, seconds
bun run test:related -- src/core/build.ts      # tests importing given files
bunx vitest run tests/extract.test.ts          # one suite, by path
bun run typecheck                              # whole-program types, seconds
```

`scripts/test-affected.mjs` backs the first three. It feeds changed source
files to `vitest related`, runs changed `tests/**/*.test.ts` directly, and drops
deleted paths. That selection avoids the vitest `--changed` pitfall where a
dirty `package.json` forces the entire suite to run. An unreadable git state
fails loudly. Nothing falls back to the full suite, and there is no `bun run
check` or `bun run test` script: those aggregates are gone on purpose. When you
deliberately want everything, `bunx vitest run` is the whole suite.

CI selects by range: the workflow passes the pull-request base or the replaced
push tip as `PI_TEST_BASE` and compares it to `HEAD` as a three-dot diff. A
docs-only push selects nothing, and the curated `test:smoke` floor then carries
the signal. `bun run lint:dead` (knip) stays in CI because it costs under a
second. There is no cross-platform matrix: nothing in `src/` or `tests/` branches
on `process.platform`.

Publishing runs `prepack` (`bun run build:cli`), never the suite.

## Cache invalidation

Two caches live in \`$TMPDIR\`: per-file extraction facts (\`pi-fovea-*.json\`,
keyed by content sha1 + \`CACHE_VERSION\` + rules hash) and co-change pairs
(\`pi-fovea-cochange-*.json\`, keyed by HEAD + tracked-file set).

Facts (symbols/imports/calls/literals per file) are content-hash cached in
`$TMPDIR/pi-fovea-*.json`. If you change *extractor semantics* (what a parser
emits for unchanged file content), bump `CACHE_VERSION` in
`src/core/build.ts` or stale test facts linger.

## Conventions

- Vitest covers: diffusion core vs an independent scaled-Taylor reference
  (never compare Chebyshev to raw Taylor at large t — catastrophic
  cancellation; that's why the reference scales-and-squares), extractors and
  joins on `tests/fixtures/mini` (cross-language monorepo: Go server + TS
  client + OpenAPI + Python worker), budget conformance, delta contract.
- Budget assertions use `tokens <= B` exactly; the renderer's prefix-fit loop
  must stay monotonic in the candidate prefix.
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`.
- Keep runtime deps at `typebox` only (pi provides it at extension load);
  heavy deps belong in devDependencies.
- The published `fovea` bin is a bundle: `prepack` → `bun run build:cli`
  (esbuild → `dist/cli.mjs`), so `npm i -g pi-fovea` needs neither tsx nor
  runtime deps. `check:fast` never touches `dist/` — dev stays buildless.
