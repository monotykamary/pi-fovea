---
name: fovea
description: Token-efficient repository navigation with the standalone fovea CLI, independent of Pi. Use from an agent shell or CI to survey an unfamiliar repository, locate symbols and routes, trace dependencies, assess change impact, or refresh context after edits. Use the pi-fovea skill instead when working through Pi's session-aware extension tools.
compatibility: Requires the fovea executable and Node.js 20+. Most source languages also need ast-grep, supplied by the CLI's optional dependency or available on PATH.
---

# Fovea

Fovea builds a cross-language code graph of routes, symbols, imports, calls, and
string/env literals. Start with a cheap silhouette, focus on a question, then
read the indicated source ranges. This skill uses only the standalone `fovea`
command; no Pi installation or extension tools are required.

## Setup

If `fovea` is missing, install the standalone package with the user's permission:

```sh
npm install -g @monotykamary/fovea
```

The executable is `fovea`. The legacy global `pi-fovea` package also supplies it;
choose one global package, not both. No TypeScript loader or Bend compiler is
needed for the installed CLI. In a Fovea source checkout with development
dependencies installed, `bun run fovea <command> ...` runs the live source.

Most source languages require ast-grep. The optional `@ast-grep/cli` dependency
supplies it; an `ast-grep` on PATH takes precedence, and `FOVEA_AST_GREP` can select
an explicit executable. If optional dependencies were omitted, arrange for
ast-grep before treating missing source results as meaningful.

## Navigation loop

Always pass an explicit root (`.` or a repository path), then quote the query.
This avoids ambiguity between a query containing `/` and a root path. File
selectors in impact are relative to that root, not the shell's working directory.

```sh
fovea sketch /path/to/repo 900
fovea focus /path/to/repo "CreateUserHandler" 1200
fovea focus /path/to/repo "/api/users" 1200
fovea focus /path/to/repo "src/api.ts" 1200
```

1. **Sketch** once to find production entry points and source regions. Test and
   fixture architecture is collapsed; start around 512–1024 tokens.
2. **Focus** on a symbol, route, env key, or file. Read relevant source windows
   before making claims or edits. Close symbol spellings can resolve too.
3. **Impact** before a risky edit to find likely dependents and review order.
4. **Refresh** by rerunning focus or impact after edits, then run the project's
   targeted checks. Graph output is navigation evidence, not verification.

The trailing positive number is an approximate output token budget (about four
characters per token). Sketch, focus, and impact default to 512 and clamp to
256–16000. If the output is too narrow, rerun with a larger budget or a more
specific query. When an overflow footer names a text artifact, read or search
that exact path for the remaining eligible candidates; do not assume an artifact
exists when no path is returned.

## Change impact

```sh
# Current uncommitted changes (default).
fovea impact /path/to/repo 1200

# What-if analysis, without mixing in uncommitted changes.
fovea impact /path/to/repo --files src/api.ts,src/types.ts --no-uncommitted 1200
fovea impact /path/to/repo --symbols CreateUserHandler --no-uncommitted 1200

# PR-style changes: git diff main...HEAD, not the working tree.
fovea impact /path/to/repo --base main 1200
```

`--files` and `--symbols` take comma-separated values. Without `--no-uncommitted`,
explicit seeds also include uncommitted changes; `--base` replaces that automatic
working-tree selection with the three-dot diff. Use a base ref available locally.
In a non-Git directory, use explicit file or symbol seeds rather than relying on
a diff. Heat and co-change companions suggest where to inspect, not which files
must change or which checks have passed.

## Coverage and discovery

```sh
fovea status /path/to/repo
fovea anchors /path/to/repo "/api/users"
fovea anchors /path/to/repo --discovered
fovea rules /path/to/repo
fovea rules /path/to/repo --sigs
```

- **Status** summarizes index coverage and extraction problems. Missing parser
  support, excluded files, and unresolved imports limit what the graph can say.
- **Anchors** lists sorted, tab-separated anchor rows; the optional filter is a
  substring match. `--discovered` keeps inferred anchors only. This listing is
  not token-budgeted, so filter it instead of dumping a large repository.
- **Rules** shows discovered shape hypotheses as JSON lines, or a plain-text
  message if none qualify. `--sigs` shows supporting signature statistics.
  `fovea rules /path/to/repo --adopt` **writes** promoted rules to
  `.fovea/rules.json`; use it only when intentionally adopting reviewed rules.

## CLI boundaries

- Each invocation starts fresh. Disk caches speed extraction, but there is no
  persistent focus, seen-result suppression, workspace attention, or turn sync.
  A separate `fovea dwell` invocation cannot widen an earlier CLI focus; rerun
  `focus` with a larger budget instead.
- Output is rendered text on stdout, errors on stderr. There are no general
  `--json` or `--tsv` output modes; anchors and rules have the formats noted above.
  Pi tool arguments such as `fresh`, `path`, `language`, and `kind` are not CLI
  flags. Do not assume unknown flags are validated.
- Prefer graph navigation to bulk reading, but use native text search for exact
  literals, regexes, or missing graph results. Small repositories may not need a
  graph at all. Import coverage is not universal, and a possible import is not
  proof of an exact dependency. Always inspect source and keep acceptance tests
  in the host workflow.
