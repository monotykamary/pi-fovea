// Lightweight workspace coordination. No parsers, graph state, Git processes,
// project configuration, or filesystem work at module load.
export { ExecutionRoots, ProjectDiscovery, canonicalPath, accessedPaths, WORKSPACE_ACCESS_EVENT, peerWorkspaceRoot, latestWorkspaceEntry } from "./core/roots.js";
export { OBSERVED_ROOT_LIMIT, envInt } from "./core/asyncutil.js";
