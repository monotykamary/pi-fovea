import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ imported: vi.fn(), sketch: vi.fn(async () => ({ text: "sketch", details: {} })), reset: vi.fn() }));
vi.mock("../src/core/extension-runtime.js", () => {
  mocks.imported();
  return { sketch: mocks.sketch, resetSyncBaselines: mocks.reset };
});
vi.mock("../src/core/config.js", () => ({ loadFoveaConfig: () => ({ sync: { mode: "disabled", budget: 1024 }, tools: { grepMode: "off", defaultBudget: 1024 } }) }));
let root: string;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "fovea-startup-"));
  await writeFile(join(root, "package.json"), "{}");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const registered = async () => {
  const { default: fovea } = await import("../src/index.js");
  const api = { on: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn() };
  fovea(api as unknown as ExtensionAPI);
  const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "startup", getBranch: () => [] }, ui: { notify: vi.fn() } };
  const emit = async (name: string) => { for (const [, handler] of api.on.mock.calls.filter(([event]) => event === name)) await handler({}, ctx); };
  return { api, ctx, emit };
};

describe("startup compilation boundary", () => {
  it("registers all tools without loading analysis on idle lifecycle events", async () => {
    const ext = await registered();
    expect(ext.api.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["fovea_sketch", "fovea_focus", "fovea_dwell", "fovea_impact"]);
    for (const event of ["session_start", "before_agent_start", "turn_end", "session_tree", "session_compact", "session_shutdown"]) await ext.emit(event);
    expect(mocks.imported).not.toHaveBeenCalled();
    expect(ext.api.sendMessage).not.toHaveBeenCalled();
  });

  it("loads once on demand and still resets an activated runtime", async () => {
    const ext = await registered();
    await ext.emit("session_start");
    const tool = ext.api.registerTool.mock.calls[0]![0];
    const results = await Promise.all([tool.execute("one", {}, undefined, undefined, ext.ctx), tool.execute("two", {}, undefined, undefined, ext.ctx)]);
    expect(results.map(r => r.content[0].text)).toEqual(["sketch", "sketch"]);
    expect(mocks.imported).toHaveBeenCalledTimes(1);
    expect(mocks.sketch).toHaveBeenCalledTimes(2);
    await ext.emit("session_shutdown");
    expect(mocks.reset).toHaveBeenCalled();
  });

  it("keeps the complete static graph below budget and analysis-free", async () => {
    const result = await build({ entryPoints: ["src/index.ts"], bundle: true, splitting: true, format: "esm", platform: "node", packages: "external", outdir: "startup-check", write: false, metafile: true });
    const outputs = result.metafile!.outputs;
    const entry = Object.keys(outputs).find(file => outputs[file]!.entryPoint === "src/index.ts")!;
    const files = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      for (const dependency of outputs[file]!.imports) if (!dependency.external && dependency.kind !== "dynamic-import") visit(dependency.path);
    };
    visit(entry);
    const inputs = [...files].flatMap(file => Object.keys(outputs[file]!.inputs));
    expect(inputs.filter(file => /core\/(extension-runtime|ops|state|sync|build|extract|graph|heat|provenance)\.ts$/.test(file) || file.endsWith("ui/settings.ts"))).toEqual([]);
    const external = [...files].flatMap(file => outputs[file]!.imports.filter(dependency =>
      dependency.external && dependency.kind === "import-statement" && !isBuiltin(dependency.path) && dependency.path !== "typebox"));
    expect(external).toEqual([]);
    expect([...files].reduce((sum, file) => sum + outputs[file]!.bytes, 0)).toBeLessThan(90 * 1024);
  });
});
