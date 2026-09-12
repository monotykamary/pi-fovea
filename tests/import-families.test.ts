import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor, type FileFacts } from "../src/core/build.js";
import { extractImports } from "../src/core/extract.js";
import { assembleGraphWithIndex } from "../src/core/graph.js";
import { ensureState, evictState, focus, impact } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import type { ImportSite } from "../src/core/types.js";

const roots: string[] = [];
const fixture = (sources: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-import-family-"));
  roots.push(root);
  for (const [file, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
};
afterEach(() => {
  resetSessions();
  for (const root of roots.splice(0)) {
    evictState(root);
    rmSync(root, { recursive: true, force: true });
    rmSync(cachePathFor(root), { force: true });
  }
});
const graphFor = async (files: string[], imports: ImportSite[]) => {
  const facts = new Map<string, FileFacts>();
  for (const site of imports) {
    const value: FileFacts = facts.get(site.file) ?? { sha1: "fixture", symbols: [], imports: [], calls: [], literals: [], anchors: [] };
    value.imports.push(site);
    facts.set(site.file, value);
  }
  return (await assembleGraphWithIndex("/tmp/fovea-family-graph", files, facts)).graph;
};

describe("bounded import families", () => {
  it("distributes bounded conductance and keeps possible test imports uncertain", async () => {
    const file = "src/dispatch.test.ts";
    const graph = await graphFor([file, "src/plugins/a.ts", "src/plugins/b.ts", "src/other.ts"], [
      { file, line: 1, spec: "'./plugins/' + name + '.js'", dynamic: { prefix: "./plugins/", suffix: ".js" } },
    ]);
    const edges = graph.edges.filter((edge) => edge.evidence?.possible);
    expect(edges.map((edge) => graph.nodes[edge.b]!.file)).toEqual(["src/plugins/a.ts", "src/plugins/b.ts"]);
    expect(edges.reduce((sum, edge) => sum + edge.w, 0)).toBeCloseTo(0.15, 12);
    expect(edges.every((edge) => edge.evidence?.candidates === 2)).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === "tests" || edge.kind === "invokes")).toBe(false);
    expect(graph.importCoverage).toMatchObject({ sites: 1, possible: 1, resolved: 0, unresolved: 0, capped: 0 });
  });

  it("reports broad, unknown, and out-of-root expressions rather than emitting partial families", async () => {
    const file = "dispatch.ts";
    const graph = await graphFor([file, ...Array.from({ length: 33 }, (_, i) => `plugins/p${i}.ts`)], [
      { file, line: 1, spec: "broad", dynamic: { prefix: "./plugins/", suffix: ".js" } },
      { file, line: 2, spec: "getModule()", dynamic: {} },
      { file, line: 3, spec: "escape", dynamic: { prefix: "../", suffix: ".js" } },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.importCoverage).toMatchObject({ sites: 3, unresolved: 3, capped: 1, possible: 0 });
    expect(graph.importCoverage!.examples.map((item) => item.status)).toEqual(["capped", "unresolved", "unresolved"]);
    expect(graph.nodes.filter((node) => node.kind === "file")).toHaveLength(34);
  });

  it("makes resolver and diagnostic limits explicit without suppressing file nodes", async () => {
    const file = "dispatch.ts";
    const files = [file, "Main.java", ...Array.from({ length: 4097 }, (_, i) => `plugins/p${i}.json`)];
    const graph = await graphFor(files, [
      { file, line: 1, spec: "sparse", dynamic: { prefix: "./plugins/", suffix: ".js" } },
      ...Array.from({ length: 25 }, (_, i) => ({ file, line: i + 2, spec: `external-${i}` })),
    ]);
    expect(graph.importCoverage).toMatchObject({ sites: 26, unresolved: 26, capped: 1, unsupportedLanguages: ["Java"], examplesOmitted: 6 });
    expect(graph.importCoverage!.examples).toHaveLength(20);
    expect(graph.nodes.filter((node) => node.kind === "file")).toHaveLength(files.length);
  });
});

describe.skipIf(!hasAstGrep())("computed import extraction and heat", () => {
  it.each(["ts", "js", "tsx", "mts"])("extracts literal, bounded, and unresolved %s imports", async (ext) => {
    const name = `sample.${ext}`;
    const root = fixture({ [name]: [
      'import("./static.js");',
      "require('./static.js');",
      "import('./plugins/' + name + '.js');",
      'require(`./plugins/${kind.name}.js`);',
      'import(name);',
      "import('./plugins/' + getName() + '.js');",
      'import(`./${folder}/${name}.js`);',
    ].join("\n") });
    const sites = await extractImports([name], root);
    expect(sites).toHaveLength(7);
    const byLine = new Map(sites.map((site) => [site.line, site]));
    for (const line of [1, 2]) expect(byLine.get(line)?.dynamic).toBeUndefined();
    for (const line of [3, 4]) expect(byLine.get(line)?.dynamic).toEqual({ prefix: "./plugins/", suffix: ".js" });
    for (const line of [5, 6, 7]) expect(byLine.get(line)?.dynamic).toEqual({});
  });

  it("warms real runtime plugins without claiming exact dependencies or needing history", async () => {
    const root = fixture({
      "package.json": '{"type":"module"}',
      "src/dispatch.js": "export async function dispatch(name) { const plugin = await import('./plugins/' + name + '.js'); return plugin.run(); }\n",
      "src/plugins/a.js": "export function run() { return 41; }\n",
      "src/plugins/b.js": "export function run() { return 42; }\n",
    });
    const actual = execFileSync(process.execPath, ["--input-type=module", "-e",
      "const {dispatch}=await import(process.argv[1]); console.log(await dispatch('a'), await dispatch('b'));",
      pathToFileURL(join(root, "src/dispatch.js")).href], { encoding: "utf8" });
    expect(actual.trim()).toBe("41 42");
    const state = await ensureState(root);
    expect(state.graph.importCoverage).toMatchObject({ sites: 1, possible: 1 });
    const result = await impact(root, { files: ["src/dispatch.js"], includeUncommitted: false, budget: 512 }, state);
    expect(result.details.historyPartners).toBe(0);
    expect(result.details.warmedFiles).toEqual(expect.arrayContaining(["src/plugins/a.js", "src/plugins/b.js"]));
    expect((result.details.warmedReasons as Record<string, string[]>)["src/plugins/a.js"]).toContain("possible import target");
    expect(result.tokens).toBeLessThanOrEqual(512);
    const pointed = await focus(root, "src/dispatch.js", 2000);
    expect(pointed.text).toContain("possible import");
    expect((pointed.details.coverage as { imports: unknown }).imports).toMatchObject({ sites: 1, possible: 1 });
    const sourceImports = state.facts["src/dispatch.js"]!.imports;
    expect(sourceImports).toEqual(await extractImports(["src/dispatch.js"], root));
  });
});
