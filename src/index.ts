// pi-fovea extension entry. Registers the foveated-diffusion tools and a
// status command. All state lives in ops/session modules (in-memory,
// per-conversation); the on-disk content-hash cache makes graph rebuilds
// incremental across sessions.

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalPath, ExecutionRoots, ProjectDiscovery, accessedPaths, WORKSPACE_ACCESS_EVENT, peerWorkspaceRoot, latestWorkspaceEntry } from "./core/roots.js";
import { ensureState, evictState } from "./core/state.js";
import { resolveAgentDir } from "./core/agent-dir.js";
import { loadFoveaConfig, type FoveaConfig } from "./core/config.js";
import { hasAstGrep } from "./core/astgrep.js";
import { OBSERVED_ROOT_LIMIT } from "./core/asyncutil.js";
import { coverageSummary, dwell, focus, impact, sketch } from "./core/ops.js";
import { observeSessionPaths, resetSessions } from "./core/session.js";
import { captureMutation, finishMutation, type MutationCapture } from "./core/provenance.js";
import { resetSyncBaselines, sync, syncBaselineStore, warmSync } from "./core/sync.js";
import type { NodeKind } from "./core/types.js";

const PACKAGE_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const BudgetParam = Type.Optional(
  Type.Number({ description: "Max tokens for the response (256..16000). Estimate: 4 chars/token.", minimum: 256, maximum: 16000 }),
);
const RootParam = Type.Optional(
  Type.String({ description: "Explicit root to observe and bind. Relative to session cwd; omitted uses the last bound root. Does not change native tool cwd or grant project trust." }),
);
const GrepParams = Type.Object({
  pattern: Type.String({ description: "Graph query for a bare identifier/path; exact text or regex pattern when search options are present." }),
  path: Type.Optional(Type.String({ description: "Directory or file scope. Supplying it selects native text grep." })),
  glob: Type.Optional(Type.String({ description: "File glob for native text grep." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive native text grep." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text and use native grep." })),
  context: Type.Optional(Type.Number({ description: "Context lines for native text grep." })),
  limit: Type.Optional(Type.Number({ description: "Maximum native text matches." })),
});

const REGEX_META = /[\\^$.*+?()[\]{}|]/;
const QUALIFIED_SYMBOL = /^[A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)+$/;
const REPO_PATH = /^(?:\.\/)?[\w@.-]+(?:\/[\w@.{}:$-]+)+$/;
const ROUTE_PATH = /^\/[\w@.{}:$/-]+$/;

/** Queries the graph can answer: bare words, qualified symbols, repo paths, routes. */
const isSymbolLikeGrepQuery = (pattern: string): boolean =>
  !REGEX_META.test(pattern) ||
  QUALIFIED_SYMBOL.test(pattern) ||
  REPO_PATH.test(pattern) ||
  ROUTE_PATH.test(pattern);
const requestsNativeGrep = (params: {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}): boolean =>
  params.path !== undefined || params.glob !== undefined || params.ignoreCase !== undefined ||
  params.literal !== undefined || params.context !== undefined || params.limit !== undefined ||
  (REGEX_META.test(params.pattern) &&
    !QUALIFIED_SYMBOL.test(params.pattern.trim()) &&
    !REPO_PATH.test(params.pattern.trim()) &&
    !ROUTE_PATH.test(params.pattern.trim()));

const text = (s: string) => ({ type: "text" as const, text: s });
const syncRuns = (config: FoveaConfig): boolean => config.sync.mode !== "disabled";
const syncDisplays = (config: FoveaConfig): boolean => config.sync.mode === "enabled";

const NODE_KINDS = new Set<NodeKind>([
  "function", "method", "class", "interface", "type", "field", "decl", "file", "anchor",
]);
const focusKind = (value: string | undefined): NodeKind | undefined =>
  value && NODE_KINDS.has(value as NodeKind) ? value as NodeKind : undefined;

export default function fovea(pi: ExtensionAPI) {
  const roots = new ExecutionRoots();
  const discovery = new ProjectDiscovery();
  let unsubscribe: (() => void) | undefined;
  let savedRevision = -1;
  let retiredSinceNotice = 0;
  const persistRoots = (force = false): void => {
    if (!force && savedRevision === roots.revision) return;
    pi.appendEntry?.("pi-fovea-workspace", roots.snapshot()); savedRevision = roots.revision;
  };
  const targetConfig = (root: string, ctx: ExtensionContext): FoveaConfig =>
    configFor(root, canonicalPath(ctx.cwd) === root && ctx.isProjectTrusted());
  // Per-root config cache; invalidated by settings saves (/fovea settings).
  const configs = new Map<string, FoveaConfig>();
  const configFor = (root: string, trusted = false, agentDir?: string): FoveaConfig => {
    const key = `${root}\0${trusted}\0${agentDir ?? resolveAgentDir()}`;
    const hit = configs.get(key);
    if (hit) {
      configs.delete(key);
      configs.set(key, hit);
      return hit;
    }
    const cfg = loadFoveaConfig({ cwd: root, agentDir: agentDir ?? resolveAgentDir(), projectTrusted: trusted });
    configs.set(key, cfg);
    while (configs.size > OBSERVED_ROOT_LIMIT) configs.delete(configs.keys().next().value!);
    return cfg;
  };

  // Serialize successful enrollment; failed or replaced sessions cannot bind late.
  let bindingTail: Promise<unknown> = Promise.resolve();
  const chooseRoot = async (ctx: ExtensionContext, input?: string): Promise<string> => {
    const epoch = lifecycleEpoch;
    if (input === undefined) await bindingTail.catch(() => {});
    if (epoch !== lifecycleEpoch) throw new Error("Fovea session changed during target selection");
    return roots.target(ctx.cwd, input);
  };
  const retireRoot = (root: string): void => {
    clearTimeout(warmTimers.get(root)); warmTimers.delete(root);
    resetSessions(root); resetSyncBaselines(root); evictState(root);
    for (const [id, capture] of pendingMutations) if (capture.root === root) pendingMutations.delete(id);
    retiredSinceNotice++;
  };
  const bindRoot = (root: string, ctx: ExtensionContext, peer = false): Promise<void> => {
    const epoch = lifecycleEpoch;
    const pending = bindingTail.catch(() => {}).then(async () => {
      if (epoch !== lifecycleEpoch) throw new Error("Fovea session changed during root binding");
      const change = roots.bind(root);
      if (change.evicted) retireRoot(change.evicted);
      if (change.fresh) { resetSessions(root); resetSyncBaselines(root); }
      persistRoots();
      const lease = roots.lease(root);
      const current = () => epoch === lifecycleEpoch && roots.lease(root) === lease;
      if (!peer) pi.events?.emit(WORKSPACE_ACCESS_EVENT, { version: 1, source: "fovea", root, sessionId: ctx.sessionManager.getSessionId() });
      const cfg = targetConfig(root, ctx);
      if (syncRuns(cfg) && !syncBaselineStore().has(root)) {
        const state = await ensureState(root);
        if (!current()) throw new Error("Fovea workspace changed during indexing");
        await sync(root, { files: [], budget: cfg.sync.budget, steerThreshold: cfg.sync.steerThreshold, scope: cfg.sync.scope,
          sessionId: ctx.sessionManager.getSessionId() }, state, { current });
      }
      if (!current()) throw new Error("Fovea workspace changed during indexing");
    });
    bindingTail = pending;
    return pending;
  };

  // A missing ast-grep throws the full install guidance on the first
  // failure; subsequent calls answer with a short "proceed natively" result
  // instead of burning turns on identical hard errors. Self-healing: once
  // ast-grep is back the ops succeed and the flag becomes irrelevant.
  let availabilityReported = false;
  const softUnavailable = () => ({
    content: [text(
      "fovea unavailable: the ast-grep binary is not on PATH, so the code graph cannot build. " +
      "Use native grep/read tools for the rest of this session, or install ast-grep (https://ast-grep.github.io/) and run /fovea reload.",
    )],
    details: { unavailable: "ast-grep" } as Record<string, unknown>,
  });
  const rethrowOrDegrade = (error: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => {
    if (!hasAstGrep()) {
      if (availabilityReported) return softUnavailable();
      availabilityReported = true;
    }
    throw error instanceof Error ? error : new Error(String(error));
  };

  let lifecycleEpoch = 0;
  let grepOverrideRegistered = false;

  // Enrollment follows completed access, never preflight/permission-gate intent.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    for (const path of accessedPaths(event.toolName, event.input, ctx.cwd)) {
      const epoch = lifecycleEpoch;
      const project = await discovery.discover(ctx.cwd, path);
      if (!project || epoch !== lifecycleEpoch) continue;
      const owner = roots.owner(ctx.cwd, path);
      const root = owner && owner.root.length > project.root.length ? owner.root : project.root;
      try {
        await bindRoot(root, ctx);
        const entered = roots.owner(ctx.cwd, path);
        if (entered) observeSessionPaths(entered.root, [entered.path || "."]);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`fovea: workspace analysis unavailable: ${error instanceof Error ? error.message : error}`, "warning");
      }
    }
  });

  // Augment mode (default): native grep keeps core semantics in every host
  // (pi's model-facing loop AND pi.grep inside fabric_exec, which re-emits
  // the lifecycle for nested core tools), and Fovea appends a graph section
  // to symbol-query results through the tool_result middleware. Never throws:
  // a broken or seedless graph simply yields native grep unchanged.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "grep" || event.isError) return undefined;
    const input = (event.input ?? {}) as { pattern?: unknown; path?: unknown };
    const owner = roots.owner(ctx.cwd, typeof input.path === "string" ? input.path : ".");
    if (!owner) return undefined;
    const cfg = targetConfig(owner.root, ctx);
    if (cfg.tools.grepMode !== "augment") return undefined;
    const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
    if (!pattern || !isSymbolLikeGrepQuery(pattern)) return undefined;
    try {
      const result = await focus(owner.root, pattern, cfg.tools.grepAugmentBudget, {
        path: owner.path || undefined,
        fresh: true,
      });
      if (Number(result.details.seeds ?? 0) === 0) return undefined;
      const details =
        typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
          ? (event.details as Record<string, unknown>)
          : {};
      // Consumers join content blocks with one newline; pad from our side so
      // the native and fovea graph sections end up one blank line apart no
      // matter how the native block terminates.
      const head = event.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("");
      const gap = head.endsWith("\n") ? "" : "\n";
      return {
        content: [
          ...event.content,
          text(gap + result.text.replace(/^fovea focus/, "fovea graph")),
        ],
        details: { ...details, backend: "hybrid", foveaAppended: true, query: pattern, root: owner.root },
      };
    } catch {
      return undefined;
    }
  });
  // pi-core's createGrepTool drags the whole host module graph into this
  // extension's loader (~1s of startup). Load it only on first native use.
  const loadNativeGrepTool = (root: string) =>
    import("@earendil-works/pi-coding-agent").then(({ createGrepTool }) => createGrepTool(root));
  const registerGrepOverride = (): void => {
    if (grepOverrideRegistered) return;
    grepOverrideRegistered = true;
    pi.registerTool({
      name: "grep",
      label: "grep (Fovea)",
      description:
        "Hybrid repository search. A bare identifier, qualified symbol, repo path, or route navigates the Fovea graph; obvious regexes and calls with path/glob/literal/context/limit preserve native grep and return exact matching lines.",
      promptSnippet: "Search exact text normally; bare symbol queries can expand through the Fovea graph",
      promptGuidelines: [
        "Use grep normally: search options and obvious regex patterns retain native text semantics; bare symbols, repo paths, and routes use Fovea with native fallback on a miss.",
      ],
      parameters: GrepParams,
      async execute(id, params, signal, onUpdate, ctx) {
        const root = roots.target(ctx.cwd);
        if (requestsNativeGrep(params) || targetConfig(root, ctx).tools.grepMode !== "replace") {
          const native = await loadNativeGrepTool(ctx.cwd);
          return native.execute(id, params, signal, onUpdate);
        }
        const budget = targetConfig(root, ctx).tools.defaultBudget;
        const query = params.pattern.trim() || params.pattern;
        try {
          const result = await focus(root, query, budget, { fresh: true });
          if (Number(result.details.seeds ?? 0) === 0) {
            const native = await loadNativeGrepTool(root);
            return native.execute(id, params, signal, onUpdate);
          }
          return {
            content: [text(result.text.replace(/^fovea focus/, "fovea grep"))],
            details: { ...result.details, backend: "fovea", query, root },
          };
        } catch (error) {
          // A broken graph backend must not break text search: degrade to
          // native grep and mark the result, the way a graph miss does.
          const message = error instanceof Error ? error.message : String(error);
          const native = await loadNativeGrepTool(root);
          const fallback = await native.execute(id, params, signal, onUpdate);
          return {
            ...fallback,
            content: [text(`fovea graph unavailable — native text results (${message})\n`), ...fallback.content],
            details: { ...(fallback.details ?? {}), backend: "native", foveaError: message, query },
          };
        }
      },
    });
  };

  const restoreRoots = (ctx: ExtensionContext): void => {
    lifecycleEpoch++; bindingTail = Promise.resolve(); discovery.clear();
    for (const timer of warmTimers.values()) clearTimeout(timer);
    warmTimers.clear(); pendingMutations.clear(); turnFiles = [];
    roots.restore(latestWorkspaceEntry(ctx.sessionManager.getBranch?.() ?? [], "pi-fovea-workspace"));
    savedRevision = roots.revision; retiredSinceNotice = 0;
    resetSessions(); resetSyncBaselines();
  };
  pi.on("session_start", async (_event, ctx) => {
    restoreRoots(ctx);
    unsubscribe?.();
    unsubscribe = pi.events?.on(WORKSPACE_ACCESS_EVENT, data => {
      const root = peerWorkspaceRoot(data, ctx.sessionManager.getSessionId(), "fovea");
      if (root) void bindRoot(canonicalPath(ctx.cwd, root), ctx, true).catch(() => {});
    });
    if (configFor(ctx.cwd, ctx.isProjectTrusted()).tools.grepMode === "replace") registerGrepOverride();
    // The launch directory is a coordinator, not an implicit scan request.
  });
  pi.on("session_tree", (_event, ctx) => restoreRoots(ctx));
  pi.on("session_compact", () => persistRoots(true));

  // Turn-sync loop. Tool events provide optional file hints, but content and
  // extracted-fact drift remain the source of truth. The same path therefore
  // covers fabric_exec, bash, subagents, and out-of-band editor saves. Pure
  // conversation turns exit at zero cost through the version fast path.
  let turnFiles: string[] = [];
  let lastSyncError: string | undefined;
  // Background warm pipeline: every edit schedules a debounced preparation of
  // the next sync verdict, so the blocking sync on the send path (before_agent
  // start / turn_end) reuses a precomputed fingerprint + impact cascade instead
  // of re-extracting and re-diffusing while the UI waits.
  const WARM_DEBOUNCE_MS = 250;
  const warmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingMutations = new Map<string, MutationCapture>();
  const warmAfterEdit = (root: string, cfg: FoveaConfig): void => {
    const rels = turnFiles
      .map((p) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p))
      .filter((p) => !p.startsWith("/"));
    if (!rels.length || !syncRuns(cfg)) return;
    const files = [...rels];
    const existing = warmTimers.get(root);
    if (existing) clearTimeout(existing);
    warmTimers.set(root, setTimeout(() => {
      warmTimers.delete(root);
      void warmSync(root, { files, budget: cfg.sync.budget }).catch(() => {});
    }, WARM_DEBOUNCE_MS));
  };
  pi.on("session_shutdown", () => {
    unsubscribe?.(); unsubscribe = undefined; discovery.clear();
    for (const timer of warmTimers.values()) clearTimeout(timer);
    warmTimers.clear();
    pendingMutations.clear();
    lifecycleEpoch++;
    turnFiles = [];
    lastSyncError = undefined;
    roots.clear();
    resetSessions();
    resetSyncBaselines();
  });
  pi.on("turn_start", () => {
    turnFiles = [];
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    const args = event.args as { path?: unknown };
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (typeof args.path !== "string") return;
    const owner = roots.owner(ctx.cwd, args.path);
    if (!owner) return;
    turnFiles.push(canonicalPath(owner.root, owner.path));
    const capture = await captureMutation(owner.root, owner.path);
    if (capture) pendingMutations.set(event.toolCallId, capture);
  });
  // Warm once the file is actually on disk (tool_execution_start fires during
  // preflight, before the write lands); the debounce also coalesces bursts.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const capture = pendingMutations.get(event.toolCallId);
    pendingMutations.delete(event.toolCallId);
    if (!event.isError && capture) {
      observeSessionPaths(capture.root, [capture.file]);
      await finishMutation(capture, ctx.sessionManager.getSessionId(), event.toolCallId).catch(() => false);
    }
    if (capture) warmAfterEdit(capture.root, targetConfig(capture.root, ctx));
  });
  // Clean roots spend no context. Rotate after budget exhaustion instead of
  // dividing one meaningful update into 32 tiny per-root allowances.
  let pollCursor = 0;
  const pollRoots = async (ctx: ExtensionContext, probe: "cheap" | "defer", files: string[], reserve = 0) => {
    const targets = roots.list();
    const epoch = lifecycleEpoch;
    let remaining = Math.max(0, configFor(canonicalPath(ctx.cwd), ctx.isProjectTrusted()).sync.budget - reserve);
    const notices: Array<{ content: string; display: boolean; details: Record<string, unknown>; nextPrompt: boolean }> = [];
    const start = targets.length ? pollCursor % targets.length : 0;
    for (let i = 0; i < targets.length; i++) {
      if (remaining < 128 || epoch !== lifecycleEpoch) break;
      const at = (start + i) % targets.length, root = targets[at]!;
      pollCursor = (at + 1) % targets.length;
      const lease = roots.lease(root);
      const current = () => epoch === lifecycleEpoch && roots.lease(root) === lease;
      try {
        const cfg = targetConfig(root, ctx);
        if (!syncRuns(cfg)) continue;
        const label = `Root: ${root}\n`;
        const budget = Math.min(cfg.sync.budget, remaining) - Math.ceil(label.length / 4) - 1;
        if (budget < 64) continue;
        const rels = files.flatMap(file => { const owner = roots.owner(ctx.cwd, file); return owner?.root === root ? [owner.path] : []; });
        const outcome = await sync(root, {
          files: rels, budget, steerThreshold: cfg.sync.steerThreshold,
          pushFocus: cfg.sync.pushFocus, scope: cfg.sync.scope, sessionId: ctx.sessionManager.getSessionId(),
        }, undefined, { probe, current });
        if (!current()) { if (!roots.has(root)) { resetSessions(root); resetSyncBaselines(root); } continue; }
        lastSyncError = undefined;
        if (outcome.red && outcome.text) {
          const content = (label + outcome.text).slice(0, Math.min(cfg.sync.budget, remaining) * 4 - 1) + "\n";
          remaining -= Math.ceil(content.length / 4);
          notices.push({ content, display: syncDisplays(cfg), details: { ...outcome.details, root, agentOrigin: ctx.cwd }, nextPrompt: outcome.delivery === "next-prompt" });
        } else if (outcome.structural && !outcome.details.baseline && !outcome.details.deferred &&
          !outcome.details.outsideAttention && cfg.sync.ackClean && ctx.hasUI) {
          ctx.ui.notify(`fovea: checked ${root}; no new action is needed.`, "info");
        }
      } catch (error) {
        const message = `${root}: ${error instanceof Error ? error.message : error}`;
        if (ctx.hasUI && message !== lastSyncError) ctx.ui.notify(`fovea: sync paused: ${message}`, "warning");
        lastSyncError = message;
      }
    }
    return notices;
  };
  pi.on("before_agent_start", async (_event, ctx) => {
    const note = retiredSinceNotice && syncRuns(configFor(ctx.cwd, ctx.isProjectTrusted()))
      ? `Workspace ring: ${retiredSinceNotice} project retirement(s). Only the ${roots.capacity} most recently used roots remain observed; re-entry starts a fresh baseline, not a clean verdict.\n` : "";
    const notices = await pollRoots(ctx, "defer", [], Math.ceil(note.length / 4));
    if (!notices.length && !note) return;
    retiredSinceNotice = 0;
    return { message: {
      customType: "pi-fovea-sync",
      content: note + notices.map((n) => n.content).join(""),
      // A combined pre-prompt notice must not expose a hidden target.
      display: notices.length > 0 && notices.every((n) => n.display),
      details: notices.length === 1 ? notices[0]!.details : { roots: notices.map((n) => n.details) },
    } };
  });
  pi.on("turn_end", async (_event, ctx) => {
    const files = turnFiles;
    turnFiles = [];
    for (const notice of await pollRoots(ctx, "cheap", files)) {
      pi.sendMessage({ customType: "pi-fovea-sync", content: notice.content,
        display: notice.display, details: notice.details }, notice.nextPrompt
        ? { deliverAs: "nextTurn" } : { deliverAs: "steer", triggerTurn: true });
    }
  });

  pi.registerTool({
    name: "fovea_sketch",
    label: "Fovea Sketch",
    description:
      "Survey a repository as a production-first silhouette: shipped feature anchors and directory regions first, with tests and fixtures collapsed. Details include deterministic discovery/extraction coverage and omissions.",
    promptSnippet: "Survey an unfamiliar repository with production architecture first",
    promptGuidelines: [
      "Use fovea_sketch once at the start of work in an unfamiliar repository, then focus a surfaced symbol or path.",
      "If the result overflows its budget, the footer names a tmp file with the full list — read or grep it instead of rerunning with a huge budget.",
    ],
    parameters: Type.Object({ root: RootParam, maxTokens: BudgetParam }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await chooseRoot(ctx, params.root);
      try {
        if (signal?.aborted) throw new Error("Fovea sketch cancelled");
        await bindRoot(root, ctx);
        const lease = roots.lease(root), epoch = lifecycleEpoch;
        onUpdate?.({ content: [text("Surveying production architecture…")], details: { phase: "sketch" } });
        const r = await sketch(root, params.maxTokens ?? targetConfig(root, ctx).tools.defaultBudget);
        if (epoch !== lifecycleEpoch || roots.lease(root) !== lease) throw new Error("Fovea root retired during analysis; retry with an explicit root");
        return { content: [text(r.text)], details: { ...r.details, root, observedRoots: roots.list(), workspace: roots.details(), agentOrigin: ctx.cwd } };
      } catch (error) {
        return rethrowOrDegrade(error);
      }
    },
  });

  pi.registerTool({
    name: "fovea_focus",
    label: "Fovea Focus",
    description:
      "Center the graph on a symbol, close spelling, route, protocol feature id, env key, or file. Returns exact signatures, typed direct relationships with strategy/rule/source evidence, coverage gaps, scopes, and suggested reads.",
    promptSnippet: "Locate a symbol or route and explain its direct graph relationships",
    promptGuidelines: [
      "Use fovea_focus for graph navigation and dependency context; use fresh=true when a reproducible full view is required.",
      "An overflow footer names a tmp file with the full list — read or grep it for the remainder; use fovea_dwell to widen the neighborhood semantically.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol, route, env key, repo path, or canonical feature id such as RPC pkg.Service/Method, GRAPHQL QUERY field, TRPC procedure, or CHANNEL key." }),
      path: Type.Optional(Type.String({ description: "Optional repo-relative file or directory scope." })),
      language: Type.Optional(Type.String({ description: "Optional ast-grep language scope, such as TypeScript or Go." })),
      kind: Type.Optional(Type.Union(
        ["function", "method", "class", "interface", "type", "field", "decl", "file", "anchor"].map((kind) => Type.Literal(kind)),
        { description: "Optional node-kind scope." },
      )),
      fresh: Type.Optional(Type.Boolean({ description: "Reset disclosure and return a reproducible full focus view." })),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await chooseRoot(ctx, params.root);
      try {
        if (signal?.aborted) throw new Error("Fovea focus cancelled");
        await bindRoot(root, ctx);
        const lease = roots.lease(root), epoch = lifecycleEpoch;
        onUpdate?.({ content: [text("Resolving focused repository context…")], details: { phase: "focus" } });
        const r = await focus(
          root,
          params.query,
          params.maxTokens ?? targetConfig(root, ctx).tools.defaultBudget,
          {
            path: params.path,
            language: params.language,
            kind: focusKind(params.kind),
            fresh: params.fresh,
          },
        );
        if (epoch !== lifecycleEpoch || roots.lease(root) !== lease) throw new Error("Fovea root retired during analysis; retry with an explicit root");
        return { content: [text(r.text)], details: { ...r.details, root, observedRoots: roots.list(), workspace: roots.details(), agentOrigin: ctx.cwd } };
      } catch (error) {
        return rethrowOrDegrade(error);
      }
    },
  });

  pi.registerTool({
    name: "fovea_dwell",
    label: "Fovea Dwell",
    description:
      "Widen the current focus and return newly relevant neighbors that were previously collapsed. If the graph generation changed, expires safely and asks for a fresh focus instead of applying stale vectors.",
    promptSnippet: "Widen the current Fovea focus for additional neighbors",
    promptGuidelines: ["Use fovea_dwell only after fovea_focus when wider subsystem context is useful."],
    parameters: Type.Object({
      factor: Type.Optional(Type.Number({ description: "Multiply diffusion time by this (default 2).", minimum: 1.1, maximum: 16 })),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await chooseRoot(ctx, params.root);
      try {
        if (signal?.aborted) throw new Error("Fovea dwell cancelled");
        await bindRoot(root, ctx);
        const lease = roots.lease(root), epoch = lifecycleEpoch;
        onUpdate?.({ content: [text("Widening the current graph context…")], details: { phase: "diffuse" } });
        const r = await dwell(root, params.factor, params.maxTokens ?? targetConfig(root, ctx).tools.defaultBudget);
        if (epoch !== lifecycleEpoch || roots.lease(root) !== lease) throw new Error("Fovea root retired during analysis; retry with an explicit root");
        return { content: [text(r.text)], details: { ...r.details, root, observedRoots: roots.list(), workspace: roots.details(), agentOrigin: ctx.cwd } };
      } catch (error) {
        return rethrowOrDegrade(error);
      }
    },
  });

  pi.registerTool({
    name: "fovea_impact",
    label: "Fovea Impact",
    description:
      "Predict review order from changed files, symbols, or a PR base. Returns warmed files with causal channels, deterministic edge evidence paths, explicit input coverage gaps, co-change history, and conserved diffusion heat.",
    promptSnippet: "Predict the likely review surface of a change",
    promptGuidelines: ["Use fovea_impact before broad or risky edits and when checking the blast radius of completed changes."],
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative changed files." })),
      symbols: Type.Optional(Type.Array(Type.String(), { description: "Changed symbol names (what-if mode)." })),
      includeUncommitted: Type.Optional(Type.Boolean({ description: "Seed from uncommitted changes (default true; ignored when base is set)." })),
      base: Type.Optional(Type.String({ description: "Base ref for PR-style cascades: seeds come from `git diff <base>...HEAD`." })),
      root: RootParam,
      maxTokens: BudgetParam,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const root = await chooseRoot(ctx, params.root);
      try {
        if (signal?.aborted) throw new Error("Fovea impact cancelled");
        await bindRoot(root, ctx);
        const lease = roots.lease(root), epoch = lifecycleEpoch;
        onUpdate?.({ content: [text("Tracing likely change impact…")], details: { phase: "impact" } });
        if (params.files?.length) {
          observeSessionPaths(root, params.files);
        }
        const r = await impact(root, {
          files: params.files,
          symbols: params.symbols,
          includeUncommitted: params.includeUncommitted,
          base: params.base,
          budget: params.maxTokens ?? targetConfig(root, ctx).tools.defaultBudget,
        });
        if (epoch !== lifecycleEpoch || roots.lease(root) !== lease) throw new Error("Fovea root retired during analysis; retry with an explicit root");
        return { content: [text(r.text)], details: { ...r.details, root, observedRoots: roots.list(), workspace: roots.details(), agentOrigin: ctx.cwd } };
      } catch (error) {
        return rethrowOrDegrade(error);
      }
    },
  });

  pi.registerCommand("fovea", {
    description: "pi-fovea status, settings, reset, and reload",
    getArgumentCompletions: (prefix) =>
      ["status", "settings", "reset", "reload"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "status";
      if (!["status", "settings", "reset", "reload"].includes(sub)) {
        ctx.ui.notify("Usage: /fovea status | settings | reset | reload", "warning");
        return;
      }
      if (sub === "reload") {
        ctx.ui.notify("Reloading pi-fovea source…", "info");
        await ctx.reload();
        return;
      }
      if (sub === "reset") {
        lifecycleEpoch++;
        roots.clear(); discovery.clear(); persistRoots(); retiredSinceNotice = 0;
        for (const timer of warmTimers.values()) clearTimeout(timer);
        warmTimers.clear();
        pendingMutations.clear();
        turnFiles = [];
        resetSessions();
        resetSyncBaselines();
        ctx.ui.notify("Fovea focus history and sync baseline cleared.", "info");
        return;
      }
      if (sub === "settings") {
        const { openFoveaSettings } = await import("./ui/settings.js");
        const result = await openFoveaSettings(ctx, { onConfigApplied: () => configs.clear() });
        if (result.grepRegistrationChanged) {
          ctx.ui.notify("Reloading extensions to apply the grep tool change…", "info");
          await ctx.reload();
        }
        return;
      }
      if (!roots.list().length) {
        ctx.ui.notify(`pi-fovea ${PACKAGE_VERSION} · coordinator idle · 0/${roots.capacity} roots · no cwd scan; projects enroll after successful access.`, "info");
        return;
      }
      try {
        const root = roots.target(ctx.cwd);
        const [state, astGrep] = await Promise.all([
          sketch(root, 256),
          pi.exec(process.env.FOVEA_AST_GREP ?? "ast-grep", ["--version"], { timeout: 15_000 })
            .catch(() => ({ code: -1, stdout: "" })),
        ]);
        const coverage = coverageSummary(state.details);
        const failedCount = Number(state.details.extractionFailures ?? 0);
        const unreadableCount = Array.isArray(state.details.extractionUnreadable) ? state.details.extractionUnreadable.length : 0;
        const oversizedCount = Array.isArray(state.details.extractionOversized) ? state.details.extractionOversized.length : 0;
        const generatedCount = Array.isArray(state.details.extractionGenerated) ? state.details.extractionGenerated.length : 0;
        const cfg = targetConfig(root, ctx);
        ctx.ui.notify(
          `pi-fovea ${PACKAGE_VERSION} · root ${root} · ${roots.list().length}/${roots.capacity} observed · ${roots.details().retirements} retired · ${coverage} · ${state.details.nodes ?? 0} symbols · ` +
          `${state.details.productionAnchors ?? state.details.anchors ?? 0} production anchors` +
          `${Number(state.details.testAnchors ?? 0) ? ` (${state.details.testAnchors} test/fixture collapsed)` : ""}` +
          `${failedCount ? ` · !${failedCount} files failed extraction` : ""}` +
          `${unreadableCount ? ` · !${unreadableCount} files unreadable` : ""}` +
          `${oversizedCount ? ` · !${oversizedCount} files over size cap` : ""}` +
          `${generatedCount ? ` · !${generatedCount} generated files skipped` : ""} · ` +
          `sync ${cfg.sync.mode}/${cfg.sync.scope} · grep ${cfg.tools.grepMode} · ` +
          `${astGrep.code === 0 ? astGrep.stdout.trim() : "ast-grep unavailable"}\nObserved: ${roots.list().join(", ")}\n${roots.details().continuity}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`pi-fovea: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}
