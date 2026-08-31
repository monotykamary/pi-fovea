# AGENTS.md

## Golden rule: check when done

```sh
bun run check
```

Runs typecheck + the full vitest suite + `lint:dead` (knip gate for unused
files/exports, mirroring ../pi-fabric). There is **no build step**: pi loads
the extension from `src/` via jiti, so a green check means the change is live.

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
  runtime deps. `check` never touches `dist/` — dev stays buildless.
