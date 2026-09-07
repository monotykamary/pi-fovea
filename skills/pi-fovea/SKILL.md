---
name: pi-fovea
description: Token-efficient repo navigation with the pi-fovea code graph. Use when you need to survey an unfamiliar repository, trace where a symbol or route lives and what depends on it, assess the blast radius of a change before editing, or re-orient after files have been edited mid-session (by any tool path, including bash and pi-fabric fabric_exec programs).
---

# pi-fovea

pi-fovea maintains a cross-language code graph of the working repository — routes, symbols, imports, calls, string/env literals — and exposes it through progressive disclosure: cheap silhouettes first, detail only where you point it. It costs almost nothing until you ask, and it re-syncs automatically whenever file content drifts, no matter which tool made the edit.

## The loop

1. **`fovea_sketch`** — production-first silhouette. Shipped routes and source regions lead; test and fixture architecture is collapsed. Start here in an unfamiliar repo. ~256–1024 tokens.
2. **`fovea_focus` `<query>`** — point at a symbol name (close spellings work), route, env key, or file. The active seed and direct relationships always remain visible; previously seen periphery is suppressed only within that focus. A different focus resets to sharp context. Use `path`, `language`, or `kind` to scope output and `fresh: true` for a reproducible full view. Structured details include nodes and suggested read windows.
3. **`fovea_dwell`** — optional second look. If focus says more results remain, dwell widens only the current focus and returns newly relevant neighbors.
4. **`fovea_impact`**: blast radius. Seed with repo-relative `files`, symbols, uncommitted changes, or a PR `base`. Output is likely review order with causal channels (calls, imports, literals, routes, tests, inheritance, co-change). Structured details add `expectedButUnchanged` (co-coupled files missing from this diff), `conservedMass` (per-file heat that compares across repo sizes), and `obligations`/`epoch` (a checklist that survives disclosure and time). Check `obligations` before you call a feature done.

All four accept `maxTokens` (256–16000). Budget is roughly 4 chars per token.

## Working rules

- **Do not bulk-read to discover structure.** Focus first, then read its suggested ranges. Native grep semantics remain available whenever grep receives path/glob/literal/context/limit options or an obvious regex; unresolved graph queries fall back to native text.
- **Impact before destructive edits.** One `fovea_impact` call is cheaper than rediscovering dependents by breaking them.
- **Sketch is the safe opening bid.** If unsure, pay for a sketch; it almost never exceeds a few hundred tokens.
- **Skip the map when the repo is tiny.** A few dozen files are cheaper to bulk-read than to sketch; Fovea's value grows with repos larger than context. Either way it points at windows to read — the project's own format/lint/typecheck/test commands and CI remain the final verification layer.

## Multiple projects/worktrees

Use an explicit graph-tool `root` before editing an alternate authorized project.
Roots resolve relative to `ctx.cwd`; symlink aliases share identity, linked Git
worktrees do not. The first call establishes its sync baseline before returning.
Graph results expose `details.root` and `details.observedRoots`; omitted roots use
the last binding. Bind every target to observe; after binding, hooks stop using
an unselected umbrella cwd. Parallel calls should specify roots explicitly.

Native paths remain cwd-relative: use absolute paths or `../project/file` for
edits and grep. Augment grep follows its actual search path's enrolled owner,
not the active graph binding. Focus or file-seeded impact establishes attention
for headless shell edits; path events alone never enroll siblings. Alternate
roots do not inherit cwd project-config trust. Shared sync context and observed
roots are bounded (`FOVEA_MAX_ROOTS`, default 2; excess enrollment errors).
Reset/reload/session replacement clears bindings, not reusable extraction facts.
See README's “Explicit project/worktree continuity (Rakazo)” for the full contract.

## Turn sync

Before an agent starts, pi-fovea establishes its baseline or injects relevant out-of-band semantic drift into that run. After each assistant turn it compares again. The default `sync.scope: "session"` indexes the whole root but steers only for top-level directories/root files this conversation entered through path-bearing tools or focus. Sibling-directory drift advances the index and baseline silently. Current, mixed, and unattributed changes in scope may trigger a continuation; changes owned solely by another Fovea session wait for the next user prompt and cannot restart an idle agent. Comment- and formatting-only edits stay silent. Set `sync.scope: "repository"` only when root-wide steering is intentional.

Sync is **mutation-path agnostic**: pi's edit/write tools, a pi-fabric `fabric_exec` program's inner `pi.edit`, a bash heredoc, a subagent, or an editor save outside the session all register identically. Content hashes are the source of truth; tool events establish attention but are not the drift oracle. Successful edit/write events additionally record exact hash transitions so sync can label current-session, other-Fovea-session, and mixed provenance; uninstrumented mutation paths remain explicitly unattributed. In repos with no `.git` directory content drift is also the only change signal — do not fall back to `git status` assumptions.

## Using with pi-fabric (fabric_exec)

When writing or editing code **inside a `fabric_exec` program**, the fovea tools exist but the fabric sandbox has no built-in knowledge of them (it lazy-loads tools). Key points:

- Inside `fabric_exec`, captured extension tools use the `extensions` provider. For a known action call `await extensions.fovea_focus({ query: "CreateUserHandler", maxTokens: 6000 })`.
- For dynamic discovery, use `const hits = await tools.search({ query: "fovea_focus" })`, then call the returned namespaced ref with `tools.call({ ref: hits[0].ref, args: { query: "CreateUserHandler", maxTokens: 6000 } })`. The stable explicit ref is `extensions.fovea_focus`; bare `fovea_focus` and `fovea.fovea_focus` are invalid.
- Prefer a single `extensions.fovea_impact(...)` call over hand-rolled grep fan-outs when computing what an edit touches — the graph already resolved imports/calls across Go, TypeScript, Python, and Java.
- Any file mutation performed by the program (including `pi.edit`/`pi.write` calls inside the sandbox) is picked up by turn sync automatically, so post-edit verification does not need a re-sketch.
- Sketch `details` carries coverage counts; its compact text names the highest-value entry points. On an unfamiliar repo, fetch it once and reuse it instead of rediscovering entry points per call.

## CLI

The same engine runs headlessly as the `fovea` binary (repo root scan, plus JSON and TSV modes). Prefer the in-session tools unless you need scripting or a second opinion outside the extension's session state.

## Settings

Use `/fovea status` for loaded version and index coverage, `/fovea reset` for fresh state, `/fovea reload` after updates, and `/fovea settings` for configuration. Files live under `~/.pi/agent/fovea.json` or trusted `.pi/fovea.json`; the external-editor key (`Ctrl+G` by default) switches the displayed and saved layer between global defaults and project overrides. `tools.grepMode` controls the grep integration: `"augment"` (default) keeps native grep semantics and appends a Fovea graph section to symbol-query results — including `pi.grep` calls inside fabric_exec — `"replace"` keeps the legacy bare-query takeover, `"off"` is native only.

Budget overflow is not a dead end: any `… more results collapsed or outside budget` footer names a tmp artifact (`/tmp/pi-fovea-<op>-<hash>.txt`) holding the FULL list — read or grep that file for the remainder. Reach for `fovea_dwell` when you want a wider neighborhood, not just more of the same list.
