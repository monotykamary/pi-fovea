// pi-fovea extension entry. Registers the foveated-diffusion tools and a
// status command. All state lives in ops/session modules (in-memory,
// per-conversation); the on-disk content-hash cache makes graph rebuilds
// incremental across sessions.

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentDir } from "./core/agent-dir.js";
import { loadFoveaConfig, type FoveaConfig } from "./core/config.js";
import { hasAstGrep } from "./core/astgrep.js";
import { ROOT_CACHE_LIMIT } from "./core/asyncutil.js";
import { coverageSummary, dwell, ensureStateBackground, focus, impact, sketch } from "./core/ops.js";
import { observeSessionPaths, resetSessions } from "./core/session.js";
import { captureMutation, finishMutation, type MutationCapture } from "./core/provenance.js";
import { resetSyncBaselines, sync, warmSync } from "./core/sync.js";
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
  Type.String({ description: "Repo root to map. Defaults to the session working directory." }),
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
const ATTENTION_PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

const NODE_KINDS = new Set<NodeKind>([
  "function", "method", "class", "interface", "type", "field", "decl", "file", "anchor",
]);
const focusKind = (value: string | undefined): NodeKind | undefined =>
  value && NODE_KINDS.has(value as NodeKind) ? value as NodeKind : undefined;

export default function fovea(pi: ExtensionAPI) {
  // Per-root config cache; invalidated by settings saves (/fovea settings).
  const configs = new Map<string, FoveaConfig>();
  const configFor = (root: string, trusted = false, agentDir?: string): FoveaConfig => {
    const hit = configs.get(root);
    if (hit) {
      configs.delete(root);
      configs.set(root, hit);
      return hit;
    }
    const cfg = loadFoveaConfig({ cwd: root, agentDir: agentDir ?? resolveAgentDir(), projectTrusted: trusted });
    configs.set(root, cfg);
    while (configs.size > ROOT_CACHE_LIMIT) configs.delete(configs.keys().next().value!);
    return cfg;
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

  // Augment mode (default): native grep keeps core semantics in every host
  // (pi's model-facing loop AND pi.grep inside fabric_exec, which re-emits
  // the lifecycle for nested core tools), and Fovea appends a graph section
  // to symbol-query results through the tool_result middleware. Never throws:
  // a broken or seedless graph simply yields native grep unchanged.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "grep" || event.isError) return undefined;
    const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
    if (cfg.tools.grepMode !== "augment") return undefined;
    const input = (event.input ?? {}) as { pattern?: unknown; path?: unknown };
    const pattern = typeof input.pattern === "string" ? input.pattern.trim() : "";
    if (!pattern || !isSymbolLikeGrepQuery(pattern)) return undefined;
    try {
      const result = await focus(ctx.cwd, pattern, cfg.tools.grepAugmentBudget, {
        path: typeof input.path === "string" ? input.path : undefined,
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
        details: { ...details, backend: "hybrid", foveaAppended: true, query: pattern },
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
        const root = ctx.cwd;
        if (requestsNativeGrep(params)) {
          const native = await loadNativeGrepTool(root);
          return native.execute(id, params, signal, onUpdate);
        }
        const budget = configFor(root, ctx.isProjectTrusted()).tools.defaultBudget;
        const query = params.pattern.trim() || params.pattern;
        try {
          const result = await focus(root, query, budget, { fresh: true });
          if (Number(result.details.seeds ?? 0) === 0) {
            const native = await loadNativeGrepTool(root);
            return native.execute(id, params, signal, onUpdate);
          }
          return {
            content: [text(result.text.replace(/^fovea focus/, "fovea grep"))],
            details: { ...result.details, backend: "fovea", query },
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

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++lifecycleEpoch;
    const sessionId = ctx.sessionManager.getSessionId();
    // pi 0.84 replaces extension runtimes on resume/fork/new/reload. Core
    // module caches may outlive one factory instance, but disclosure and sync
    // baselines are session-local and must never cross that boundary.
    resetSessions();
    resetSyncBaselines();
    if (configFor(ctx.cwd, ctx.isProjectTrusted()).tools.grepMode === "replace") registerGrepOverride();
    // Kick indexing in the background — the very first prompt must never
    // wait on hashing/ast-grep. Slow cold builds surface a ready notice so
    // the freeze feels like progress instead of a hang.
    try {
      const kick = ensureStateBackground(ctx.cwd);
      const t0 = Date.now();
      // Always attach a rejection handler; headless sessions must not leak an
      // unhandled rejection when ast-grep is unavailable.
      void kick.promise.then(
        (st) => {
          if (epoch !== lifecycleEpoch) return;
          const ms = Date.now() - t0;
          if (kick.started && ctx.hasUI && ms > 4000) {
            ctx.ui.notify(`fovea: index ready — ${st.graph.files.length} files (${(ms / 1000).toFixed(1)}s)`, "info");
          }
          // Pre-establish the sync baseline in the background so the very
          // first prompt fast-paths instead of paying the snapshot on the
          // send path. A /new, /fork, or reload bumps the epoch and clears it.
          const pre = configFor(ctx.cwd, ctx.isProjectTrusted());
          void sync(
            ctx.cwd,
            { files: [], budget: pre.sync.budget, steerThreshold: pre.sync.steerThreshold, pushFocus: pre.sync.pushFocus, scope: pre.sync.scope, sessionId },
            st,
            { probe: "full" },
          ).catch(() => {});
        },
        (error) => {
          if (epoch !== lifecycleEpoch) return;
          if (kick.started && ctx.hasUI) {
            ctx.ui.notify(`fovea: index failed: ${error instanceof Error ? error.message : error}`, "warning");
          }
        },
      );
    } catch {
      // Pre-warm is strictly best-effort; the first tool call retries inline.
    }
  });

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
    for (const timer of warmTimers.values()) clearTimeout(timer);
    warmTimers.clear();
    pendingMutations.clear();
    lifecycleEpoch++;
    turnFiles = [];
    lastSyncError = undefined;
    resetSessions();
    resetSyncBaselines();
  });
  pi.on("turn_start", () => {
    turnFiles = [];
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    const args = event.args as { path?: unknown };
    if (ATTENTION_PATH_TOOLS.has(event.toolName) && typeof args.path === "string") {
      observeSessionPaths(ctx.cwd, [args.path]);
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (typeof args.path !== "string") return;
    turnFiles.push(args.path);
    const capture = await captureMutation(ctx.cwd, args.path);
    if (capture) pendingMutations.set(event.toolCallId, capture);
  });
  // Warm once the file is actually on disk (tool_execution_start fires during
  // preflight, before the write lands); the debounce also coalesces bursts.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const capture = pendingMutations.get(event.toolCallId);
    pendingMutations.delete(event.toolCallId);
    if (!event.isError && capture) {
      await finishMutation(capture, ctx.sessionManager.getSessionId(), event.toolCallId).catch(() => false);
    }
    warmAfterEdit(ctx.cwd, configFor(ctx.cwd, ctx.isProjectTrusted()));
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
      if (!syncRuns(cfg)) return;
      const outcome = await sync(
        ctx.cwd,
        { files: [], budget: cfg.sync.budget, steerThreshold: cfg.sync.steerThreshold, pushFocus: cfg.sync.pushFocus, scope: cfg.sync.scope, sessionId: ctx.sessionManager.getSessionId() },
        undefined,
        // Respond to the Enter key, never block on it: the TTL-bounded probe
        // detects out-of-band drift, a prepared warm verdict steers pre-prompt,
        // and everything else defers to turn_end's full sync.
        { probe: "defer" },
      );
      lastSyncError = undefined;
      if (outcome.red && outcome.text) {
        return {
          message: {
            customType: "pi-fovea-sync",
            content: outcome.text,
            display: syncDisplays(cfg),
            details: outcome.details,
          },
        };
      }
      if (outcome.structural && !outcome.details.baseline && !outcome.details.deferred && !outcome.details.outsideAttention && cfg.sync.ackClean && ctx.hasUI) {
        ctx.ui.notify("fovea: checked repository changes; no new action is needed.", "info");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI && message !== lastSyncError) ctx.ui.notify(`fovea: sync paused: ${message}`, "warning");
      lastSyncError = message;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
      const rels = turnFiles
        .map((p) => (p.startsWith(ctx.cwd + "/") ? p.slice(ctx.cwd.length + 1) : p))
        .filter((p) => !p.startsWith("/"));
      turnFiles = [];
      if (!syncRuns(cfg)) return;
      const outcome = await sync(
        ctx.cwd,
        { files: rels, budget: cfg.sync.budget, steerThreshold: cfg.sync.steerThreshold, pushFocus: cfg.sync.pushFocus, scope: cfg.sync.scope, sessionId: ctx.sessionManager.getSessionId() },
        undefined,
        { probe: "cheap" },
      );
      lastSyncError = undefined;
      if (!outcome.structural) return;
      if (outcome.red && outcome.text) {
        // Self/mixed/unattributed work can still receive an immediate
        // consequence steer. Another session's relevant update waits for the
        // next user prompt and therefore cannot restart an idle agent.
        pi.sendMessage({
          customType: "pi-fovea-sync",
          content: outcome.text,
          display: syncDisplays(cfg),
          details: outcome.details,
        }, outcome.delivery === "next-prompt"
          ? { deliverAs: "nextTurn" }
          : { deliverAs: "steer", triggerTurn: true });
      } else if (!outcome.details.baseline && !outcome.details.outsideAttention && cfg.sync.ackClean && ctx.hasUI) {
        ctx.ui.notify("fovea: checked repository changes; no new action is needed.", "info");
      }
    } catch (error) {
      // Turn-sync stays nonfatal, but a persistent index failure must not look
      // like a clean repository. Notify once until a successful sync clears it.
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI && message !== lastSyncError) ctx.ui.notify(`fovea: sync paused: ${message}`, "warning");
      lastSyncError = message;
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
      const root = params.root ?? ctx.cwd;
      try {
        if (signal?.aborted) throw new Error("Fovea sketch cancelled");
        onUpdate?.({ content: [text("Surveying production architecture…")], details: { phase: "sketch" } });
        const r = await sketch(root, params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget);
        return { content: [text(r.text)], details: r.details };
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
      const root = params.root ?? ctx.cwd;
      try {
        if (signal?.aborted) throw new Error("Fovea focus cancelled");
        onUpdate?.({ content: [text("Resolving focused repository context…")], details: { phase: "focus" } });
        const r = await focus(
          root,
          params.query,
          params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget,
          {
            path: params.path,
            language: params.language,
            kind: focusKind(params.kind),
            fresh: params.fresh,
          },
        );
        return { content: [text(r.text)], details: r.details };
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
      const root = params.root ?? ctx.cwd;
      try {
        if (signal?.aborted) throw new Error("Fovea dwell cancelled");
        onUpdate?.({ content: [text("Widening the current graph context…")], details: { phase: "diffuse" } });
        const r = await dwell(root, params.factor, params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget);
        return { content: [text(r.text)], details: r.details };
      } catch (error) {
        return rethrowOrDegrade(error);
      }
    },
  });

  pi.registerTool({
    name: "fovea_impact",
    label: "Fovea Impact",
    description:
      "Predict review order from changed files, symbols, or a PR base. Returns warmed files with causal channels, deterministic edge evidence paths, explicit input coverage gaps, co-change history, and obligations.",
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
      const root = params.root ?? ctx.cwd;
      try {
        if (signal?.aborted) throw new Error("Fovea impact cancelled");
        onUpdate?.({ content: [text("Tracing likely change impact…")], details: { phase: "impact" } });
        if ((params.root === undefined || params.root === ctx.cwd) && params.files?.length) {
          observeSessionPaths(ctx.cwd, params.files);
        }
        const r = await impact(root, {
          files: params.files,
          symbols: params.symbols,
          includeUncommitted: params.includeUncommitted,
          base: params.base,
          budget: params.maxTokens ?? configFor(root, ctx.isProjectTrusted()).tools.defaultBudget,
        });
        return { content: [text(r.text)], details: r.details };
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
        resetSessions();
        resetSyncBaselines();
        ctx.ui.notify("Fovea focus history and sync baseline reset.", "info");
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
      try {
        const [state, astGrep] = await Promise.all([
          sketch(ctx.cwd, 256),
          pi.exec(process.env.FOVEA_AST_GREP ?? "ast-grep", ["--version"], { timeout: 15_000 })
            .catch(() => ({ code: -1, stdout: "" })),
        ]);
        const coverage = coverageSummary(state.details);
        const failedCount = Number(state.details.extractionFailures ?? 0);
        const unreadableCount = Array.isArray(state.details.extractionUnreadable) ? state.details.extractionUnreadable.length : 0;
        const oversizedCount = Array.isArray(state.details.extractionOversized) ? state.details.extractionOversized.length : 0;
        const generatedCount = Array.isArray(state.details.extractionGenerated) ? state.details.extractionGenerated.length : 0;
        const cfg = configFor(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(
          `pi-fovea ${PACKAGE_VERSION} · ${coverage} · ${state.details.nodes ?? 0} symbols · ` +
          `${state.details.productionAnchors ?? state.details.anchors ?? 0} production anchors` +
          `${Number(state.details.testAnchors ?? 0) ? ` (${state.details.testAnchors} test/fixture collapsed)` : ""}` +
          `${failedCount ? ` · !${failedCount} files failed extraction` : ""}` +
          `${unreadableCount ? ` · !${unreadableCount} files unreadable` : ""}` +
          `${oversizedCount ? ` · !${oversizedCount} files over size cap` : ""}` +
          `${generatedCount ? ` · !${generatedCount} generated files skipped` : ""} · ` +
          `sync ${cfg.sync.mode}/${cfg.sync.scope} · grep ${cfg.tools.grepMode} · ` +
          `${astGrep.code === 0 ? astGrep.stdout.trim() : "ast-grep unavailable"}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`pi-fovea: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}
