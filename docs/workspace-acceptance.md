# Roaming workspace acceptance

The session is a coordinator, not a filesystem-wide graph. Work may live in
many nested or disjoint local projects. Native tool paths still follow Pi's cwd;
the graph/review target follows successful project access.

## Release checks

- [x] A default 32-root recency ring replaces overflow errors. Touches refresh
  residency; the 33rd root retires the least recently used root. Lower test/user
  limits work. Aliases unify; linked worktrees do not.
- [x] Automatic discovery runs only after successful known tool access. It walks
  bounded ancestors, caches/coalesces lookups, never scans siblings, executes Git,
  or loads project configuration. Broad/system/private/dependency paths do not
  cause automatic indexing. Failed/blocked accesses enroll nothing.
- [x] Structured paths and conservative literal shell cwd forms are supported;
  arbitrary shell programs, output text, remote namespaces, and expansions are
  not guessed. Explicit roots remain available.
- [x] Startup and idle coordinator hooks do not scan cwd. Branch-local bounded
  root snapshots survive compaction/reload/resume, without restoring old semantic
  baselines or granting project trust.
- [x] Fovea and Contour exchange session-qualified target hints without loops or
  cross-session enrollment. Explicit concurrent calls can override the target.
- [x] Eviction clears root-local baselines/attention/work; stale asynchronous
  completions cannot resurrect membership or publish a delta for a retired root.
  Re-entry is explicitly a fresh observation boundary, never a clean verdict.
- [x] Observation retention is separate from heavy graph/vector residency.
  Unchanged cold Git roots do not rebuild graphs. Shared sync budgets do not
  shrink merely because many unrelated clean roots are enrolled.
- [x] Contour has explicit tool/command roots, root-labelled reports, a bounded
  fair silent observer, and fresh per-repository HEAD/index comparisons. The
  agent origin is metadata, not the review target or claimed mutation author.
- [x] Local full checks, CLI/package/real-Pi probes and generated artifact gates
  pass: Fovea 250 tests; Contour 60 tests. The composed Pi-loader probe verifies
  neutral startup, blocked access, peer handoff, literal shell access, immutable
  indexes and reload restoration with no unsolicited messages.

## Publication procedure

Publish Fovea v0.27.0 first, then replace Contour's disposable development
archive with the pinned registry dependency and rerun its final gates. Release
Contour v0.2.0 with source and generated distribution together. Use conventional
commits/tags; verify canonical registry tarballs, pushed refs and CI. Registry,
Git and CI receipts—not this ledger—are the release record.

First access is a new observation boundary. A write before any successful read
can be included in that boundary; Fovea must not invent a prior semantic delta or
its provenance. Contour still reviews that patch against Git. Changes outside
the ring are unobserved; re-enrollment does not certify the inactive interval.
