// The extension entry as pi sees it: register the graph tools, optionally
// replace grep, and execute through Pi's TypeBox tool contract.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir as systemTmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { getSession, resetSessions } from "../src/core/session.js";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { reviewReport, updateReviewMemory } from "../src/core/review.js";
import { canonicalPath } from "../src/core/roots.js";
import { captureMutation, finishMutation, provenancePathFor } from "../src/core/provenance.js";
import { hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor } from "../src/core/build.js";
import { ensureState, evictState, getInflight, getState } from "../src/core/ops.js";
import { DEFAULT_FOVEA_CONFIG } from "../src/core/config.js";
import { resetSyncBaselines, syncBaselineStore, warmCacheHas } from "../src/core/sync.js";

const tmpdir = () => realpathSync(systemTmpdir());

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;


interface ToolDef {
  name: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: { cwd: string; isProjectTrusted: () => boolean },
  ) => Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

type EventHandler = (event: Record<string, unknown>, ctx: ReturnType<typeof fakeCtx>) => unknown;
interface CommandDef {
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
  handler: (args: string, ctx: ReturnType<typeof fakeCtx>) => Promise<void>;
}

const fakeCtx = (cwd: string, trusted = false, sessionId = "test-session") => ({
  cwd,
  hasUI: false,
  sessionManager: { getSessionId: () => sessionId },
  isIdle: () => true,
  isProjectTrusted: () => trusted,
  reload: async () => {},
  ui: { notify: () => {} },
});

const load = () => {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, CommandDef>();
  const messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const handlers = new Map<string, EventHandler[]>();
  extension({
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      messages.push({ message, options });
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      try {
        return { code: 0, stdout: execFileSync(command, args, { encoding: "utf8" }), stderr: "" };
      } catch (error) {
        return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
    registerTool: (definition: ToolDef) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: CommandDef) => commands.set(name, definition),
  } as never);
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const emit = async (
    name: string,
    event: Record<string, unknown>,
    ctx: ReturnType<typeof fakeCtx>,
  ): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { tools, commands, messages, emit, execCalls };
};


const enableGrep = async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-grep-"));
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "fovea.json"),
    JSON.stringify({ tools: { grepMode: "replace" } }),
  );
  const loaded = load();
  await loaded.emit("session_start", { reason: "reload" }, fakeCtx(root, true));
  return { root, ...loaded };
};

describe("extension entry", () => {
  it("registers four graph tools and /fovea before session startup", () => {
    const { tools, commands } = load();
    for (const name of ["fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact"]) {
      expect(tools.has(name), name).toBe(true);
      expect(tools.get(name)?.promptSnippet, name).toBeTruthy();
      expect(tools.get(name)?.promptGuidelines?.some((guideline) => guideline.includes(name)), name).toBe(true);
    }
    expect(tools.has("grep")).toBe(false);
    expect(commands.has("fovea")).toBe(true);
    expect(commands.get("fovea")!.getArgumentCompletions?.("").map((item) => item.value)).toEqual([
      "status", "settings", "reset", "reload",
    ]);
    expect(DEFAULT_FOVEA_CONFIG.tools.grepMode).toBe("augment");
    expect(DEFAULT_FOVEA_CONFIG.tools.grepAugmentBudget).toBe(512);
  });

  it("reloads extension source through /fovea reload", async () => {
    const { commands } = load();
    const ctx = fakeCtx(FIXTURE);
    const reload = vi.fn(async () => {});
    ctx.reload = reload;
    await commands.get("fovea")!.handler("reload", ctx);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("registers an exact grep-compatible schema when the project setting is enabled", async () => {
    const loaded = await enableGrep();
    try {
      const grep = loaded.tools.get("grep");
      expect(grep).toBeDefined();
      const schema = grep!.parameters as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties)).toEqual([
        "pattern",
        "path",
        "glob",
        "ignoreCase",
        "literal",
        "context",
        "limit",
      ]);
      expect(schema.required).toEqual(["pattern"]);
    } finally {
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });

  it("honors PI_CODING_AGENT_DIR for global runtime configuration", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-agent-dir-"));
    const agentDir = path.join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "fovea.json"), JSON.stringify({ tools: { grepMode: "off" } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const loaded = load();
    try {
      await loaded.emit("session_start", { reason: "startup" }, fakeCtx(root, true));
      expect(loaded.tools.has("grep")).toBe(false);
      await getInflight(root)?.catch(() => undefined);
    } finally {
      vi.unstubAllEnvs();
      evictState(root);
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });

  it("degrades bare-query grep to native text with a note when the graph backend errors", async () => {
    const loaded = await enableGrep();
    // Real native grep answers the query; only the graph backend is broken.
    writeFileSync(path.join(loaded.root, "probe.ts"), "export function WhateverSymbol() {}\n");
    vi.stubEnv("FOVEA_AST_GREP", "/fovea-test/nonexistent-sg");
    try {
      const grep = loaded.tools.get("grep")!;
      const ctx = fakeCtx(loaded.root, true);
      const result = await grep.execute(
        "1",
        { pattern: "WhateverSymbol" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      expect(result.details.backend).toBe("native");
      expect(String(result.details.foveaError)).toContain("ast-grep");
      expect(result.content[0]!.text).toContain("native text results");
      expect(result.content.map((block) => block.text).join("\n")).toContain("export function WhateverSymbol");
    } finally {
      vi.unstubAllEnvs();
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });

  it("hard-errors a missing ast-grep once, then answers soft so work can continue natively", async () => {
    const { tools } = load();
    vi.stubEnv("FOVEA_AST_GREP", "/fovea-test/nonexistent-sg");
    try {
      const sketchTool = tools.get("fovea_sketch")!;
      const ctx = fakeCtx(FIXTURE);
      const signal = new AbortController().signal;
      await expect(sketchTool.execute("1", {}, signal, undefined, ctx)).rejects.toThrow(/ast-grep/);
      const again = await sketchTool.execute("2", {}, signal, undefined, ctx);
      expect(again.content[0]!.text).toContain("fovea unavailable");
      expect(again.content[0]!.text).toContain("native");
      expect(again.details.unavailable).toBe("ast-grep");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Host hooks acknowledge actual source windows, not tool names or completion.
  it("records exposure only after a successful matching read result", async () => {
    resetSessions();
    const loaded = load();
    const ctx = fakeCtx(FIXTURE);
    const session = getSession(canonicalPath(FIXTURE));
    const memory = updateReviewMemory(session, ["server/users.go"], new Map([
      ["web/api.ts", { salience: 1, revision: undefined, reasons: ["shared route"] }],
    ]));
    const args = { path: path.join(FIXTURE, "web/api.ts"), offset: 2, limit: 2 };
    await loaded.emit("tool_execution_start", { toolCallId: "failed", toolName: "read", args }, ctx);
    await loaded.emit("tool_execution_end", { toolCallId: "failed", toolName: "read", result: {}, isError: true }, ctx);
    expect(reviewReport(memory)).toMatchObject({ unseen: 1, seen: 0 });
    await loaded.emit("tool_execution_start", { toolCallId: "ok", toolName: "read", args }, ctx);
    const result = await createReadTool(FIXTURE).execute("ok", args);
    await loaded.emit("tool_execution_end", { toolCallId: "ok", toolName: "read", result, isError: false }, ctx);
    expect(reviewReport(memory)).toMatchObject({ unseen: 0, seen: 1,
      entries: [{ exposure: { windows: [{ start: 2, end: 3 }] } }] });
    expect(loaded.messages).toEqual([]);
    await loaded.emit("session_shutdown", {}, ctx);
  });

  it("stales exposure after a real edit, but not failed or no-op writes", async () => {
    resetSessions();
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-review-hooks-"));
    const file = path.join(root, "file.ts");
    writeFileSync(file, "export const value = 1;\n");
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      const memory = updateReviewMemory(getSession(root), ["seed.ts"], new Map([
        ["file.ts", { salience: 1, revision: undefined, reasons: ["call"] }],
      ]));
      const read = async () => {
        await loaded.emit("tool_execution_start", { toolCallId: "read", toolName: "read", args: { path: file } }, ctx);
        const result = await createReadTool(root).execute("read", { path: file });
        await loaded.emit("tool_execution_end", { toolCallId: "read", toolName: "read", result, isError: false }, ctx);
      };
      await read();
      expect(reviewReport(memory).seen).toBe(1);
      await loaded.emit("tool_execution_start", { toolCallId: "edit", toolName: "edit", args: { path: file } }, ctx);
      writeFileSync(file, "export const value = 2;\n");
      await loaded.emit("tool_execution_end", { toolCallId: "edit", toolName: "edit", result: {}, isError: false }, ctx);
      expect(reviewReport(memory)).toMatchObject({ stale: 1, seen: 0 });
      await read();
      for (const isError of [true, false]) {
        await loaded.emit("tool_execution_start", { toolCallId: "noop", toolName: "write", args: { path: file } }, ctx);
        await loaded.emit("tool_execution_end", { toolCallId: "noop", toolName: "write", result: {}, isError }, ctx);
        expect(reviewReport(memory)).toMatchObject({ stale: 0, seen: 1 });
      }
      expect(loaded.messages).toEqual([]);
    } finally {
      await loaded.emit("session_shutdown", {}, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasAstGrep())("extension execution", () => {
  it("reports loaded versions, index coverage, anchor scopes, and active modes", async () => {
    const { commands } = load();
    const ctx = fakeCtx(FIXTURE);
    const notify = vi.fn();
    ctx.ui.notify = notify;
    await commands.get("fovea")!.handler("status", ctx);
    const message = String(notify.mock.calls[0]?.[0]);
    expect(message).toMatch(/pi-fovea \d+\.\d+\.\d+/);
    expect(message).toContain("supported files selected");
    expect(message).toMatch(/\((git|walk)\/(complete|partial|truncated)\)/);
    expect(message).toContain("production anchors");
    expect(message).toContain("sync enabled");
    expect(message).toContain("grep augment");
    expect(message).toContain("ast-grep");
  });

  it("fovea_focus executes through the Pi tool contract", async () => {
    resetSessions();
    const { tools } = load();
    const focusTool = tools.get("fovea_focus")!;
    const schema = focusTool.parameters as { properties: Record<string, unknown> };
    for (const property of ["query", "path", "language", "kind", "fresh", "root", "maxTokens"]) {
      expect(schema.properties).toHaveProperty(property);
    }
    const updates: unknown[] = [];
    const result = await focusTool.execute(
      "t1",
      { query: "GetUserHandler", fresh: true, path: "server" },
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      fakeCtx(FIXTURE),
    );
    expect(result.content[0]!.text).toContain("fovea focus");
    expect(result.content[0]!.text).toContain("server/users.go");
    expect(Number(result.details.shown)).toBeGreaterThan(0);
    expect(Array.isArray(result.details.nodes)).toBe(true);
    expect(Array.isArray(result.details.suggestedReads)).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it("uses Fovea only for bare grep symbol queries", async () => {
    resetSessions();
    const loaded = await enableGrep();
    cpSync(FIXTURE, loaded.root, { recursive: true });
    try {
      const graph = await loaded.tools.get("grep")!.execute(
        "t-grep-graph",
        { pattern: "GetUserHandler" },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(graph.content[0]!.text).toContain("fovea grep");
      expect(graph.content[0]!.text).toContain("server/users.go");
      expect(graph.details).toMatchObject({ backend: "fovea", query: "GetUserHandler" });

      const graphAgain = await loaded.tools.get("grep")!.execute(
        "t-grep-graph-again",
        { pattern: "GetUserHandler" },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(graphAgain.content[0]!.text).toBe(graph.content[0]!.text);
      const qualified = await loaded.tools.get("grep")!.execute(
        "t-grep-qualified",
        { pattern: "AirportsController.search" },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(qualified.content[0]!.text).toContain("fovea grep");
      expect(qualified.content[0]!.text).toContain("web/airports.controller.ts");

      const route = await loaded.tools.get("grep")!.execute(
        "t-grep-route",
        { pattern: "/api/users/{id}" },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(route.content[0]!.text).toContain("fovea grep");
      expect(route.content[0]!.text).toContain("server/main.go");

      const regex = await loaded.tools.get("grep")!.execute(
        "t-grep-regex",
        { pattern: "Get.*Handler" },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(regex.content[0]!.text).toContain("func GetUserHandler");
      expect(regex.content[0]!.text).not.toContain("fovea grep");

      const native = await loaded.tools.get("grep")!.execute(
        "t-grep-native",
        { pattern: "GetUserHandler", path: "server", literal: true, context: 1 },
        new AbortController().signal,
        undefined,
        fakeCtx(loaded.root, true),
      );
      expect(native.content[0]!.text).toContain("func GetUserHandler");
      expect(native.content[0]!.text).not.toContain("fovea grep");
    } finally {
      rmSync(loaded.root, { recursive: true, force: true });
    }
  });


  it("co-existence: native grep results gain a Fovea graph section for symbol queries", async () => {
    resetSessions();
    const loaded = load();
    const [patch] = await loaded.emit("tool_result", {
      type: "tool_result",
      toolName: "grep",
      toolCallId: "t-augment",
      input: { pattern: "GetUserHandler" },
      content: [{ type: "text", text: "server/users.go:5: func GetUserHandler(id string) string {" }],
      details: { matches: 1 },
      isError: false,
    }, fakeCtx(FIXTURE));
    const result = patch as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain("func GetUserHandler");
    expect(result.content[1]!.text).toContain("fovea graph");
    expect(result.content[1]!.text).toContain("server/users.go");
    // Renderer-agnostic separator: consumers join blocks with one newline,
    // and the handler pads so the total gap is exactly one blank line.
    expect(result.content.map((c) => c.text).join("\n")).toContain("{\n\nfovea graph");
    expect(result.details).toMatchObject({
      matches: 1,
      backend: "hybrid",
      foveaAppended: true,
      query: "GetUserHandler",
    });

    // Native-only options stay native AND scope the graph lookup: `path`
    // narrows the Fovea query instead of suppressing it.
    const [scopedPatch] = await loaded.emit("tool_result", {
      type: "tool_result",
      toolName: "grep",
      toolCallId: "t-augment-scoped",
      input: { pattern: "GetUserHandler", path: "server", limit: 20 },
      content: [{ type: "text", text: "server/users.go:5: func GetUserHandler(id string) string {" }],
      details: {},
      isError: false,
    }, fakeCtx(FIXTURE));
    expect((scopedPatch as { content: Array<{ text: string }> }).content).toHaveLength(2);
  });

  it("skips augmentation for regex patterns, errors, non-grep tools, and off/replace modes", async () => {
    resetSessions();
    const loaded = load();
    const baseEvent = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "t",
      input,
      content: [{ type: "text", text: "native lines" }],
      details: {},
      isError: false,
      ...extra,
    });
    const [regex] = await loaded.emit("tool_result", baseEvent({ pattern: "Get.*Handler" }), fakeCtx(FIXTURE));
    expect(regex).toBeUndefined();
    const [errored] = await loaded.emit("tool_result", baseEvent({ pattern: "GetUserHandler" }, { isError: true }), fakeCtx(FIXTURE));
    expect(errored).toBeUndefined();
    const [readTool] = await loaded.emit("tool_result", baseEvent({ pattern: "GetUserHandler" }, { toolName: "read" }), fakeCtx(FIXTURE));
    expect(readTool).toBeUndefined();

    // Symbol queries that WOULD seed on this fixture stay untouched when the
    // mode says no augmentation (global scope, so untrusted projects apply).
    const agentDirRoot = mkdtempSync(path.join(tmpdir(), "pi-fovea-augment-mode-"));
    try {
      for (const mode of ["off", "replace"] as const) {
        writeFileSync(path.join(agentDirRoot, "fovea.json"), JSON.stringify({ tools: { grepMode: mode } }));
        vi.stubEnv("PI_CODING_AGENT_DIR", agentDirRoot);
        const fresh = load();
        const [blocked] = await fresh.emit("tool_result", baseEvent({ pattern: "GetUserHandler" }), fakeCtx(FIXTURE, true));
        expect(blocked, mode).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(agentDirRoot, { recursive: true, force: true });
    }
  });

  it("augment mode swallows graph failures so native grep passes through untouched", async () => {
    resetSessions();
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-augment-broken-"));
    vi.stubEnv("FOVEA_AST_GREP", "/fovea-test/nonexistent-sg");
    try {
      const loaded = load();
      const [patch] = await loaded.emit("tool_result", {
        type: "tool_result",
        toolName: "grep",
        toolCallId: "t",
        input: { pattern: "WhateverSymbol" },
        content: [{ type: "text", text: "native" }],
        details: {},
        isError: false,
      }, fakeCtx(root));
      expect(patch).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("silently absorbs hintless drift before the session enters a directory", async () => {
    // A raw filesystem write has no activity path tying it to this task. The
    // send path still defers the rebuild, then turn_end refreshes the broad
    // index and baseline without injecting sibling work into the conversation.
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-before-agent-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await ensureState(root); // session_start pre-warm equivalent
      await loaded.emit("before_agent_start", { prompt: "first" }, ctx);
      const main = path.join(root, "server/main.go");
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/idle", server.GetUserHandler)',
        ),
      );
      const results = await loaded.emit("before_agent_start", { prompt: "continue" }, ctx);
      expect(results.filter((result) => result !== undefined)).toEqual([]);
      expect(loaded.messages).toHaveLength(0);
      const beforeVersion = getState(root)!.version;
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(0);
      expect(getState(root)!.version).not.toBe(beforeVersion);
      // The outside-attention baseline advances, so the drift cannot replay.
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still injects a warmed verdict before the agent starts", async () => {
    // When the tool-edit warm landed before the user sends, the prepared
    // verdict renders on the send path — fast, no rebuild — and steers
    // pre-prompt exactly as before.
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-warm-agent-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await ensureState(root);
      await loaded.emit("before_agent_start", { prompt: "first" }, ctx);
      await loaded.emit("turn_start", {}, ctx);
      const main = path.join(root, "server/main.go");
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "t1", toolName: "edit", args: { path: main } },
        ctx,
      );
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/warmnext", server.GetUserHandler)',
        ),
      );
      await loaded.emit("tool_execution_end", { toolCallId: "t1", toolName: "edit" }, ctx);
      // Deterministic warm wait: fixed sleeps race the 250ms debounce plus
      // the impact compute whenever the machine is loaded.
      const deadline = Date.now() + 15_000;
      while (!warmCacheHas(root) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const results = await loaded.emit("before_agent_start", { prompt: "continue" }, ctx);
      const injected = results.find((result) => typeof result === "object" && result !== null) as {
        message: Record<string, unknown>;
      };
      expect(injected.message).toMatchObject({ customType: "pi-fovea-sync", display: true });
      expect(String(injected.message.content)).toContain("GET /api/users/{*}/warmnext");
      expect(String(injected.message.content)).toContain("Origin: current session.");
      expect(injected.message.details).toMatchObject({
        provenance: { kind: "current-session", files: { "server/main.go": "current-session" } },
      });
      expect(loaded.messages).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("re-baselines instead of leaking drift across a resumed session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-resume-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await ensureState(root);
      await loaded.emit("session_start", { reason: "startup" }, ctx);
      await loaded.emit("before_agent_start", { prompt: "first session" }, ctx);
      const main = path.join(root, "server/main.go");
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/resumed", server.GetUserHandler)',
        ),
      );

      await loaded.emit("session_shutdown", { reason: "resume" }, ctx);
      await loaded.emit("session_start", { reason: "resume", previousSessionFile: "/old/session.jsonl" }, ctx);
      const results = await loaded.emit("before_agent_start", { prompt: "resumed session" }, ctx);

      expect(results.filter((result) => result !== undefined)).toEqual([]);
    } finally {
      evictState(root);
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });

  it("delivers continuous sync intelligence as an immediate steer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-steer-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await ensureState(root); // session_start pre-warm equivalent
      await loaded.emit("before_agent_start", { prompt: "change the route" }, ctx); // establish pre-edit baseline
      await loaded.emit("turn_start", {}, ctx);
      const main = path.join(root, "server/main.go");
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "read-1", toolName: "read", args: { path: main } },
        ctx,
      );
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/steer", server.GetUserHandler)',
        ),
      );
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(loaded.messages[0]!.message).toMatchObject({
        customType: "pi-fovea-sync",
        display: true,
      });
      expect(String(loaded.messages[0]!.message.content)).toContain("Steer: account for this update");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues another session's relevant update for the next prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-other-session-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root, false, "session-a");
    const main = path.join(root, "server/main.go");
    try {
      await ensureState(root);
      await loaded.emit("before_agent_start", { prompt: "watch server" }, ctx);
      await loaded.emit("turn_start", {}, ctx);
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "read-1", toolName: "read", args: { path: main } },
        ctx,
      );
      const capture = await captureMutation(root, main);
      expect(capture).toBeDefined();
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/concurrent", server.GetUserHandler)',
        ),
      );
      expect(await finishMutation(capture!, "session-b", "other-edit")).toBe(true);

      await loaded.emit("turn_end", {}, ctx);

      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.options).toEqual({ deliverAs: "nextTurn" });
      expect(String(loaded.messages[0]!.message.content)).toContain("Origin: another Fovea-enabled session.");
      expect(String(loaded.messages[0]!.message.content)).toContain("Notice: review this concurrent update");
      expect(String(loaded.messages[0]!.message.content)).not.toContain("Steer:");
    } finally {
      rmSync(provenancePathFor(root, "session-b"), { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps hidden sync intelligence model-visible without rendering it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-hidden-sync-"));
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "fovea.json"), JSON.stringify({ sync: { mode: "hidden" } }));
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root, true);
    try {
      await ensureState(root);
      await loaded.emit("before_agent_start", { prompt: "change the route" }, ctx);
      await loaded.emit("turn_start", {}, ctx);
      const main = path.join(root, "server/main.go");
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "read-1", toolName: "read", args: { path: main } },
        ctx,
      );
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/hidden", server.GetUserHandler)',
        ),
      );
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(loaded.messages[0]!.message).toMatchObject({
        customType: "pi-fovea-sync",
        display: false,
      });
      expect(String(loaded.messages[0]!.message.content)).toContain("GET /api/users/{*}/hidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables sync work and delivery in disabled mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-disabled-sync-"));
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "fovea.json"), JSON.stringify({ sync: { mode: "disabled" } }));
    const loaded = load();
    const ctx = fakeCtx(root, true);
    try {
      const before = await loaded.emit("before_agent_start", { prompt: "do nothing" }, ctx);
      await loaded.emit("turn_start", {}, ctx);
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "t1", toolName: "edit", args: { path: path.join(root, "file.ts") } },
        ctx,
      );
      await loaded.emit("tool_execution_end", { toolCallId: "t1", toolName: "edit" }, ctx);
      await loaded.emit("turn_end", {}, ctx);
      expect(before.filter((result) => result !== undefined)).toEqual([]);
      expect(loaded.messages).toHaveLength(0);
      expect(getState(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("background-warms on edit tool end and still steers at turn_end", async () => {
    // The send-path pause came from sync blocking on refresh + fingerprint +
    // impact. With tool_execution_end wired to the debounced warm, an edit
    // prepares the verdict in the background; turn_end reuses it. This guards
    // the hook wiring end to end (event shapes, config gating, timer cleanup).
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-warm-"));
    cpSync(FIXTURE, root, { recursive: true });
    execSync("git init -qb main && git add -A", { cwd: root });
    execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(root);
    try {
      await ensureState(root);
      await loaded.emit("before_agent_start", { prompt: "add a route" }, ctx);
      await loaded.emit("turn_start", {}, ctx);
      const main = path.join(root, "server/main.go");
      await loaded.emit(
        "tool_execution_start",
        { toolCallId: "t1", toolName: "edit", args: { path: main } },
        ctx,
      );
      writeFileSync(
        main,
        readFileSync(main, "utf8").replace(
          'r.POST("/api/users", server.CreateUserHandler)',
          'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/warmed", server.GetUserHandler)',
        ),
      );
      await loaded.emit("tool_execution_end", { toolCallId: "t1", toolName: "edit" }, ctx);
      // Let the 250ms debounce warm land during the (simulated) model pause.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(String(loaded.messages[0]!.message.content)).toContain("Steer: account for this update");
      expect(String(loaded.messages[0]!.message.content)).toContain("GET /api/users/{*}/warmed");
      expect(String(loaded.messages[0]!.message.content)).toContain("Origin: current session.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fovea_impact executes and respects the what-if mode", async () => {
    resetSessions();
    const { tools } = load();
    const impactTool = tools.get("fovea_impact")!;
    const result = await impactTool.execute(
      "t2",
      { symbols: ["LoadUser"], includeUncommitted: false, maxTokens: 1200 },
      new AbortController().signal,
      undefined,
      fakeCtx(FIXTURE),
    );
    expect(result.content[0]!.text).toContain("fovea impact");
    expect(result.content[0]!.text).toContain("web/api.ts");
  });

  it("kicks a background index at session start without ever blocking the prompt", async () => {
    const loaded = load();
    const root = mkdtempSync(path.join(tmpdir(), "pi-fovea-pre-"));
    try {
      writeFileSync(path.join(root, "probe.ts"), "export const probe = 1;\n");
      evictState(root);
      // session_start returns promptly and the build runs out-of-band.
      await loaded.emit("session_start", { reason: "new" }, fakeCtx(root, true));
      const pending = getInflight(root);
      expect(pending).toBeDefined();
      const state = await pending!;
      expect(getState(root)?.version).toBe(state.version);
      // The fact cache materializes for the next session's warm start.
      expect(existsSync(cachePathFor(root))).toBe(true);
      // ast-grep missing: the gate short-circuits before kicking anything.
      const other = mkdtempSync(path.join(tmpdir(), "pi-fovea-pre-missing-"));
      try {
        vi.stubEnv("FOVEA_AST_GREP", "/fovea-test/nonexistent-sg");
        await loaded.emit("session_start", { reason: "new" }, fakeCtx(other, true));
        // Availability is probed asynchronously too: session start still
        // returns first, then the background build rejects without state.
        const unavailable = getInflight(other);
        expect(unavailable).toBeDefined();
        await expect(unavailable).rejects.toThrow(/ast-grep/);
        expect(getInflight(other)).toBeUndefined();
        expect(getState(other)).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      vi.unstubAllEnvs();
      evictState(root);
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });
});

describe.skipIf(!hasAstGrep())("explicit multi-root continuity", () => {
  it("binds relative roots and symlink aliases, with independent linked-worktree baselines", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "pi-fovea-roots-"));
    const a = path.join(parent, "a");
    const b = path.join(parent, "b");
    cpSync(FIXTURE, a, { recursive: true });
    execSync("git init -qb main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init", { cwd: a });
    execFileSync("git", ["worktree", "add", "-qb", "other", b], { cwd: a });
    symlinkSync(b, path.join(parent, "alias"), "dir");
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(a, true);
    const signal = new AbortController().signal;
    try {
      const run = (root?: string) => loaded.tools.get("fovea_focus")!.execute("focus", {
        root, query: "server/main.go", maxTokens: 512,
      }, signal, undefined, ctx);
      const [, alternate] = await Promise.all([run("."), run("../alias")]);
      expect(alternate.details.root).toBe(b);
      expect(alternate.details.observedRoots).toEqual([a, b]);
      expect(syncBaselineStore().has(a)).toBe(true);
      expect(syncBaselineStore().has(b)).toBe(true);
      expect(getState(a)).not.toBe(getState(b));
      expect(getState(b)!.root).toBe(b);
      expect((await run()).details.root).toBe(b);
      expect((await run("../b")).details.observedRoots).toEqual([a, b]);
      expect(Math.ceil(alternate.content[0]!.text.length / 4)).toBeLessThanOrEqual(512);

      const main = path.join(b, "server/main.go");
      writeFileSync(main, readFileSync(main, "utf8").replace("/api/users", "/api/worktree"));
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.message.details).toMatchObject({ root: b });
      expect(String(loaded.messages[0]!.message.content)).toContain("worktree");
      expect(readFileSync(path.join(a, "server/main.go"), "utf8")).not.toContain("worktree");
      const retained = getState(b);
      await loaded.commands.get("fovea")!.handler("reset", ctx);
      expect(syncBaselineStore().has(b)).toBe(false);
      expect(getState(b)).toBe(retained);
      const reset = await run();
      expect(reset.details.root).toBe(a);
      expect(reset.details.observedRoots).toEqual([a]);
    } finally {
      await loaded.emit("session_shutdown", {}, ctx);
      for (const root of [a, b]) evictState(root);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("routes multi-root edits and grep without widening sibling trust or the context allowance", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "pi-fovea-coordinator-"));
    const a = path.join(parent, "a");
    const b = path.join(parent, "b");
    const outside = path.join(parent, "unobserved");
    const agentDir = path.join(parent, "agent");
    mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, "fovea.json"), JSON.stringify({ sync: { budget: 1024 } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    for (const root of [a, b, outside]) {
      cpSync(FIXTURE, root, { recursive: true });
      mkdirSync(path.join(root, ".pi"));
      writeFileSync(path.join(root, ".pi/fovea.json"), JSON.stringify({ sync: { mode: "disabled" }, tools: { grepMode: "off" } }));
      execSync("git init -qb main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init", { cwd: root });
    }
    resetSessions();
    resetSyncBaselines();
    const loaded = load();
    const ctx = fakeCtx(parent, true);
    const signal = new AbortController().signal;
    try {
      for (const root of ["a", "b"]) {
        await loaded.tools.get("fovea_focus")!.execute(root, { root, query: "server/main.go", maxTokens: 512 }, signal, undefined, ctx);
      }
      // Parent trust must not disable the sibling's baseline via sibling config.
      expect(syncBaselineStore().has(a)).toBe(true);
      expect(syncBaselineStore().has(b)).toBe(true);
      const grepEvent = { toolName: "grep", input: { pattern: "GetUserHandler", path: "b/server" },
        content: [{ type: "text", text: "native result" }], details: {}, isError: false };
      const [patch] = await loaded.emit("tool_result", grepEvent, ctx);
      expect(patch).toMatchObject({ details: { root: b, foveaAppended: true } });
      const [trustedPatch] = await loaded.emit("tool_result", { ...grepEvent, input: { ...grepEvent.input, path: "server" } }, fakeCtx(b, true));
      expect(trustedPatch).toBeUndefined();
      const [again] = await loaded.emit("tool_result", grepEvent, ctx);
      expect(again).toMatchObject({ details: { root: b } });
      // Native no-path grep still searches cwd, not the last bound graph root.
      expect((await loaded.emit("tool_result", { ...grepEvent, input: { pattern: "GetUserHandler" } }, ctx))[0]).toBeUndefined();

      await loaded.emit("turn_start", {}, ctx);
      await loaded.emit("tool_execution_start", { toolName: "edit", toolCallId: "a-edit", args: { path: "a/server/main.go" } }, ctx);
      const mainA = path.join(a, "server/main.go");
      writeFileSync(mainA, readFileSync(mainA, "utf8").replace("/api/users", "/api/alpha"));
      await loaded.emit("tool_execution_end", { toolName: "edit", toolCallId: "a-edit" }, ctx);
      // Mutation without any tool event: baseline already exists from focus.
      const mainB = path.join(b, "server/main.go");
      writeFileSync(mainB, readFileSync(mainB, "utf8").replace("/api/users", "/api/beta"));
      await loaded.emit("tool_execution_start", { toolName: "read", toolCallId: "outside", args: { path: "unobserved/server/main.go" } }, ctx);
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages.map((m) => (m.message.details as { root: string }).root)).toEqual([a, b]);
      expect(String(loaded.messages[0]!.message.content)).toContain("Origin: current session.");
      expect(String(loaded.messages[1]!.message.content)).toContain("beta");
      expect(loaded.messages.reduce((n, m) => n + Math.ceil(String(m.message.content).length / 4), 0)).toBeLessThanOrEqual(1024);
      expect(getState(outside)).toBeUndefined();
      expect(syncBaselineStore().has(outside)).toBe(false);
      await expect(loaded.tools.get("fovea_sketch")!.execute("overflow", { root: "unobserved" }, signal, undefined, ctx)).rejects.toThrow("observed-root limit");
      expect(getState(outside)).toBeUndefined();
      await loaded.emit("turn_end", {}, ctx);
      expect(loaded.messages).toHaveLength(2);
    } finally {
      await loaded.emit("session_shutdown", {}, ctx);
      vi.unstubAllEnvs();
      for (const root of [a, b]) {
        evictState(root);
        rmSync(provenancePathFor(root, "test-session"), { force: true });
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
