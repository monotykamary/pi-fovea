# Warm-path performance

The optimization keeps the coverage-complete graph, uncertainty labels, full overflow artifacts, and freshness checks. It changes three costs:

- Git: one fresh porcelain-v2 status carries HEAD and changes; native untracked-directory caching is requested at a verified worktree root without the redundant dot pathspec. Subroots stay scoped, root-marker changes invalidate stale prefixes, environment overrides stay conservative, and older/unexpected protocol output falls back. This can update Git index metadata but not configuration files. Set `FOVEA_GIT_UNTRACKED_CACHE=0` to opt out; environments preventing optional index writes may see less benefit.
- Matching: normalize the query once and reuse weakly cached symbol-name terms, checking names before reuse. This does not change match scores or ranking rules.
- Heat: sharp focus materializes 22 recurrence vectors rather than 81. Dwell appends missing orders without discarding its prefix; sketch also avoids unnecessary orders. The mathematical operator and recurrence are unchanged. The initial basis uses about 73% less vector storage; this is not a measurement of total process memory.

A renderer-tail deferral experiment was discarded because it showed no useful gain. Full overflow remains intentionally proportional to the eligible list; this is not a claim that every phase becomes faster.

## Method and limits

The four pinned repositories and selection policy come from `scripts/coverage-manifest.json`. These are local macOS arm64 measurements, not an SLA or a statistically representative sample. The before-version is the frozen, uncommitted coverage-complete snapshot—not the older version that dropped overflow candidates.

Bun uses three alternating-order rounds (45 measured samples per phase, repository, and version); Node uses two (30 samples). Each worker has a fresh process and isolated Fovea cache and Git index. Both engines load the same production extraction snapshot, preventing native Git cache leakage and holding graph input constant. Three warmups precede each timed phase. OS caches and other machine activity are uncontrolled. End-to-end fresh-focus timing includes a real freshness probe and a newly built focus basis, at a 512-token budget.

The benchmark requires identical ordered warm graphs including weights and evidence, exact focus/dwell/sketch text and structured details (excluding temporary paths and opaque generation IDs), and identical complete overflow content. It also checks actual token estimates and budgets. The numerical tests separately require exact eager-versus-demand-driven fields and recurrence prefixes.

Independent cold extraction exposed pre-existing capture-order variability, including different literal-join locations for repeated literals. The extractor/join implementation is unchanged here. Therefore these measurements deliberately concern the warm runtime path and make no cold-extraction speedup or reproducibility claim. Uniform-render timings and cached-state construction were not consistently better; retain the raw phase measurements rather than attributing every timing difference to the optimization.

`bun run check` passes 235 tests plus typecheck and knip. The optimized candidate also passes the 39-repository coverage gate: 17,768 selected files represented, 275 disclosure probes with zero candidate loss, and no existing exact imports lost. See [coverage-corpus.md](coverage-corpus.md).

## Reproduction

```sh
bun run corpus:performance COVERAGE_WORK BEFORE_SOURCE AFTER_SOURCE 3
NODE_OPTIONS='--import tsx' node scripts/performance-corpus.mjs COVERAGE_WORK BEFORE_SOURCE AFTER_SOURCE 2
```

Install development dependencies first and use unchanged source snapshots. `COVERAGE_WORK` is the acquired coverage corpus, including its original per-repository candidate extraction caches. The benchmark records core fingerprints, raw measurements, output snapshots, and summaries in a temporary directory; it refuses changed source fingerprints within a cohort or changed output. No repository application code is executed.

## Bun 1.4.2

| Repository | Median before → after (ms) | p95 before → after (ms) | Median speedup |
|---|---:|---:|---:|
| prettier/prettier | 87.47 → 37.66 | 121.99 → 65.25 | 2.32× |
| encode/starlette | 54.55 → 25.28 | 84.63 → 47.88 | 2.16× |
| vuejs/core | 95.10 → 33.64 | 140.16 → 57.45 | 2.83× |
| sveltejs/svelte | 464.51 → 77.44 | 603.48 → 111.25 | 6.00× |

## Node 26.5.0

| Repository | Median before → after (ms) | p95 before → after (ms) | Median speedup |
|---|---:|---:|---:|
| prettier/prettier | 127.38 → 61.28 | 172.67 → 85.44 | 2.08× |
| encode/starlette | 96.46 → 55.56 | 138.28 → 84.07 | 1.74× |
| vuejs/core | 153.19 → 65.62 | 245.66 → 101.25 | 2.33× |
| sveltejs/svelte | 488.68 → 100.43 | 713.07 → 151.74 | 4.87× |

## Provenance

Before core fingerprint: `0152ef975ccc047b791b594221300fc21a2f994d0d8f7797b0ad4a96026ebf02`. After core fingerprint: `fa4c7f6476fca475a9e027f8ee6e7a34801cce63534b53ab3dfd5c81a083f732`.

The measured before snapshot is retained locally at `/tmp/pi-fovea-coverage.BIh1lp/candidate`. Bun raw evidence is `/tmp/fovea-performance.a9fOJT/raw.json`; Node raw evidence is `/tmp/fovea-performance.e52j5o/raw.json`. A compact copy of both summaries is `docs/evaluations/performance-summary.json` (git-ignored). These temporary paths are local evidence, not durable release artifacts; reproducing this exact comparison requires the recorded before snapshot.

The independent optimized coverage recheck is retained at `/tmp/fovea-optimized-coverage.zCY3Pa`, reusing the unchanged original baseline results and all 39 pinned checkouts with fresh candidate caches.