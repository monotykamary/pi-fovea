# Roaming workspaces

The conversation is a coordinator. A project root is an independent observation domain, not the agent's process directory and not a common-ancestor graph joining unrelated repositories. Each domain keeps its own heat, attention, semantic baseline, and provenance. Contour's HEAD/index comparisons are also root-local; diffusion never crosses projects merely because they share a parent directory.

## Enrollment and boundaries

Successful `read`, `edit`, `write`, `grep`, `find`, and `ls` results provide structured paths. Literal shell cwd hints (`cwd`, `cd <literal> && …`, or `git -C <literal> …`) also qualify after success. Fabric's inner `pi.*` calls replay the native permission/result lifecycle and follow the same rule. We do not evaluate shell programs, inspect output text, expand variables/globs/substitutions, follow remote namespaces, or parse arbitrary `fabric_exec` source.

Discovery resolves physical paths and walks at most 64 ancestors. The nearest Git marker (directory or worktree `.git` file) wins; otherwise a recognized manifest, or the containing directory of a supported source file, is the conservative fallback. It does not enumerate sibling projects, run Git, or load project configuration. Lookups are coalesced and held in a 256-entry, one-second metadata cache. System-wide/home/private/dependency/generated paths are excluded from automatic discovery. This cache is **not** a source-freshness oracle.

Indexing expands the accessed file's scope to its containing project. Enrollment is not a sandbox, per-file ACL enforcement, or a project-configuration trust grant. A permission denial must happen before the underlying operation; failed or blocked results do not enroll anything. Hosts requiring finer-than-project analysis authorization must enforce it separately. Analysis Git commands disable fsmonitor, lazy fetching, and all transport protocols; missing local objects fail visibly instead of invoking repository-configured helpers or fetching. Explicit graph-tool roots remain available for intentional directory/umbrella scopes; Contour requires a Git worktree.

Native relative paths still resolve from Pi's tool-context cwd. Neither extension calls `process.chdir()`. Omitted analysis roots follow the most recently selected project; parallel callers should provide an explicit root. Canonical aliases share identity, but linked worktrees remain distinct. An explicitly selected narrow Fovea directory is not widened by later path activity it already owns.

## Bounded continuity

- `FOVEA_MAX_ROOTS`: 32 by default, clamped to 1–32. The recency ring refreshes on use; admitting root 33 retires the least recently used root rather than throwing.
- `FOVEA_CACHE_ROOTS`: 2 by default, independently controls heavy graph/fact/vector cache residency. Root-local semantic fingerprints and attention outlive numerical paging. A dwell reconstructs vectors for retained focus instead of silently forgetting it.
- `CONTOUR_MAX_ROOTS`: the same default/cap of 32. Immutable reports have separate bounded retention from the two hot graph generations.

Retirement clears root-local session/sync state and invalidates its lease. Old asynchronous work cannot publish a root result or steer after retirement/session replacement. Re-entry creates a new observation boundary. It does **not** certify the inactive interval. A first successful write can already be part of the new baseline: Fovea must not invent a prior delta or current-session authorship; Contour can still compare the patch with Git.

Branch-local custom entries retain only bounded root metadata. Compaction writes a fresh snapshot; reload/resume/fork/tree navigation restore the selected branch's roots, not stale semantic baselines, trust, or origin attribution. Reset explicitly clears the ring. Startup with no retained roots and idle coordinator hooks do not scan the launch directory.

Unchanged cold Git roots are checked without rebuilding their graphs; dirty-to-clean reverts still count. Cold probes are deferred off the blocking before-agent hook to the post-turn backstop. Non-Git manifests and explicit umbrella boundaries need periodic bounded sweeps. Shared sync context is spent on relevant messages, not divided by the number of unrelated quiet roots. Root labels and retirement notices count toward that budget.

Contour alternates recently accessed projects with a round-robin backstop, one root per scan. A 5-second scheduling tick is not a 5-second per-repository guarantee at 32 roots. Explicit checkpoints stop/abort speculative work, re-pin the requested repository's HEAD/index/worktree, and report root and agent origin separately. No discovery pass discloses findings or restarts an agent. `CONTOUR_BACKGROUND=0` leaves selection and explicit reviews available without polling.

## Lightweight shared API

`pi-fovea/workspace` exports `ExecutionRoots`, `ProjectDiscovery`, `canonicalPath`, `accessedPaths`, `WORKSPACE_ACCESS_EVENT`, `peerWorkspaceRoot`, `latestWorkspaceEntry`, `OBSERVED_ROOT_LIMIT`, and `envInt`. It imports no parser/graph/analysis engine, runs no Git, and does no filesystem work at module load.

Fovea and Contour publish version-1 hints on `WORKSPACE_ACCESS_EVENT` through Pi's local event bus: `{ version: 1, source: "fovea" | "contour", root, sessionId }`. Only matching nonempty session IDs and the other extension's source are accepted. Peer selections are not rebroadcast. This carries target metadata, not source content, heat, trust, or mutation authorship; processes and remote hosts need their own explicit coordination.

Executable coverage: `tests/roots.test.ts`, `tests/roaming.test.ts`, `tests/extension.test.ts`, and Contour's `tests/workspaces.test.ts` / `tests/startup.test.ts`.
