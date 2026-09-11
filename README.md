<div align="center">

# 👁️ pi-fovea

**A foveated repo-mapping extension for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_See the whole repo on every prompt, sharp where you work and cheap everywhere else._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fovea/main/media/cover.svg" alt="pi-fovea: a code graph seen through a fovea, hot at the center and collapsed at the rim" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fovea?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fovea)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fovea/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fovea/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

pi-fovea gives the model a map of your repo on every prompt. The repo compiles
once into a cross-language graph of code. Symbols, files, and route anchors
share one network. Your question becomes an interest vector that diffuses
through the graph as heat. The renderer caps the field inside a token budget.
Near the question you get exact source locations and full signatures. One hop
out you get typed relationships. Past that the repo collapses to a skeleton.

When a session starts, Fovea records a baseline of the repo. If files
changed while Pi was idle, those changes enter context before the first model
call. Fovea checks the repo again after each assistant turn. Detection uses
file content hashes. An edit from a Pi tool, fabric_exec, bash, a subagent,
or an editor looks the same to Fovea. Edits that touch only comments or
formatting stay silent. A meaningful change arrives as a **steer**. When the
agent is about to stop, Fovea starts the next turn itself.

## Where fovea fits in shipping a feature

Shipping a feature in a large codebase costs time before the first edit.
First you find where the feature lives. Then the change needs a map of
everything it touches. Other branches keep landing while you work. Reviewers
want the blast radius. In long-lived enterprise repos, these steps cost more
time than the change itself. Fovea handles these steps. Each step becomes a
cheap call against the code graph. Tests, review gates, CI, and rollout keep
their own tools.

## When not to reach for fovea

Skip Fovea on small repos. A repo of a few dozen files reads faster than it
sketches. Fovea earns its cost when the working set outgrows the context
window. Cross-language monorepos hit that wall early. A long-lived codebase you
have never opened hits it too. Fovea narrows your reading to suggested windows.
Open those windows yourself, and keep the project's format, lint, typecheck,
and test commands in your loop. CI has the final say.

## What the model gets

| Command | Ask | Answer |
|---|---|---|
| `fovea_sketch` | where is everything? | production-first silhouette plus explicit discovery/extraction coverage; test and fixture architecture stays collapsed |
| `fovea_focus` | what is this? | exact symbols/routes/protocol ids, evidenced relationships, path-gap reasons, suggested reads, scopes, and deterministic `fresh` views |
| `fovea_dwell` | what else? | widens the current focus, or expires safely when its graph generation changed |
| `fovea_impact` | what does this touch? | hunk-precise seeds, evidenced review paths, unmet co-change companions, and a persistent obligation checklist |
| `grep` *(default hybrid)* | graph or text? | bare identifiers, qualified symbols, repo paths, and routes use Fovea; search options and obvious regex retain native grep |

Focus normalizes camelCase and common inflections. An approximate name such as
`switchServer` can still resolve `switchingServers`. A query with no certain
match returns the nearest symbols plus their locations. Direct graph edges
carry labels such as caller, callee, route, shared literal, and co-change, plus
deterministic `strategy` / `rule` / `source` evidence. Every tool result includes
a coverage ledger; an explicit missing path says whether it is unsupported,
ignored, oversized, generated, unreadable, Git-listed but unavailable, beyond
the file cap, behind a closed nested-repository boundary, or absent. Symbols
that merely share a file stay collapsed.

The **Hybrid grep** toggle is on by default. `grep({ pattern: "CreateUser" })`,
`grep({ pattern: "Controller.create" })`, and route paths travel through the
graph. Calls that carry text-search options or obvious regexes go to Pi's
native grep. A graph miss falls back to native text. A graph error, such as a
broken ast-grep, falls back the same way and adds a one-line note marking the
result as native. Turn the toggle off to recover a purely native grep. A toggle
change reloads extensions, so Pi and pi-fabric capture the same behavior.

### pi-fabric

Captured extension tools live under Fabric's `extensions` provider. Use the direct proxy when the action is known:

```ts
const result = await extensions.fovea_focus({ query: "CreateUserHandler", maxTokens: 512 });
return result.text;
```

For dynamic discovery, pass an object to `tools.search` and keep the returned namespaced ref:

```ts
const [action] = await tools.search({ query: "fovea_focus", limit: 5 });
if (!action) return "Fovea is not captured";
return tools.call({ ref: action.ref, args: { query: "CreateUserHandler" } });
```

The stable explicit ref is `extensions.fovea_focus`. The bare forms
`fovea_focus` and `fovea.fovea_focus` will miss.

Runtime slash controls:

- `/fovea status` for loaded versions, graph coverage, and active modes
- `/fovea settings` for a TUI configuration overlay
- `/fovea reset` for a fresh focus and sync baseline
- `/fovea reload` to activate updated extension source

## Install

Requires Node.js 20+. The install provisions [ast-grep](https://ast-grep.github.io/) automatically through the `@ast-grep/cli` npm optional dependency; an `ast-grep` found on PATH takes precedence over the packaged copy, and `FOVEA_AST_GREP=/path/to/sg` overrides both.

```sh
pi install npm:pi-fovea
```

<details>
<summary>Other install methods</summary>

From GitHub:

```sh
pi install git:github.com/monotykamary/pi-fovea
```

From a local checkout:

```sh
bun install
pi install /absolute/path/to/pi-fovea
```

</details>

There is also a package for any agent shell or CI:

```sh
fovea sketch /path/to/repo 900
fovea focus /path/to/repo "/v1/messages" 800
fovea impact /path/to/repo --base main 1200
fovea rules /path/to/repo
fovea status /path/to/repo
```

Install the CLI globally — the published bin is a single self-contained bundle, so it runs on plain Node.js (no tsx, no node_modules):

```sh
npm i -g pi-fovea      # or: bun add -g pi-fovea, bun add -g pi-fovea
```

From a checkout, `bun run fovea` runs the live source via `tsx`, and `bun run build:cli` rebuilds `dist/cli.mjs` (the `prepack` hook keeps the published bundle in sync).

## Large workspaces and startup

Indexing runs in the background at `session_start`. Your first prompt never
waits for ast-grep, hashing, or graph assembly. A cold sync hook reports the
progress. Later calls reuse the same shared build.

A non-Git umbrella directory treats each nested `.git` directory or worktree
marker as a closed project boundary — until you work in it. The first edit
hint (or observed drift) inside a nested clone enrolls it into the umbrella
graph from then on: progressive disclosure, one project at a time, persisted
with the fact cache so restarts restore your working set. The same rule covers
submodules and embedded checkouts in Git roots: their contents join the graph
as `<submodule>/<path>` the first time something inside changes — porcelain
reports inner drift collapsed to the boundary, which enrolls it automatically —
and a removed project un-enrolls without leaving orphan facts. Enrollment expands
index coverage only: with the default session-local sync scope, a sibling project
can join the umbrella graph and cache without steering conversations that never
entered it. Every fovea_* tool still accepts a `root` for a full, immediate map
of one project. `FOVEA_MAX_FILES` caps the merged listing either way.
Cold runs stay bounded through streamed JSONL cache I/O, 64-file extraction
batches, adaptive ast-grep chunk splitting, and a two-root resident LRU. The
limits accept environment overrides:

| Variable | Default | Meaning |
| --- | :---: | --- |
| `FOVEA_MAX_FILES` | `8000` | maximum indexed files in one graph |
| `FOVEA_MAX_FILE_BYTES` | `1048576` | maximum bytes extracted from one source file |
| `FOVEA_MAX_ROOTS` | `2` | observed execution roots and resident graph, fact, session, sync, and root-metadata caches |
| `FOVEA_SPAWN_CONCURRENCY` | `3` | concurrent ast-grep/git child processes (ast-grep parallelizes parsing inside each process; values above ~4 rarely help) |
| `FOVEA_MEMORY_HALF_LIFE_HOURS` | `48` | wall-clock half-life of the per-node sync memory (charged cascade warmth) |
| `FOVEA_IO_CONCURRENCY` | `32` | concurrent file stat/read operations |
| `FOVEA_MAX_SUBMODULE_DEPTH` | `4` | recursion cap for nested submodules |

Files over the size cap keep their place in the model's view of the repo.
Failed extractions do the same. You find both in `/fovea status` and in tool
details.

## Explicit project/worktree continuity (Rakazo)

The extension's existing four graph tools are the headless binding API; no new
host event or trust flag is required:

```ts
await extensions.fovea_focus({ root: "../project-b", query: "src/handler.ts", maxTokens: 1024 });
// Baseline is ready before this resolves (unless target sync is disabled).
// Native tools still use the host cwd: use absolute paths or cwd-relative paths.
await pi.edit({ path: "../project-b/src/handler.ts", old: "before", new: "after" });
await extensions.fovea_dwell({ maxTokens: 512 }); // last bound root
```

- `root` resolves against **the tool context's cwd**, not process cwd or the last
  binding. Real paths unify symlink aliases; linked Git worktrees remain distinct
  even when they share HEAD and a common Git directory. Roots are exact directory
  scopes, not automatically promoted to Git toplevels.
- Cwd is the startup/fallback observation target. After a graph call binds a root,
  hooks inspect only the bound set. Bind each project you want observed; an
  alternate binding does not keep an otherwise-unselected umbrella cwd active.
  Calls without `root` use the last binding. Parallel coordinators should always
  supply `root`; enrollment is serialized in invocation order. Results include
  canonical `details.root` and sorted `details.observedRoots`.
- A first binding establishes that target's semantic baseline before edits can
  follow. Subsequent focus calls do not consume pending drift. Before-prompt and
  post-turn sync compare every bound target, including hintless shell/Fabric/editor
  changes. Attention remains target-local: focus a file/symbol or use
  `fovea_impact({ root, files: ["src/file.ts"], includeUncommitted: false })` before
  a headless mutation to enter its scope. Ordinary path events never enroll a new
  root; they route to the most specific enrolled physical owner.
- Native read/edit/write/search paths **do not change cwd**. Augment-mode grep
  attaches only the graph of the enrolled owner of its actual cwd-relative or
  absolute search path. No-path native grep still searches cwd; it never appends
  an unrelated alternate graph. In legacy replace mode, bare graph queries and
  their miss fallback use the bound root; explicit native options retain cwd
  semantics. Each target's grep mode is checked independently.
- Binding is an explicit request to index a directory, **not a sandbox or a trust
  grant**. Rakazo must authorize tool arguments itself. `.pi/fovea.json` is loaded
  only when that exact canonical target equals `ctx.cwd` and the context is
  trusted. Parent/sibling trust never authorizes it; alternate targets use global
  defaults. To honor a target's project config, run it in its own trusted Pi
  context. Config cache keys include trust and agent directory. Existing
  target-local declarative `.fovea/rules.json` extraction rules are unchanged.
- All roots share one per-hook `sync.budget` allowance from the session cwd's
  effective config, divided evenly and capped again by each target's budget;
  root labels count toward that allowance. Hidden targets remain hidden (a mixed
  pre-prompt aggregate is hidden). Graph calls keep their individual `maxTokens`.
  Enrollment is capped by `FOVEA_MAX_ROOTS` (default 2); excess roots fail before
  indexing rather than silently losing a baseline. Set this before startup for
  larger coordinated runs.
- `/fovea status` reports the bound root and observed count. `/fovea reset`,
  shutdown, new/resume/fork/reload clear bindings and conversation baselines;
  reusable content facts remain cached. Rebind after session replacement.
  The standalone CLI remains stateless; these continuity semantics belong to
  the Pi extension lifecycle.

## Turn sync

Continuous sync is enabled and visible by default. Before an agent starts,
Fovea establishes its baseline or injects relevant drift ahead of the first
model call. After every assistant turn it compares symbols, calls, imports,
literals, and anchors again. Content hashes keep the unchanged fast path cheap.
Edits that touch only comments or formatting raise no signal.

The default `sync.scope` is `"session"`: path-bearing read/search/edit tools,
explicit focus/dwell results, and file-seeded impact calls add the top-level
logical directory (or exact root file) to that conversation's attention. Fovea
still indexes and baselines the whole root. Drift solely in sibling directories
is absorbed silently, so broad umbrella coverage does not become broad model
context. Set `sync.scope` to `"repository"` to restore root-wide steering.

A meaningful current, mixed, or unattributed change inside the attention scope
can still ship post-turn with `deliverAs: "steer"` and `triggerTurn`. A relevant
change attributed solely to another Fovea-enabled session is queued for the
next user prompt instead; it never restarts an idle agent. The compact update
names changed files, route deltas, and newly relevant files. Shell commands,
external editors, and agents without Fovea remain `unattributed` rather than
being guessed, while the path scope still keeps unrelated sibling sandboxes
quiet. Provenance journals accept either intercepted mutations or explicit trusted SHA-1 transitions, preserve supplied commit order, write one bounded replacement per event batch, expire after seven days, and live in
`$TMPDIR`; repository content remains the drift oracle. Updates list causal
channels such as calls, imports, shared literals, tests, or co-change history.
By default Fovea also embeds the refreshed focus context of the top drift target
(push). With `sync.pushFocus` off, the update ends with a suggested focus probe
for the next call (pull). Switching
branches re-baselines silently instead of steering: a `git checkout`
re-materializes the worktree, but the branch diff is not authored drift —
commits, pulls, and rebases still report. Clean turns stay silent. Enable `sync.ackClean` if you want an ack for those. Set `sync.mode` to
`"hidden"` to keep red sync context working behind the scenes without rendering it
in the transcript, or to `"disabled"` to turn continuous sync off.

Surprise is measured per graph node, not per file: a disclosed cascade
charges the symbols, literals, and anchors it warmed, and a later verdict
only counts mass exceeding that ledger. Re-editing the same spot re-seeds
the same charged nodes and stays silent — flip-flopped work cannot wake the
model twice, no matter how many times it flips within a session. A novel
hunk still fires, damped only by the charged nodes it overlaps. The ledger
cools by wall clock (48h half-life, `FOVEA_MEMORY_HALF_LIFE_HOURS`), so a
structurally re-heated neighborhood can earn a fresh verdict on a later
day. Anchor deltas follow the same evidence rule: a route add/remove
escalates only when its carrier file drifted, which makes transient
extraction artifacts quiet by construction.

Runtime controls:

- `/fovea status`: loaded package and ast-grep versions, indexed coverage, anchor scopes, sync mode/attention scope, and grep mode
- `/fovea reset`: clear focus disclosure and depth, then establish a fresh sync baseline
- `/fovea reload`: hot-reload extensions and activate newly installed source; sync baselines (the verdict ledger) ride through on a global slot, so a reload no longer replays charged cascades as first disclosures
- `/fovea settings`: configure sync, budgets, and hybrid grep

Choose enabled, hidden, or disabled per repo or globally through settings. The
environment override still turns sync off with:

```sh
FOVEA_TURN_SYNC=off pi
```

## Salience and obligations

`fovea_impact` keeps two clocks on the same graph.

Heat finds what matters now. Seeds come from the diff. Hunk parsing maps each
change to the symbols that contain it. One unit of mass goes to each changed
file: `0.2` on the file node, `0.8` over the touched symbols in proportion to
`sqrt(changed lines)`. Heat then spreads along static edges and along co-change
partners, and decays with wall-clock time. Edits that resist symbol-level
location fall back to the old file-node seed. New files, deletions, renames,
untracked paths, and oversized diffs all take that path.

Historical co-change is a decaying **heat prior**, never a permanent graph edge.
It counts up to 400 first-parent integration boundaries: merge net changes count
once, not again through their constituent commits. Explicit `fixup!`/`squash!`
followups join only uniquely resolved older subjects in that window. Time,
author, shared issue numbers, and unlabeled "forgot this" do not group work.
Boundaries are not proof of a semantic feature (release merges can mix work).
Aggregates above 24 tracked files emit no pairs but retain directional touch
counts; two distinct retained units are needed for a pair, three for expectations.
Raw history caching includes shallow-state identity; recency still applies at use.
Focus, sketch, and the structural diffusion operator remain unchanged.

The obligation ledger keeps the list. Every cascade merges its per-file
residual mass into a session epoch. Entries stay until evidence moves them. A
successful `read` marks `inspected`; a landed `edit` or `write` marks
`changed` and raises the generation, so a touched entry reopens until a later
read inspects that generation. A reset clears the epoch. Wall-clock time
touches nothing here, and disclosure removes nothing. A model that saw a file
still owes the work the ledger records.

The epoch follows the change. `fovea_impact` opens one on the first cascade and
reuses it while the incoming seeds still share a file with it, so an
uncommitted diff that keeps growing never loses its checklist. A diff that
shares no seed with the active epoch is a different change, so the ledger
rotates: the replacement starts empty and details report `epoch.rotated` with
the `previous` totals, which keeps the discarded residual visible instead of
dropping it silently. `markVerified` stays exported for callers that own a real
verification signal; nothing here invents one.

Impact details carry three separate signals:

- `expectedButUnchanged`: files with strong directional co-change history that
stayed out of this diff. A Wilson lower bound drives the score, with lift,
support, and recency gates. Treat it as the alarm for the serializer nobody
edited.
- `conservedMass`: the same cascade under degree-corrected random-walk heat.
Total mass stays fixed per connected component, so file masses compare across
repos of different sizes. Sync gates stay on the older raw scale.
- `obligations` and `epoch`: the strongest unresolved entries with their
reasons and generations, plus epoch totals. A cascade that rotates the ledger
adds `epoch.rotated` and `epoch.previous`.

A model reads rendered text, not tool details, so `fovea_impact` also renders
the convergence count as a one-line trailer — `obligations · 9 of 9 unresolved ·
web/api.ts, server/main.go, openapi.yaml, …` — and drops it entirely once every
entry is closed. Reads close entries, so the number only falls as work actually
lands. The trailer is advisory: it never pushes a result past the budget it was
called with.

`docs/heat-diffusion.md` has the full mechanics.

## Configuration

Global settings live in `~/.pi/agent/fovea.json`. A trusted repo-level override
sits in `<repo>/.pi/fovea.json`. These are the same two scopes pi-fabric uses
with `fabric.json`. In `/fovea settings`, the configured external-editor key
(`Ctrl+G` by default) switches both the displayed values and save destination
between project overrides and global defaults. A project override can remain
effective while its global default is being edited.

| Key | Default | Meaning |
| --- | :-----: | ------- |
| `sync.mode` | `"enabled"` | `"enabled"` shows model-visible sync messages, `"hidden"` keeps them model-visible but out of the transcript, and `"disabled"` turns sync off. Legacy `sync.enabled` booleans still parse. |
| `sync.scope` | `"session"` | `"session"` steers only for top-level directories/root files this conversation entered while indexing the whole root; `"repository"` restores root-wide steering. |
| `sync.budget` | `512` | token cap for proactive steering context |
| `sync.ackClean` | `false` | toast after clean structural turns |
| `sync.steerThreshold` | `0.15` | total surprise (channel-weighted heat above the session sync memory) that justifies proactive model steering |
| `sync.pushFocus` | `true` | embed a budgeted focus preview of the top drift target in red syncs |
| `tools.defaultBudget` | `512` | fallback maxTokens for the fovea_* tools |
| `tools.grepMode` | `"augment"` | `"augment"\u0020keeps native grep and appends a Fovea graph section to symbol-query results (works with `pi.grep` inside fabric_exec too); `"replace"` keeps the legacy takeover where bare symbol queries navigate the graph instead of returning lines; `"off"` is native grep only. The legacy boolean `tools.replaceGrep` still parses (`true`\u2192`"replace"`, `false`\u2192`"off"`) and loses to an explicit `grepMode`. |
| `tools.grepAugmentBudget` | `512` | token cap for the appended graph section |

Budgets cap the rendered view, not the map: whenever sketch, focus, dwell, or
impact truncate results for budget, the full list spills to
`$TMPDIR/pi-fovea-<op>-<hash>.txt` and the footer names the path — read or grep
the file for the remainder. `fovea_dwell` remains the semantic widen.

## How routes are found

Route anchors come from five port shapes. Together they cover most of the
ecosystem:

| Port shape | Examples |
|---|---|
| `recv.verb("path", handlers…)` | express, koa, fastify, hono, gin, echo, chi, net/http |
| annotation + optional class prefix | NestJS `@Controller + @Get`, Flask and FastAPI decorators, Spring `@RequestMapping + @GetMapping` |
| verb embedded in the path | Go 1.22 `mux.HandleFunc("GET /x", h)` |
| verb as first string argument | chi `r.Method("GET", path, h)`, aiohttp `router.add_route("GET", path, h)` |
| receiver-less DSL macros | Rails `routes.rb`, Phoenix `router.ex`, Django `path()`, Ktor `routing { get("/x") {} }` |

File-convention routers keep their paths in the file tree. Next.js App Router,
Pages Router, SvelteKit, Nuxt, and Astro work this way. Fovea derives their
anchors from file paths. The verb comes from exported handler names or filename
suffixes.

### Discovery mode

A repo may write routes in a shape fovea has never seen. The literal pass
harvests every call shape in it. Shapes with solid statistics get promoted into
implicit rules. A discovered anchor carries half the conductance of a declared
one and shows a `△` sigil. Turn sync reports the churn. An unconfirmed
hypothesis cannot turn the verdict red. Once a known rule matches any site of a
hub, that hub upgrades to first-class.

```sh
fovea anchors <root> --discovered   # the △ hypothesis hubs only
fovea rules <root>                  # promoted rules with evidence
fovea rules <root> --sigs           # every path-touching signature, by precision
fovea rules <root> --adopt          # persist promotions into .fovea/rules.json
```

`.fovea/rules.json` pins community or project rules in the repo:

```json
{
  "rules": [
    { "id": "fiber", "langs": ["Go"], "pattern": "$R.$M(\"$P\", $$H)", "methods": "^(get|post)$", "kind": "route" }
  ]
}
```

A rule may declare `prefixPattern`. A class-level prefix such as
`@Controller('api/airports')` then composes with per-method paths. A change to
the rules file invalidates the anchor extraction cache. The parsed facts above
the cache carry over.

### Non-HTTP protocol topology

Fovea parses protocol grammar locally and deterministically; it does not run a
language server, descriptor compiler, broker, or model. GraphQL documents emit
named operations, root fields, schema types/type references, and fragments.
Protocol Buffer documents emit package-qualified services, methods, messages,
and request/response/field references. Exact generated gRPC method paths join
back to their method and service. Declared tRPC and oRPC procedures join
router members, split-file route constants, and client calls. Hono routes
register through verb methods and `app.on`, and `hc()` RPC client calls join
the server-declared hub. Literal publish/subscribe calls join on their channel
while preserving the producer/consumer rule in edge evidence.

Router object members anchor at every position: the first matching slot is
captured exactly and the remaining members are enumerated from the sibling
capture, each at its own line. tRPC receivers must root at the `t` builder or
a `*Procedure` factory, oRPC at the `os` builder, so `trpc.post.list.query()`
client proxies and oRPC `oc.*` contract-only shapes stay unlinked rather
than guessing a nested name.

Validated against 36 open-source repositories (hono, trpc, unnoq/orpc,
documenso, cal.com, unkey, googleapis, protobuf, saleor, the published GitHub
schema, mqtt.js, nats, ably, and more): Hono yields 1.2k route anchors plus
72 RPC-client joins, documenso 214 tRPC procedures, the proto corpus 9.7k
anchors with zero keyword false-positives, and a 1.2 MB GitHub schema parses
through the raised protocol byte cap.

Canonical ids can be focused directly:


```text
RPC users.v1.Users/GetUser
RPC SERVICE users.v1.Users
RPC MESSAGE users.v1.User
GRAPHQL QUERY user
GRAPHQL TYPE User
TRPC loadUser
ORPC ping
CHANNEL users.changed
```

**Blind spots** are logged in `src/core/anchors.ts`. The remaining list covers
Rust proc-macro attributes (actix `#[get("/x")]`), constructor-assigned
prefixes (Flask Blueprint, FastAPI `APIRouter(prefix=…)`, chi `Mount`, Express
`Router` mounts, Hono `basePath`/`route` sub-apps), `scope` and `namespace`
nesting in Phoenix, Rails, or Django `include()`, router members behind
spreads or beyond the first twelve positions, `trpc.post.list.query()` client
proxies, oRPC dynamic clients, Hono `app.on` with non-standard verbs or path
arrays and `hc()` chains deeper than one segment, GraphQL embedded inside
host-language strings, generated gRPC clients with no literal method path,
and other computed protocol names. Ambiguous strings remain unlinked rather
than guessed.

### Coverage and completeness

File discovery records its source (`git` or bounded filesystem walk), recording
state (`complete`, `partial`, or `truncated`), supported/unsupported/excluded
counts, exact Git-listing cap omissions, closed nested repositories, unavailable
Git worktree entries, and unreadable traversal boundaries. Extraction separately
records partial failures, unreadable files, oversized files, and generated files.
Protocol documents (`.proto`, `.graphql`, `.gql`) use their own larger byte cap
(`FOVEA_MAX_PROTO_FILE_BYTES`, 8 MB default) because their exact readers never
reach ast-grep; a real-world schema larger than the code cap still parses.
Lists in tool details are bounded examples; the counters are not. A truncated
filesystem walk reports an unknown omission count instead of inventing one.
`/fovea status` and `fovea status` use this same ledger rather than comparing
unlike tracked and supported file counts.

## How it works

The repo compiles to a typed graph. Your question becomes a source vector $s$
over the nodes. The field the model receives is the heat kernel at time $t$
over the Laplacian $L$:

$$
v(t) = e^{-tL} \cdot s \quad \text{with} \quad L = I - D^{-1/2} W D^{-1/2}
$$

The four tools run one operator at four timescales. Sketch runs at $t=16$ with
production hubs and anchors as seeds. Focus drops to $t=2$, seeded by your
query. Dwell doubles $t$ inside the current focus. Impact takes changed files
as its seed. A change of focus resets the sharp timescale and the disclosure
scope.

A Chebyshev expansion evaluates the kernel. Rescale $M = L - I$ so the spectrum
sits in $[-1,1]$. With $T_k$ as the Chebyshev polynomials and $I_k$ as the
modified Bessel functions:

$$
e^{-tL} = e^{-t} \left[ I_0(t) T_0(M) + 2 \sum_{k\ge 1} (-1)^k I_k(t) T_k(M) \right]
$$

The vectors $T_k(M) s$ stay cached in the session. A new timescale reuses those
vectors and pays only for fresh coefficients. They are bound to a hash of the
ordered graph generation (node identities/signatures and weighted, evidenced
edges). A refresh that changes that generation clears focus/disclosure state;
`dwell` fails closed and asks for a new focus rather than applying stale node
indices. The graph walk happens once per generation.

Discovery measures how often the argument at one slot of a call shape carries a
route path. Shapes earn promotion past a Jeffreys-smoothed posterior:

$$
\hat{p} = \frac{\mathrm{pathN} + \frac{1}{2}}{\mathrm{n} + 1} \ge 0.55 \quad \text{with} \quad \mathrm{n} \ge 4 \text{ sites and} \ge 2 \text{ files}
$$

Tests on eight cloned projects put corpus junk below $\hat{p} \approx 0.27$.
Real route shapes land above $\hat{p} \approx 0.75$. The cutoff sits mid-cliff
at any repo size.

The method draws on spectral-graph wavelets evaluated by shared Chebyshev
recurrence. Progressive image coding contributes the budget-as-bitrate view
over significance-ordered coefficients. Foveated rendering supplies the sharp
center and the coarse rim. Aider's PageRank repo map is the fixed-timescale
special case of this field. [docs/heat-diffusion.md](docs/heat-diffusion.md)
walks through conductance tiers, specificity bridges, hub gravity, and inferred
regions.

## Languages

Full symbol and call extraction: **TypeScript, TSX, JavaScript, Python, Go, and Rust**.
Outline-based symbols: **Elixir, Ruby, C, C++, Java, Kotlin, Lua, PHP, Swift, Scala, Haskell, and Bash**.
Config joins through literals: **YAML, JSON, TOML, env, Markdown, and OpenAPI**.
Exact contract topology: **Protocol Buffers (`.proto`) and GraphQL (`.graphql`, `.gql`)**, joined to gRPC, tRPC, oRPC, Hono, and producer/consumer call sites.

## Development

```sh
bun install
bun run check        # typecheck + full vitest suite
bun run bench        # rate–distortion and refresh bench against ../pi-fabric
bun run bench tests/fixtures/mini  # self-contained smoke run
```

The developer benchmark gates timings on semantic equivalence: cold versus
cached builds, and forced refresh versus clean rebuild after unchanged,
location-only, semantic, added-file, and deleted-file scenarios in disposable
copies of the cross-language fixture. It checks facts, weighted edges and
evidence, coverage, operator contents, and fixture navigation; extraction-order
permutations and opaque rebuild hashes are not semantic differences. Runtime
ordering and generation invalidation are unchanged.

Reports include focus/dwell and refresh median/p95 samples, actual estimated
output tokens, and process peak RSS (including the validation work). Cold and
disk-warm target builds are single samples; three-sample refresh p95s are only
smoke diagnostics. The outline gets no more tokens than Fovea actually used.
`fidelity@16k` measures disclosed node IDs against a finite larger Fovea response,
**not independently labeled relevance**. Timing results are informational, never
a flaky CI gate; deterministic equivalence tests run in `bun run check`.
The bench clears the target's disposable facts cache to measure cold loading,
but edits only temporary fixture copies.

pi loads the extension straight from `src/` through jiti, so nothing needs
building. Per-repo JSONL caches live in `$TMPDIR`, guarded by per-file content
sha1 values and stat manifests. Cache I/O streams. Only dirty files re-run
ast-grep. Failed extractions keep fact-free hash markers that stay visible
across launches. Those files skip the retry on each start. Bump `CACHE_VERSION`
in `src/core/build.ts` whenever extractor semantics change.

## Acknowledgments

Thanks to [Alp](https://www.patreon.com/cw/alpderps), the original user whose request for a better LSP extension started this project.

[MIT](LICENSE).
