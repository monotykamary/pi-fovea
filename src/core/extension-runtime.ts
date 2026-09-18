// Loaded only by an operation that actually needs repository analysis.
export { ensureState, evictState } from "./state.js";
export { coverageSummary, dwell, focus, impact, sketch } from "./ops.js";
export { captureMutation, finishMutation } from "./provenance.js";
export { resetSyncBaselines, sync, syncBaselineStore, warmSync } from "./sync.js";
