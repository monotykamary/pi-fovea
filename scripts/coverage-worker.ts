// Static-only corpus worker. Never imports or executes code from the target repo.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

const [engineArg, rootArg, output] = process.argv.slice(2);
if (!engineArg || !rootArg || !output) throw Error("Expected engine, target root, output JSON");
const engine = resolve(engineArg), root = resolve(rootArg);
const load = (name: string) => import(pathToFileURL(join(engine, "src/core", name + ".ts")).href);
const { ensureState, evictState } = await load("ops");
const { revealFoveated } = await load("render");
const { heatAt } = await load("heat");
const { LANG_BY_EXT } = await load("astgrep");
const sourceFiles = ["types", "extract", "graph", "render", "ops", "build", "heat", "state"];
const sourceHash = createHash("sha256");
for (const file of sourceFiles) sourceHash.update(file).update(await readFile(join(engine, "src/core", file + ".ts")));
const started = performance.now();
const state = await ensureState(root);
const graph = state.graph;
const languageFor = (file: string): string | undefined => LANG_BY_EXT[file.split(".").pop()?.toLowerCase() ?? ""];
const files: string[] = graph.files;
const fileNodes = graph.nodes.filter((node: any) => node.kind === "file");
const represented = new Set(fileNodes.map((node: any) => node.file));
const missingFiles = files.filter(file => !represented.has(file) || !graph.byFile.get(file)?.some((i: number) => graph.nodes[i].kind === "file"));
const languageFiles: Record<string, number> = {};
for (const file of files) { const language = languageFor(file) ?? "config/protocol"; languageFiles[language] = (languageFiles[language] ?? 0) + 1; }
const imports = Object.values(state.facts).flatMap((fact: any) => fact.imports);
const exactImports = graph.edges.filter((edge: any) => edge.kind === "imports" && !edge.evidence?.possible)
  .map((edge: any) => JSON.stringify([graph.nodes[edge.a].file, graph.nodes[edge.b].file, edge.evidence?.source, edge.evidence?.strategy, edge.w])).sort();
const possibleEdges = graph.edges.filter((edge: any) => edge.evidence?.possible);

// Independent TypeScript AST oracle for the explicitly supported one-hole grammar.
// This checks candidate-family recovery, not runtime dependency correctness.
const simpleName = (node: ts.Expression): boolean => ts.isIdentifier(node) ||
  (ts.isPropertyAccessExpression(node) && !node.questionDotToken && simpleName(node.expression));
const boundsFor = (node: ts.Expression, source: ts.SourceFile): { prefix: string; suffix: string } | undefined => {
  const raw = node.getText(source);
  if (raw.includes("\\") || raw.length > 1024 || /\/\*|\/\//.test(raw)) return;
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 1 && simpleName(node.templateSpans[0]!.expression)) {
    return { prefix: node.head.text, suffix: node.templateSpans[0]!.literal.text };
  }
  const parts: ts.Expression[] = [];
  const flatten = (part: ts.Expression): void => {
    if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.PlusToken) { flatten(part.left); flatten(part.right); }
    else parts.push(part);
  };
  flatten(node);
  if ((parts.length === 2 || parts.length === 3) && ts.isStringLiteralLike(parts[0]!) && simpleName(parts[1]!) &&
    (parts.length === 2 || ts.isStringLiteralLike(parts[2]!))) {
    return { prefix: (parts[0] as ts.StringLiteralLike).text, suffix: parts.length === 3 ? (parts[2] as ts.StringLiteralLike).text : "" };
  }
};
const skipped = new Set([...state.extraction.failed, ...state.extraction.unreadable, ...state.extraction.oversized, ...state.extraction.generated]);
const families: Array<{ file: string; line: number; expression: string; targets: string[]; covered: string[] }> = [];
let oracleFiles = 0, oracleParseFailures = 0;
for (const file of files) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || skipped.has(file)) continue;
  const sourceText = await readFile(join(root, file), "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true,
    /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : file.endsWith("jsx") ? ts.ScriptKind.JSX : file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) { oracleParseFailures++; continue; }
  oracleFiles++;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0]!;
      const bounds = boundsFor(argument, source);
      if (bounds && (bounds.prefix.startsWith("./") || bounds.prefix.startsWith("../"))) {
        const normalized = posix.join(posix.dirname(file), bounds.prefix);
        const prefix = normalized === "." || normalized === "./" ? "" : normalized;
        const inPrefix = files.filter(name => name.startsWith(prefix));
        if (!prefix.startsWith("../") && prefix !== ".." && inPrefix.length <= 4096) {
          const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = new RegExp("^" + escape(prefix) + ".*" + escape(bounds.suffix) + "$", "s");
          const targets = inPrefix.filter(name => pattern.test(name) || pattern.test(name.replace(/\.tsx?$/, ".js").replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs")));
          if (targets.length && targets.length <= 32) {
            const expression = argument.getText(source).trim();
            const covered = targets.filter(target => target === file || graph.edges.some((edge: any) => edge.kind === "imports" &&
              graph.nodes[edge.a].file === file && graph.nodes[edge.b].file === target && edge.evidence?.source === expression && edge.evidence?.possible));
            families.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression, targets, covered });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const probes: any[] = [];
const measure = async (name: string, field: Float64Array, seeds: number[], budget: number) => {
  const seedSet = new Set(seeds);
  const direct = new Set<number>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") continue;
    if (seedSet.has(edge.a) && !seedSet.has(edge.b)) direct.add(edge.b);
    if (seedSet.has(edge.b) && !seedSet.has(edge.a)) direct.add(edge.a);
  }
  let maximum = 0;
  for (const value of field) maximum = Math.max(maximum, value);
  let eligible = 0;
  if (maximum > 0) for (let i = 0; i < field.length; i++) {
    if (direct.has(i) || (field[i]! / maximum >= 0.002 && field[i]! >= 1e-9)) eligible++;
  }
  const artifact = join(tmpdir(), `coverage-${probes.length}.txt`);
  const fit = revealFoveated(graph, field, { header: `corpus ${name}`, seeds, repeatNucleus: true, budget, overflowTo: artifact });
  let recovered = fit.shown, artifactHash: string | null = null;
  if (fit.overflowPath) {
    const text = await readFile(fit.overflowPath, "utf8");
    recovered = text.trimEnd().split("\n").length - 1;
    artifactHash = createHash("sha256").update(text).digest("hex");
    await rm(fit.overflowPath, { force: true });
  }
  probes.push({ name, budget, eligible, reported: fit.litTotal, shown: fit.shown, recovered,
    missing: Math.max(0, eligible - recovered), extra: Math.max(0, recovered - eligible),
    candidateOmitted: fit.candidateOmitted ?? null, tokens: fit.tokens, actualTokens: Math.ceil(fit.text.length / 4), artifactHash });
};
await measure("uniform-field display-cap stress", new Float64Array(graph.nodes.length).fill(1), [], 16000);
const codeFiles = files.filter(file => languageFor(file));
const pool = codeFiles.length ? codeFiles : files;
const seedFiles = [...new Set([pool[0], pool[Math.floor(pool.length / 2)], pool.at(-1), families[0]?.file].filter((file): file is string => !!file))];
for (const file of seedFiles) {
  const index = graph.byFile.get(file)?.find((i: number) => graph.nodes[i].kind === "file");
  if (index === undefined) continue;
  const seeds = new Float64Array(graph.nodes.length); seeds[index] = 1;
  const field = heatAt(state.csr, seeds, 2);
  for (const budget of [256, 1024]) await measure(file, field, [index], budget);
}
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).length;
const result = {
  engineFingerprint: sourceHash.digest("hex"), runtime: process.version, elapsedMs: Math.round(performance.now() - started),
  tracked, selected: files.length, selectedFiles: files, represented: represented.size, missingFiles,
  nodes: graph.nodes.length, edges: graph.edges.length, languageFiles, discovery: state.discovery, extraction: state.extraction,
  capturedImports: imports.length, importCoverage: graph.importCoverage ?? null, exactImports,
  possibleEdges: possibleEdges.length, oracleFiles, oracleParseFailures, families, probes,
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
evictState(root);
console.log(JSON.stringify({ selected: result.selected, nodes: result.nodes, probes: probes.length, families: families.length, missingFiles: missingFiles.length }));
