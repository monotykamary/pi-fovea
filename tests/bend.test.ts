import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAstGrep, langOf, scanRules } from "../src/core/astgrep.js";
import { extractBend } from "../src/core/bend.js";
import { cachePathFor, clearPersistTimer, filterSupported, loadFacts, refreshFacts, type FileFacts } from "../src/core/build.js";
import { coreFactsFromScan, coreScanRules, extractCalls, extractImports, extractLiterals, extractSymbols, supportsImportExtraction } from "../src/core/extract.js";
import { assembleGraphWithIndex } from "../src/core/graph.js";
import { ensureState, evictState, focus, impact } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import { makeFileSource } from "../src/core/source.js";
import { resetSyncBaselines, sync } from "../src/core/sync.js";

const roots: string[] = [];
const fixture = (sources: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-bend-"));
  roots.push(root);
  for (const [file, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetSessions();
  resetSyncBaselines();
  for (const root of roots.splice(0)) {
    evictState(root);
    clearPersistTimer(root);
    rmSync(root, { recursive: true, force: true });
    rmSync(cachePathFor(root), { force: true });
  }
});

const program = [
  "import Base",
  "import ./math.bend as M # module alias",
  "import 0xabc123/main.bend as P",
  "type Shape is Data:",
  "  Circle{r: U32}",
  "  Square{s: U32}",
  "law area_positive:",
  "  for x: Shape",
  "  {M.area(x) == 0 : U32}",
  "@unsafe def Shape.area(",
  "  ~f: U32 -> U32,",
  "  x: Shape",
  ") -> U32:",
  "  M.square!(f(7)) # fake_call()",
  "def main() -> IO(Unit):",
  '  IO.print("DATABASE_URL")',
  '  IO.print("/api/shapes/#fragment")',
  '  IO.print("def fake(): ghost() `PHANTOM_ENV`")',
  "  return (Shape.area(~f, Circle{7}))",
  "def effect() -> IO(Unit):",
  '  import "./effect.js"',
  '  import "./effect.c"',
  "# def commented(): missing()",
].join("\n");

const graphFor = async (sources: Record<string, string>) => {
  const facts = new Map<string, FileFacts>();
  for (const [file, text] of Object.entries(sources)) {
    facts.set(file, { sha1: "fixture", anchors: [], ...extractBend(file, text) });
  }
  return (await assembleGraphWithIndex("/unused", Object.keys(sources), facts)).graph;
};

describe("Bend 2 source reader", () => {
  it("registers .bend as source with import coverage and no ast-grep rules", () => {
    expect(langOf("PROOF.bend")).toBe("Bend");
    expect(langOf("MAIN.BEND")).toBe("Bend");
    expect(filterSupported(["LAWS.bend", "main.bend", "unknown.xyz"])).toEqual(["LAWS.bend", "main.bend"]);
    expect(supportsImportExtraction("Bend")).toBe(true);
    expect(coreScanRules(["main.bend"])).toEqual([]);
    expect(coreScanRules(["main.bend", "api.ts"]).every((rule) => rule.language === "TypeScript")).toBe(true);
  });

  it("extracts laws, dotted defs, datatypes, constructors and exact lines", () => {
    const facts = extractBend("main.bend", program);
    expect(facts.symbols.map(({ name, kind, line }) => [name, kind, line])).toEqual([
      ["Shape", "type", 4], ["Circle", "decl", 5], ["Square", "decl", 6],
      ["area_positive", "decl", 7], ["Shape.area", "function", 10],
      ["main", "function", 15], ["effect", "function", 20],
    ]);
    expect(facts.symbols.every((symbol) => symbol.lang === "Bend")).toBe(true);
    expect(facts.calls.map(({ callee, line }) => [callee, line])).toEqual([
      ["M.area", 9], ["M.square", 14], ["f", 14], ["IO.print", 16],
      ["IO.print", 17], ["IO.print", 18], ["Shape.area", 19],
    ]);
    expect(facts.imports).toEqual([
      { file: "main.bend", line: 1, spec: "Base" },
      { file: "main.bend", line: 2, spec: "./math.bend", alias: "M" },
      { file: "main.bend", line: 3, spec: "0xabc123/main.bend", alias: "P" },
      { file: "main.bend", line: 21, spec: "./effect.js" },
      { file: "main.bend", line: 22, spec: "./effect.c" },
    ]);
    expect(facts.literals.map((site) => site.text)).toEqual([
      "DATABASE_URL", "/api/shapes/#fragment", "def fake(): ghost() `PHANTOM_ENV`", "./effect.js", "./effect.c",
    ]);
  });

  it("handles inline bodies and coalesces laws with implementations", async () => {
    const text = [
      "type Unit is Data: Unit{}",
      "law identity:", "  for x: U32", "  U32",
      "def identity(x): helper(x)",
      "def helper(x: U32) -> U32: x",
      "def effect() -> IO(Unit): import \"./effect.c\"",
    ].join("\n");
    const facts = extractBend("main.bend", text);
    expect(facts.symbols.map(({ name, kind, line }) => [name, kind, line])).toEqual([
      ["Unit", "type", 1], ["identity", "function", 5], ["helper", "function", 6], ["effect", "function", 7],
    ]);
    expect(facts.calls).toEqual([{ file: "main.bend", line: 5, callee: "helper" }]);
    expect(facts.imports).toEqual([{ file: "main.bend", line: 7, spec: "./effect.c" }]);
    const graph = await graphFor({ "main.bend": text });
    const call = graph.edges.find((edge) => edge.kind === "invokes")!;
    expect(graph.nodes[call.a]!.name).toBe("identity");
    expect(graph.nodes[call.b]!.name).toBe("helper");
  });

  it("masks escaped quotes, characters and multiline string contents", () => {
    const text = String.raw`def main() -> String:
  x = "escaped \"quote\" # hidden()"
  c = '#'
  y = "multiline
law phantom:
  hidden()
"
  real(x)
`;
    const facts = extractBend("strings.bend", text);
    expect(facts.symbols.map((symbol) => symbol.name)).toEqual(["main"]);
    expect(facts.calls.map((call) => call.callee)).toEqual(["real"]);
    expect(facts.literals[0]).toMatchObject({ line: 2, text: 'escaped "quote" # hidden()' });
    expect(facts.literals[1]?.line).toBe(4);
  });

  it("keeps standalone and consolidated facts identical without a grammar", async () => {
    const root = fixture({ "main.bend": program });
    const source = makeFileSource(root);
    const files = ["main.bend"];
    const native = extractBend(files[0]!, program);
    expect(await extractSymbols(files, root, source)).toEqual(native.symbols);
    expect(await extractImports(files, root, source)).toEqual(native.imports);
    expect(await extractCalls(files, root, source)).toEqual(native.calls);
    expect(await extractLiterals(files, root, source)).toEqual(native.literals);
    expect(await coreFactsFromScan(files, root, source, [])).toEqual({
      imports: native.imports, calls: native.calls, literals: native.literals,
    });
  });

  it("resolves aliases and exact foreign paths without unrelated global guesses", async () => {
    const graph = await graphFor({
      "app/main.bend": [
        "import ./math.bend as M", "import ../other.bend as Other", "import Base",
        "import 0xabc123/main.bend as P", "import ../../outside.bend as Outside",
        "def Local.square(x: U32) -> U32:", "  x",
        "def main() -> U32:", "  M.square!(7)", "  Other.square(7)",
        "  Local.square(7)", "  square(7)", "  M.SQUARE(7)", "  P.square(7)",
        "def effect() -> IO(Unit):", '  import "./effect.js"',
      ].join("\n"),
      "app/math.bend": "def square(x: U32) -> U32:\n  x\n",
      "other.bend": "def square(x: U32) -> U32:\n  x\n",
      "app/effect.js": "", "app/effect.ts": "", "lib/Base.ts": "", "lib/main.ts": "",
    });
    const edges = graph.edges.filter((edge) => edge.kind === "invokes");
    expect(edges.map((edge) => [graph.nodes[edge.a]!.name, graph.nodes[edge.b]!.id])).toEqual([
      ["main", "square@app/math.bend"], ["main", "square@other.bend"], ["main", "Local.square@app/main.bend"],
    ]);
    expect(edges.slice(0, 2).every((edge) => edge.evidence?.strategy === "imported-symbol")).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === "imports").map((edge) => graph.nodes[edge.b]!.file))
      .toEqual(["app/math.bend", "other.bend", "app/effect.js"]);
    expect(graph.importCoverage).toMatchObject({ sites: 6, resolved: 3, unresolved: 3, unsupportedLanguages: [] });
  });

  it("never promotes Bend path calls into unsupported ast-grep rules", async () => {
    const sources = {
      "one.bend": 'def main() -> IO(Unit):\n  Router.get("/one")\n  Router.get("/two")\n',
      "two.bend": 'def main() -> IO(Unit):\n  Router.get("/three")\n  Router.get("/four")\n',
    };
    const root = fixture(sources);
    const outcome = await loadFacts(root, Object.keys(sources));
    expect(outcome.report.failed).toEqual([]);
    for (const facts of outcome.store.facts.values()) {
      expect(facts.sigs).toBeUndefined();
      expect(facts.calls).toHaveLength(2);
      expect(facts.literals).toHaveLength(2);
    }
  });

  it("persists aliases and refreshes edited Bend facts", async () => {
    const sources = { "main.bend": "import ./math.bend as M\ndef main() -> U32:\n  M.square(7)\n", "math.bend": "def square(x: U32) -> U32:\n  x\n" };
    const root = fixture(sources);
    const files = Object.keys(sources);
    const first = await loadFacts(root, files);
    expect(first.report.failed).toEqual([]);
    expect(first.dirty).toEqual(files.slice().sort());
    const cached = await loadFacts(root, files);
    expect(cached.dirty).toEqual([]);
    expect(cached.store.facts.get("main.bend")).toEqual(first.store.facts.get("main.bend"));
    writeFileSync(join(root, "main.bend"), sources["main.bend"].replace("as M", "as Renamed"));
    await refreshFacts(root, cached.store, files, ["main.bend"]);
    expect(cached.store.facts.get("main.bend")!.imports[0]!.alias).toBe("Renamed");
    const graph = (await assembleGraphWithIndex(root, files, cached.store.facts)).graph;
    expect(graph.edges.filter((edge) => edge.kind === "invokes")).toEqual([]);
  });
});

describe("Bend graph integration", () => {
  it.each<Record<string, string>>([
    {},
    { "README.md": "# Native project\n", "package.json": "{}", "schema.graphql": "type Query { hello: String }" },
  ])("indexes empty and native-only roots without ast-grep: %j", async (sources) => {
    const root = fixture(sources);
    vi.stubEnv("FOVEA_AST_GREP", join(root, "missing-ast-grep"));
    const state = await ensureState(root);
    expect(state.files).toEqual(Object.keys(sources).sort());
    expect(state.extraction.failed).toEqual([]);
  });

  it("refreshes Bend without a binary, but rejects an added AST-dependent source", async () => {
    const root = fixture({ "main.bend": "def main() -> U32: 1\n" });
    vi.stubEnv("FOVEA_AST_GREP", join(root, "missing-ast-grep"));
    await ensureState(root);
    writeFileSync(join(root, "main.bend"), "def main() -> U32: helper()\ndef helper() -> U32: 1\n");
    const refreshed = await ensureState(root, { hints: ["main.bend"], force: true });
    expect(refreshed.graph.nodes.some((node) => node.name === "helper")).toBe(true);
    expect(refreshed.graph.edges.some((edge) => edge.kind === "invokes")).toBe(true);
    expect(refreshed.extraction.failed).toEqual([]);
    writeFileSync(join(root, "new.bend"), "def added() -> U32: 2\n");
    expect((await ensureState(root, { hints: ["new.bend"], force: true })).files).toContain("new.bend");
    writeFileSync(join(root, "api.ts"), "export const api = () => 1;\n");
    await expect(ensureState(root, { hints: ["api.ts"], force: true })).rejects.toThrow("no usable ast-grep binary");
    rmSync(join(root, "api.ts"));
    expect((await ensureState(root, { force: true })).extraction.failed).toEqual([]);
  });

  it("still rejects a mixed-language cold build when ast-grep is missing", async () => {
    const root = fixture({ "main.bend": "def main() -> U32: 1\n", "api.ts": "export const api = 1;\n" });
    vi.stubEnv("FOVEA_AST_GREP", join(root, "missing-ast-grep"));
    await expect(ensureState(root)).rejects.toThrow("no usable ast-grep binary");
  });

  it.skipIf(!hasAstGrep())("keeps mixed-language scans on the consolidated path", async () => {
    const root = fixture({ "main.bend": program, "api.ts": 'export function run() { return fetch("/api/shapes"); }' });
    const files = ["main.bend", "api.ts"];
    const matches = await scanRules(coreScanRules(files), files, root);
    expect(matches).toBeDefined();
    const facts = await coreFactsFromScan(files, root, makeFileSource(root), matches!);
    expect(facts.calls.some((site) => site.file === "api.ts" && site.callee === "fetch")).toBe(true);
    expect(facts.calls.some((site) => site.file === "main.bend" && site.callee === "M.square")).toBe(true);
  });

  it("discovers Bend files, focuses laws and proofs, and exposes alias-only drift without ast-grep", async () => {
    const sources = {
      "LAWS.bend": "import ./math.bend as M\nlaw square_identity:\n  for x: U32\n  {M.square(x) == x : U32}\n",
      "PROOF.bend": "import ./LAWS.bend as Laws\ndef Laws.square_identity(x):\n  {==}\n",
      "math.bend": "def square(x: U32) -> U32:\n  x\n",
    };
    const root = fixture(sources);
    vi.stubEnv("FOVEA_AST_GREP", join(root, "missing-ast-grep"));
    const state = await ensureState(root);
    expect(state.files).toEqual(Object.keys(sources).sort());
    expect(state.extraction.failed).toEqual([]);
    const law = await focus(root, "square_identity", 1200, { language: "Bend", kind: "decl", fresh: true });
    expect(law.text).toContain("LAWS.bend:2");
    const proof = await focus(root, "Laws.square_identity", 1200, { language: "Bend", kind: "function", fresh: true });
    expect(proof.text).toContain("PROOF.bend:2");
    const cascade = await impact(root, { files: ["math.bend"], includeUncommitted: false, budget: 1200 });
    expect(cascade.text).toContain("LAWS.bend");
    await sync(root, { budget: 512, steerThreshold: 0.01 }, state);
    writeFileSync(join(root, "LAWS.bend"), sources["LAWS.bend"].replace("as M", "as Other"));
    evictState(root);
    const changed = await ensureState(root);
    const drift = await sync(root, { budget: 512, steerThreshold: 0.01 }, changed);
    expect(drift.details.semanticChangedFiles).toContain("LAWS.bend");
  });
});
