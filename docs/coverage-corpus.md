# Coverage boundary corpus

Status: **PASS**. 39/39 repositories have paired results.

Baseline: `0019b43de2bbbfd0fe2f6c58f23bafa7c2fbeb83`. Candidate evaluated-core fingerprint: `49d154f375cfea3bcfeec65a506c0023f1b672e8efe851760ed2405c13b41f56`.

## Method

Prespecified purposive sample, not statistically representative. Whole checkouts except Prettier's src scope. No repository scripts or dependencies are executed.

Each repository is pinned in `scripts/coverage-manifest.json`. Both engines inspect the same depth-one checkout, with isolated cold caches, an 8,000-file graph cap, and a 1 MiB ordinary source cap. No useful co-change history is available in this experiment. Repository build scripts, tests, dependencies, and application code are never executed. Timings are diagnostic only, not a controlled performance comparison.

Inventory checks compare selected paths with actual file nodes. Selected means after declared root, file-type, exclusion, and cap policies—not every tracked file. Extraction failures and unsupported languages are limitations, not proof of semantic coverage.

Disclosure probes use real repository graphs: one uniform-field stress probe at B=16,000, plus t=2 diffused file seeds at B=256 and 1,024. Seeds are the first/middle/last selected source paths and the first bounded-family source when available. An independent eligibility calculation checks candidate counts; every candidate must be individually returned or present in the overflow artifact. Counts below are candidate occurrences across probes, not unique source files. Artifact hashes are retained in raw results; temporary artifact bodies are removed to bound disk usage.

A separate TypeScript AST walk supplies candidate-family expectations for the supported JS/TS one-hole relative-import grammar. Files with extraction failures/skips or TypeScript parse diagnostics are excluded from this oracle, and their counts are recorded. Family targets come from the selected file set, with runtime-extension aliases and the documented 32-target/4,096-file scan limits. This checks bounded possible-target recovery—not actual runtime dependencies, arbitrary dynamic expressions, model task success, or business requirements. Existing exact import edges must not disappear.

## Results

- Selected files represented: 17768/17768.
- Evaluated graph nodes: 106086; disclosure probes: 275.
- Missing recoverable candidate occurrences: 95157 → 0.
- Missing occurrences in diffused (non-uniform) probes: 2158 → 0.
- Bounded-family targets connected: 0 → 15/15, across 1 observed family.
- Possible import edges emitted: 15; exact imports added: 624; existing exact imports lost: 0.
- Visible inventory limits: 10557 unsupported files, 113 excluded entries, 0 supported files omitted at the cap.
- Visible extraction limits: 0 partial failures, 23 generated files, 0 oversized files.

Bounded-family source repositories: vuejs/core. Source locations and expressions are retained in the machine-readable report. This is not broad empirical evidence for runtime plugin recovery; the executable regression fixture covers that separately. Additional cap and extraction-failure paths rely on targeted regression tests. Unsupported-file counts matter: a passing C#, Erlang, or Haskell repository row does not imply those languages' application source was modeled.

| Repository (pinned source) | Ecosystem | Selected / unsupported files | Lost diffused candidates before → after | Family targets before → after / expected | Gate |
|---|---|---:|---:|---:|---|
| [expressjs/express](https://github.com/expressjs/express/tree/53d4a0d606c0388f764f192b306ce0e90200e7e8) | JavaScript / Express | 152 / 61 | 0 → 0 | 0 → 0 / 0 | pass |
| [fastify/fastify](https://github.com/fastify/fastify/tree/d266f833f2bff34c6115c026e461b682e94d0b9c) | JavaScript / Fastify | 380 / 10 | 0 → 0 | 0 → 0 / 0 | pass |
| [honojs/hono](https://github.com/honojs/hono/tree/90e1b948467961718afd3ae34af9dee582b42248) | TypeScript / Hono | 444 / 32 | 0 → 0 | 0 → 0 / 0 | pass |
| [prettier/prettier](https://github.com/prettier/prettier/tree/968c1a62c8dce7f72a4fed477b2a5b260f5f31cf) | JavaScript / Prettier | 540 / 0 | 684 → 0 | 0 → 0 / 0 | pass |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest/tree/2ce29d5fa758046e5453bd92b8ed6c9da9709bb5) | TypeScript / Vitest | 2734 / 325 | 0 → 0 | 0 → 0 / 0 | pass |
| [unjs/h3](https://github.com/unjs/h3/tree/aa50e96a4a3da1732aa54542c498b37e0f8e3508) | TypeScript / H3 | 262 / 9 | 558 → 0 | 0 → 0 / 0 | pass |
| [sveltejs/svelte](https://github.com/sveltejs/svelte/tree/6eb720a1b7cafca3ebe0ab5c76674272cd3044f9) | JavaScript / Svelte | 4142 / 5005 | 0 → 0 | 0 → 0 / 0 | pass |
| [vuejs/core](https://github.com/vuejs/core/tree/54097087a0918b98f16c84599b1a6d654e952ca7) | TypeScript / Vue | 605 / 99 | 0 → 0 | 0 → 15 / 15 | pass |
| [pallets/flask](https://github.com/pallets/flask/tree/d73fa1cdcbd8b1465c151db8924ba58b1dd14e35) | Python / Flask | 106 / 129 | 0 → 0 | 0 → 0 / 0 | pass |
| [encode/starlette](https://github.com/encode/starlette/tree/76fd00f1e293990ea41555946a6b0f58901eaca1) | Python / Starlette | 126 / 21 | 916 → 0 | 0 → 0 / 0 | pass |
| [fastapi/fastapi](https://github.com/fastapi/fastapi/tree/50113da16fec53b66b80d75e80a89296de4fa5a5) | Python / FastAPI | 2882 / 256 | 0 → 0 | 0 → 0 / 0 | pass |
| [psf/requests](https://github.com/psf/requests/tree/dae7ef63b4df6eded86637f251fc4e3a06c3b479) | Python / Requests | 63 / 67 | 0 → 0 | 0 → 0 / 0 | pass |
| [gin-gonic/gin](https://github.com/gin-gonic/gin/tree/dcaa4296d111981ffb31ac3eba90bb63e1eb5ab9) | Go / Gin | 120 / 9 | 0 → 0 | 0 → 0 / 0 | pass |
| [go-chi/chi](https://github.com/go-chi/chi/tree/b1c9ab47626cc46b34393ad4d35779c4363c4e1e) | Go / Chi | 93 / 10 | 0 → 0 | 0 → 0 / 0 | pass |
| [spf13/cobra](https://github.com/spf13/cobra/tree/adbc8813901bba65827259daa8e22ff94ec1f30e) | Go / Cobra | 58 / 7 | 0 → 0 | 0 → 0 / 0 | pass |
| [tokio-rs/axum](https://github.com/tokio-rs/axum/tree/af1345b53a259b0990be1ff853f9b56c05040ef7) | Rust / Axum | 416 / 85 | 0 → 0 | 0 → 0 / 0 | pass |
| [serde-rs/serde](https://github.com/serde-rs/serde/tree/a874a1b1bb1cc16cf5ee3b1b7b527af5705742bb) | Rust / Serde | 229 / 132 | 0 → 0 | 0 → 0 / 0 | pass |
| [clap-rs/clap](https://github.com/clap-rs/clap/tree/48ed7869b91addcfb485decf2b445c74bef00535) | Rust / Clap | 439 / 191 | 0 → 0 | 0 → 0 / 0 | pass |
| [javalin/javalin](https://github.com/javalin/javalin/tree/219f8c14dd20fb626735295f45673fdc24a4ab6f) | Java / Javalin | 386 / 114 | 0 → 0 | 0 → 0 / 0 | pass |
| [google/gson](https://github.com/google/gson/tree/8b4b55051489132190cb8d1c61eb9dc7f5381295) | Java / Gson | 293 / 20 | 0 → 0 | 0 → 0 / 0 | pass |
| [square/okhttp](https://github.com/square/okhttp/tree/1402451779106b1e6d3e78f629e1dbfb79317f21) | Kotlin / OkHttp | 762 / 81 | 0 → 0 | 0 → 0 / 0 | pass |
| [sinatra/sinatra](https://github.com/sinatra/sinatra/tree/cb22afd7902b566b6eaba6c4ea89739494a65d12) | Ruby / Sinatra | 169 / 123 | 0 → 0 | 0 → 0 / 0 | pass |
| [rack/rack](https://github.com/rack/rack/tree/a9833c8f3bd6b6d1e0ab35de00a1f1a16b5095f5) | Ruby / Rack | 111 / 75 | 0 → 0 | 0 → 0 / 0 | pass |
| [slimphp/Slim](https://github.com/slimphp/Slim/tree/3675bf6baac66b07032575b7bef4200b60b7974b) | PHP / Slim | 138 / 7 | 0 → 0 | 0 → 0 / 0 | pass |
| [Seldaek/monolog](https://github.com/Seldaek/monolog/tree/2dc40e8f3b76a0b657e0a25c932dc6edef215891) | PHP / Monolog | 250 / 12 | 0 → 0 | 0 → 0 / 0 | pass |
| [libuv/libuv](https://github.com/libuv/libuv/tree/096a02d14cb9d3de6d55a29ec02c4dfcb7643c7f) | C / libuv | 392 / 91 | 0 → 0 | 0 → 0 / 0 | pass |
| [madler/zlib](https://github.com/madler/zlib/tree/e3dc0a85b7032e98380dec011bc8f2c2ee0d8fca) | C / zlib | 89 / 182 | 0 → 0 | 0 → 0 / 0 | pass |
| [fmtlib/fmt](https://github.com/fmtlib/fmt/tree/e5d13d826f4266de65d2463dc3bff4ff3d25221e) | C++ / fmt | 104 / 41 | 0 → 0 | 0 → 0 / 0 | pass |
| [gabime/spdlog](https://github.com/gabime/spdlog/tree/57cb5fb7a8ff30079751728234623230535a5c92) | C++ / spdlog | 160 / 25 | 0 → 0 | 0 → 0 / 0 | pass |
| [Alamofire/Alamofire](https://github.com/Alamofire/Alamofire/tree/bda9ed57d72988a3a2ada33d824583541f86eac6) | Swift / Alamofire | 151 / 419 | 0 → 0 | 0 → 0 / 0 | pass |
| [elixir-plug/plug](https://github.com/elixir-plug/plug/tree/73404f851852a00ffb2014be95d4598900fa77b8) | Elixir / Plug | 83 / 22 | 0 → 0 | 0 → 0 / 0 | pass |
| [lunarmodules/luafilesystem](https://github.com/lunarmodules/luafilesystem/tree/146ab458e821cd7617892099fe8e6e399b46185c) | Lua / LuaFileSystem | 7 / 15 | 0 → 0 | 0 → 0 / 0 | pass |
| [scalameta/munit](https://github.com/scalameta/munit/tree/12fd6db97f6e1dc790cdc6833a03103e1cf675c3) | Scala / MUnit | 256 / 18 | 0 → 0 | 0 → 0 / 0 | pass |
| [ninenines/cowboy](https://github.com/ninenines/cowboy/tree/79e3fb02b31d47af6e69e8f3ba18fba291a3072a) | Erlang / Cowboy | 4 / 420 | 0 → 0 | 0 → 0 / 0 | pass |
| [JuliaIO/JSON.jl](https://github.com/JuliaIO/JSON.jl/tree/766455e59847a1d17c18499eccc1bff0e9ce53ca) | Julia / JSON.jl | 16 / 24 | 0 → 0 | 0 → 0 / 0 | pass |
| [NancyFx/Nancy](https://github.com/NancyFx/Nancy/tree/e523defb12f5ea3ec7b7129ed2b4aaf70aebed2f) | C# / Nancy | 37 / 1310 | 0 → 0 | 0 → 0 / 0 | pass |
| [haskell/aeson](https://github.com/haskell/aeson/tree/a2cc6a782a9d94141f52fee38d7a569a4d9c5a68) | Haskell / Aeson | 498 / 706 | 0 → 0 | 0 → 0 / 0 | pass |
| [tidyverse/glue](https://github.com/tidyverse/glue/tree/da9c73f7a3de6a27f3103cb5bb2355820a4c3a6a) | R / glue | 32 / 66 | 0 → 0 | 0 → 0 / 0 | pass |
| [bats-core/bats-core](https://github.com/bats-core/bats-core/tree/c8cd3698ff6215169e48a0a80f05b43ed8701541) | Bash / Bats | 39 / 338 | 0 → 0 | 0 → 0 / 0 | pass |

## Reproduction

```sh
WORK=$(mktemp -d /tmp/fovea-coverage.XXXXXX)
mkdir "$WORK/baseline"
git archive 0019b43de2bbbfd0fe2f6c58f23bafa7c2fbeb83 | tar -x -C "$WORK/baseline"
ln -s "$PWD/node_modules" "$WORK/baseline/node_modules"
printf '%s\n' '0019b43de2bbbfd0fe2f6c58f23bafa7c2fbeb83' > "$WORK/baseline-commit.txt"
bun run corpus:coverage acquire "$WORK"
bun run corpus:coverage run "$WORK" "$WORK/baseline" "$PWD"
bun scripts/coverage-report.mjs "$WORK" "$PWD"
```

Run from an unchanged checkout after installing this project's development dependencies. Raw pinned acquisition data and per-engine measurements remain under WORK. The compact machine-readable report is `docs/evaluations/coverage-summary.json` (git-ignored). Failed acquisitions and evaluations are retained rather than silently replaced.

## Interpretation

This evaluates an honest representation/disclosure boundary, not guaranteed feature completeness. File membership was already a construction property; the changes make more bounded relationships available to the same heat operator and prevent the display cap from silently dropping recoverable candidates. Unsupported or unbounded relationships remain explicit limitations. No second kernel, review memory, or workflow ledger is introduced.
