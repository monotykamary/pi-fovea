// Per-file extraction: symbols (ast-grep outline), imports, calls, literals.
// Pure functions of file content where possible; each stage is separately
// cached by file content hash in build.ts, which is what makes re-indexing
// incremental (dirty files only). All subprocess work is async and gated
// (see astgrep.ts); file content flows through the shared FileSource so a
// bounded hash-time prefetches are reused; overflow files are read lazily.

import {
  anonymousVariadics,
  groupByLang,
  isConfigFile,
  outline,
  outlineStructured,
  patternRunAll,
  type AgMatch,
  type OutlineFile,
  type OutlineSymbol,
  type ScanMatch,
  type ScanRule,
} from "./astgrep.js";
import { mapLimit } from "./asyncutil.js";
import { makeFileSource, type FileSource } from "./source.js";
import type {
  CallSite,
  ImportSite,
  LiteralSite,
  NodeKind,
  SymbolRec,
} from "./types.js";

type NamedSig = { name: string; kind: NodeKind };

const RX = (re: RegExp, kind: NodeKind, parentGroup?: number, nameGroup?: number) => ({ re, kind, parentGroup, nameGroup });
const SIG_RULES: Record<string, Array<{ re: RegExp; kind: NodeKind; parentGroup?: number; nameGroup?: number }>> = {
  TypeScript: [
    RX(/\bclass\s+([A-Za-z_$][\w$]*)/, "class"),
    RX(/\binterface\s+([A-Za-z_$][\w$]*)/, "interface"),
    RX(/\benum\s+([A-Za-z_$][\w$]*)/, "type"),
    RX(/\btype\s+([A-Za-z_$][\w$]*)/, "type"),
    RX(/\bfunction\s+([A-Za-z_$][\w$]*)/, "function"),
    RX(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "function"),
  ],
  JavaScript: [], // filled below (same as TypeScript)
  Tsx: [],
  Go: [
    RX(/^func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/, "method", 1, 2),
    RX(/^func\s+([A-Za-z_]\w*)/, "function"),
    RX(/^type\s+([A-Za-z_]\w*)\s+struct/, "class"),
    RX(/^type\s+([A-Za-z_]\w*)\s+interface/, "interface"),
    RX(/^type\s+([A-Za-z_]\w*)/, "type"),
  ],
  Python: [
    RX(/^\s*class\s+([A-Za-z_]\w*)/, "class"),
    RX(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"),
    RX(/^\s*([A-Za-z_]\w*)\s*=/, "decl"),
  ],
  Rust: [
    RX(/\bfn\s+([A-Za-z_]\w*)/, "function"),
    RX(/\bstruct\s+([A-Za-z_]\w*)/, "class"),
    RX(/\b(?:trait|enum|mod)\s+([A-Za-z_]\w*)/, "type"),
  ],
  Elixir: [
    RX(/^\s*defmodule\s+([\w.]+)/, "class"),
    RX(/^\s*defprotocol\s+([\w.]+)/, "interface"),
    // Named function heads carry arity (name/2): strip it for stable ids.
    RX(/^\s*def(?:p|macro|macrop)?\s+([a-z_]\w*[!?=]?)/, "function"),
  ],
  Ruby: [
    RX(/^\s*(?:class|module)\s+([\w:]+)/, "class"),
    RX(/^\s*def\s+(?:self\.)?([\w!?=]+)/, "function"),
  ],
  C: [
    RX(/^[A-Za-z_][\w\s*]*?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/, "function"),
    RX(/^\s*(?:struct|enum|union)\s+([A-Za-z_]\w*)/, "class"),
  ],
  "C++": [],
  Java: [
    RX(/\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, "class"),
  ],
  Kotlin: [],
  Lua: [RX(/\bfunction\s+([\w.:]+)/, "function")],
};
SIG_RULES["C++"] = SIG_RULES.C!;
SIG_RULES.Kotlin = SIG_RULES.Java!;
SIG_RULES.JavaScript = SIG_RULES.TypeScript!;
SIG_RULES.Tsx = SIG_RULES.TypeScript!;

const kindOf = (kind: string): NodeKind =>
  kind === "method" ? "method" : kind === "field" ? "field" : "decl";

const cleanSig = (line: string): string => {
  let s = line.trim();
  const brace = s.indexOf("{");
  if (brace > 0 && s.length > 140) s = s.slice(0, brace).trimEnd() + " { ... }";
  if (s.length > 140) s = s.slice(0, 137) + "...";
  return s;
};

const deriveName = (sig: string, lang: string, parentHint?: string): NamedSig => {
  for (const r of SIG_RULES[lang] ?? []) {
    const m = r.re.exec(sig);
    if (!m) continue;
    if (r.parentGroup && m[r.parentGroup] && m[r.nameGroup ?? 1]) {
      return { name: `${m[r.parentGroup]}.${m[r.nameGroup ?? 1]}`, kind: r.kind };
    }
    if (m[1]) return { name: parentHint ? `${parentHint}.${m[1]}` : m[1], kind: r.kind };
  }
  const first = sig.trim().split(/[\s(:={]/)[0] ?? "?";
  return { name: first.replace(/^[*&]+/, "") || "?", kind: "decl" };
};

const OUTLINE_KINDS: Record<string, NodeKind> = {
  class: "class",
  struct: "class",
  object: "class",
  interface: "interface",
  trait: "interface",
  protocol: "interface",
  enum: "type",
  type: "type",
  alias: "type",
  function: "function",
  method: "method",
  field: "field",
  property: "field",
  constant: "decl",
  variable: "decl",
};

const outlineKind = (symbol: OutlineSymbol, lang: string): NodeKind => {
  if (symbol.symbolType === "constructor") return "method";
  const mapped = OUTLINE_KINDS[symbol.symbolType];
  if (symbol.role === "member" && mapped) return mapped;
  const derived = deriveName(symbol.signature, lang).kind;
  if (derived !== "decl") return derived;
  return mapped ?? derived;
};

const identifierRe = (name: string): RegExp =>
  new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_$]|$)`);

// ast-grep --view=expanded inlines aggregate-initializer bodies into a
// variable item's name — BoringSSL's curve25519 tables land 260 KB there.
// That string is not an identifier: escaped into a RegExp it hits V8's
// "Regular expression too large" compile limit, and as a graph node it is
// noise. Reduce malformed names to their leading identifier; items with no
// identifier head carry no symbol meaning and are skipped.
const MAX_OUTLINE_NAME = 256;
const OUTLINE_NAME_MALFORMED = /[\s{}]/;
const OUTLINE_NAME_HEAD = /^[A-Za-z_$][A-Za-z0-9_$]*/;

const outlineName = (name: string): string | undefined => {
  if (name.length <= MAX_OUTLINE_NAME && !OUTLINE_NAME_MALFORMED.test(name)) return name;
  return OUTLINE_NAME_HEAD.exec(name)?.[0];
};

const topLocation = (
  item: OutlineSymbol,
  sourceLines: readonly string[],
): { line: number; sig: string } => {
  let line = item.range.start.line + 1;
  let sig = cleanSig(item.signature || item.name);
  if (item.name && (!identifierRe(item.name).test(sig) || /^@/.test(sig))) {
    const end = Math.min(sourceLines.length - 1, item.range.end?.line ?? item.range.start.line + 12);
    for (let i = item.range.start.line; i <= end; i++) {
      const candidate = sourceLines[i];
      if (candidate && identifierRe(item.name).test(candidate)) {
        line = i + 1;
        sig = cleanSig(candidate);
        break;
      }
    }
    return { line, sig };
  }
  // ast-grep >= 0.45.3 reports decorated declarations with a 0-based range
  // whose start sits on the leading decorator, not on the declared symbol.
  // The signature line still identifies the symbol itself: if the source line
  // at the range start does not carry the signature text, walk to the line
  // that does. 0.45.2 ranges already align and skip this walk.
  const startText = (sourceLines[item.range.start.line] ?? "").trim();
  const sigHead = (sig.split("\n")[0] ?? "").trim();
  if (sigHead && startText && !startText.includes(sigHead) && !sigHead.includes(startText)) {
    const end = Math.min(sourceLines.length - 1, item.range.end?.line ?? item.range.start.line + 12);
    for (let i = item.range.start.line; i <= end; i++) {
      const candidate = (sourceLines[i] ?? "").trim();
      if (candidate && (candidate.includes(sigHead) || sigHead.includes(candidate))) {
        line = i + 1;
        sig = cleanSig(sourceLines[i] ?? "");
        break;
      }
    }
  }
  return { line, sig };
};

const parseStructuredOutline = async (
  files: OutlineFile[],
  source: FileSource,
): Promise<SymbolRec[]> => {
  const out: SymbolRec[] = [];
  // Read correction source one record at a time. Keeping lines for every
  // decorated file duplicated a whole batch's source beside outline JSON.
  for (const record of files) {
    const file = record.path.replace(/^\.\//, "");
    const items: OutlineSymbol[] = [];
    for (const item of record.items) {
      const name = outlineName(item.name);
      if (name !== undefined) items.push(name === item.name ? item : { ...item, name });
    }
    // Source lines are always read: topLocation's alignment walk needs them
    // for ast-grep >= 0.45.3 decorated ranges, not just @-prefixed names.
    const sourceLines = (await source.read(file))?.split("\n") ?? [];
    const concreteParents = new Set(
      items.filter((item) => item.symbolType !== "object").map((item) => item.name),
    );
    for (const item of items) {
      const kind = outlineKind(item, record.language);
      let name = item.name;
      if (kind === "method") {
        const derived = deriveName(item.signature, record.language);
        if (derived.kind === "method" && derived.name.includes(".")) name = derived.name;
      }
      // Rust impl/object outlines repeat the concrete type. Keep its members,
      // but do not emit a duplicate parent node when the struct is local.
      if (!(item.symbolType === "object" && concreteParents.has(item.name))) {
        const location = topLocation(item, sourceLines);
        out.push({ name, kind, file, line: location.line, sig: location.sig, lang: record.language });
      }
      for (const member of item.members ?? []) {
        const memberName = outlineName(member.name);
        if (memberName === undefined) continue;
        const memberKind = outlineKind(member, record.language);
        out.push({
          name: `${item.name}.${memberName}`,
          kind: memberKind,
          file,
          line: member.range.start.line + 1,
          sig: cleanSig(member.signature || `${memberKind} ${item.name}.${memberName}`),
          lang: record.language,
        });
      }
    }
  }
  return dedupe(out, (symbol) => `${symbol.name}@${symbol.file}`);
};

const parseOutlineText = (text: string, lang: string): SymbolRec[] => {
  const out: SymbolRec[] = [];
  let file = "";
  let top: SymbolRec | undefined;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    if (/^\s*@\w/.test(raw)) continue; // decorator lines are not declarations
    const entry = /^\s*(\d+):\s(.*)$/.exec(raw);
    const child = /^(\s+)(method|field):\s(.+)$/.exec(raw);
    if (entry) {
      file = file || "";
      const sig = cleanSig(entry[2]!);
      if (!sig) continue;
      const named = deriveName(sig, lang);
      top = { name: named.name, kind: named.kind, file, line: Number(entry[1]), sig, lang };
      out.push(top);
      continue;
    }
    if (child && top) {
      for (const part of child[3]!.split(",")) {
        const name = part.trim();
        if (!name) continue;
        out.push({
          name: `${top.name}.${name}`,
          kind: kindOf(child[2]!),
          file,
          line: top.line,
          lineApproximate: true,
          sig: `${kindOf(child[2]!)} ${top.name}.${name}`,
          lang,
        });
      }
      continue;
    }
    // Otherwise: a file header line.
    file = raw.trim();
    top = undefined;
  }
  return out;
};

const defaultSource = (cwd: string): FileSource => makeFileSource(cwd);

export const extractSymbols = async (files: string[], cwd: string, source: FileSource = defaultSource(cwd)): Promise<SymbolRec[]> => {
  const out: SymbolRec[] = [];
  for (const [lang, langFiles] of groupByLang(files)) {
    const structured = await outlineStructured(langFiles, lang, cwd);
    if (structured) {
      const parsed = await parseStructuredOutline(structured, source);
      if (parsed.length || structured.some((file) => file.items.length > 0)) {
        pushAll(out, parsed);
        continue;
      }
    }
    const text = await outline(langFiles, lang, cwd);
    if (!text.trim()) continue;
    pushAll(out, parseOutlineText(text, lang));
  }
  return out.filter((symbol) => symbol.file);
};

const IMPORT_PATTERNS: Record<string, string[]> = {
  TypeScript: [
    'import $$$I from "$M"',
    "import $$$I from '$M'",
    'import "$M"',
    "import '$M'",
    // ast-grep >= current rejects 'export $$$I from ...' parse-wide; the
    // named and star forms are the valid decomposition of the same intent.
    'export { $$$I } from "$M"',
    "export { $$$I } from '$M'",
    'export * from "$M"',
    "export * from '$M'",
    'require("$M")',
  ],
  Go: ['import "$M"', 'import ( $$$S )'],
  Python: ["import $M", "from $M import $$$I"],
  Rust: ["use $M;"],
};
IMPORT_PATTERNS.JavaScript = IMPORT_PATTERNS.TypeScript!;
IMPORT_PATTERNS.Tsx = IMPORT_PATTERNS.TypeScript!;

const importsFromMatches = (matches: readonly AgMatch[]): ImportSite[] => {
  const out: ImportSite[] = [];
  for (const m of matches) {
    const spec = m.single.M;
    if (spec) {
      out.push({ file: m.file, spec, line: m.line });
      continue;
    }
    // Go import block: pull quoted specs out of the captured block text.
    for (const blockText of [m.text, ...(m.multi.S ?? [])]) {
      for (const sm of blockText.matchAll(/"([^"\n]+)"/g)) {
        out.push({ file: m.file, spec: sm[1]!, line: m.line });
      }
    }
  }
  return dedupe(out, (i) => `${i.file}|${i.spec}|${i.line}`);
};

export const extractImports = async (files: string[], cwd: string): Promise<ImportSite[]> => {
  const perLang = await Promise.all([...groupByLang(files)].map(([lang, langFiles]) =>
    patternRunAll(IMPORT_PATTERNS[lang] ?? [], lang, langFiles, cwd),
  ));
  const matches: AgMatch[] = [];
  for (const local of perLang) pushAll(matches, local);
  return importsFromMatches(matches);
};

const CALL_PATTERNS = ["$O.$M($$$A)", "$F($$$A)"];

// Language builtins and log/test-framework entry points resolve to mega-hubs
// on real repos (python `str(`, jest `it(`, fmt.Sprintf, rust unwrap).
// They carry no cross-file meaning; exclude them at extraction.
const CALL_WARDS = new Set([
  // generic member-call noise and loggers
  "log", "info", "warn", "debug", "trace", "close", "flush", "tostring", "valueof",
  "tolowercase", "touppercase", "printf", "sprintf", "fprintf", "errorf",
  "fatal", "fatalf", "panic", "panicf", "println", "print",
  // JS/TS runtime + test frameworks
  "require", "console", "settimeout", "setinterval", "cleartimeout", "clearinterval",
  "queuemicrotask", "parseint", "parsefloat", "isnan", "isfinite",
  "it", "describe", "test", "expect", "xit", "xdescribe",
  "beforeeach", "aftereach", "beforeall", "afterall",
  "jest", "vitest", "vi", "mock", "spyon",
  // python builtins
  "str", "int", "float", "bool", "bytes", "bytearray", "list", "dict", "set",
  "tuple", "frozenset", "super", "isinstance", "issubclass", "getattr", "setattr",
  "hasattr", "delattr", "open", "range", "enumerate", "zip", "sorted", "next",
  "all", "any", "sum", "abs", "round", "format", "chr", "ord", "hex", "oct",
  "bin", "id", "input", "vars", "dir", "callable", "hash", "object", "property",
  "staticmethod", "classmethod", "memoryview", "slice", "type", "repr", "len",
  // go builtins
  "append", "cap", "clear", "delete", "make", "new", "copy", "complex", "real",
  "imag", "recover", "min", "max",
  // rust std noise
  "unwrap", "expect", "clone", "into", "from", "collect", "iter", "eprintln",
  "format", "vec", "assert", "asserteq", "assertne", "dbg",
]);
const CALL_WARD_PATTERN = `^(?i:${[...CALL_WARDS].join("|")})$`;

const isTestFile = (file: string): boolean =>
  /(^|\/)(test_|conftest)|\.(test|spec)\.[tj]sx?$|_test\.go$/.test(file);

export { isTestFile };

const callsFromMatches = (matches: readonly AgMatch[]): CallSite[] => {
  const out: CallSite[] = [];
  for (const m of matches) {
    const callee = m.single.M ?? m.single.F;
    if (!callee) continue;
    const name = callee.trim();
    if (CALL_WARDS.has(name.toLowerCase())) continue;
    if (name.length > 1) out.push({ file: m.file, line: m.line, callee: name });
  }
  return out;
};

export const extractCalls = async (files: string[], cwd: string): Promise<CallSite[]> => {
  const perLang = await Promise.all([...groupByLang(files)].map(([lang, langFiles]) =>
    patternRunAll(CALL_PATTERNS, lang, langFiles, cwd),
  ));
  const matches: AgMatch[] = [];
  for (const local of perLang) pushAll(matches, local);
  return callsFromMatches(matches);
};

const STRING_PATTERNS: Record<string, string[]> = {
  TypeScript: ['"$S"', "'$S'", "`$S`"],
  Go: ['"$S"', "`$S`"],
  Python: ['"$S"', "'$S'"],
  Rust: ['"$S"'],
};
STRING_PATTERNS.JavaScript = STRING_PATTERNS.TypeScript!;
STRING_PATTERNS.Tsx = STRING_PATTERNS.TypeScript!;

const QUOTED_RE = /"([^"\n]{2,200})"|'([^'\n]{2,200})'/g;
const TEMPLATE_RE = /`([^`\n]{2,200})`/g;
export const PATH_TOKEN_RE = /^(?:\/[\w.~+\-{}*:$]+\/?|\/?[\w.~+\-]+(?:\/[\w.~+\-{}*:$]+)+\/?)$/;
export const ENV_TOKEN_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// Config files can't be parsed as code; scan quoted strings plus bare
// path/env-shaped scalars so OpenAPI paths and k8s env keys still join.
const CONFIG_BARE_RE = /(^|[:=\s])(\/[\w.~+\-{}*]+(?:\/[\w.~+\-{}*]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=$|[:=\s])/g;

const SOURCE_SCAN_CONCURRENCY = 8;

const extractConfigLiterals = async (files: string[], cwd: string, source: FileSource = defaultSource(cwd)): Promise<LiteralSite[]> => {
  const configs = files.filter(isConfigFile);
  const perFile = await mapLimit(configs, SOURCE_SCAN_CONCURRENCY, async (f) => {
    const local: LiteralSite[] = [];
    const text = await source.read(f);
    if (text === undefined) return local;
    const seenLine = new Set<string>();
    text.split("\n").forEach((lineText, i) => {
      QUOTED_RE.lastIndex = 0;
      for (let q; (q = QUOTED_RE.exec(lineText)); ) {
        const t = q[1] ?? q[2];
        if (t && !seenLine.has(`${i}|${t}`)) {
          seenLine.add(`${i}|${t}`);
          local.push({ file: f, line: i + 1, text: t });
        }
      }
      CONFIG_BARE_RE.lastIndex = 0;
      for (let b; (b = CONFIG_BARE_RE.exec(lineText)); ) {
        const t = b[2]!;
        if ((PATH_TOKEN_RE.test(t) || ENV_TOKEN_RE.test(t)) && !seenLine.has(`${i}|${t}`)) {
          seenLine.add(`${i}|${t}`);
          local.push({ file: f, line: i + 1, text: t });
        }
      }
    });
    return local;
  });
  const out: LiteralSite[] = [];
  for (const local of perFile) pushAll(out, local);
  return out;
};

const stripQuotes = (text: string): string => {
  if (text.length >= 2) {
    const a = text[0]!;
    const b = text[text.length - 1]!;
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === "`" && b === "`")) {
      const inner = text.slice(1, -1).trim();
      return inner.length >= 2 && inner.length <= 200 ? inner : "";
    }
  }
  return "";
};

const literalsFromMatches = (matches: readonly AgMatch[]): LiteralSite[] => {
  const out: LiteralSite[] = [];
  for (const m of matches) {
    const text = stripQuotes(m.text);
    if (text) out.push({ file: m.file, line: m.line, text });
  }
  return out;
};

const completeLiterals = async (
  files: string[],
  cwd: string,
  source: FileSource,
  out: LiteralSite[],
): Promise<LiteralSite[]> => {
  pushAll(out, await extractConfigLiterals(files, cwd, source));
  const codeFiles = files.filter((f) => !isConfigFile(f));
  const templateSites = await mapLimit(codeFiles, SOURCE_SCAN_CONCURRENCY, async (f) => {
    const local: LiteralSite[] = [];
    const src = await source.read(f);
    if (src === undefined) return local;
    src.split("\n").forEach((lineText, i) => {
      TEMPLATE_RE.lastIndex = 0;
      for (let m; (m = TEMPLATE_RE.exec(lineText)); ) {
        const text = m[1]!.trim();
        if (text.length >= 2) local.push({ file: f, line: i + 1, text });
      }
    });
    return local;
  });
  for (const local of templateSites) pushAll(out, local);
  return dedupe(out, (literal) => `${literal.file}|${literal.line}|${literal.text}`);
};

export const extractLiterals = async (files: string[], cwd: string, source: FileSource = defaultSource(cwd)): Promise<LiteralSite[]> => {
  const perLang = await Promise.all([...groupByLang(files)].map(([lang, langFiles]) =>
    patternRunAll(STRING_PATTERNS[lang] ?? [], lang, langFiles, cwd),
  ));
  const matches: AgMatch[] = [];
  for (const local of perLang) pushAll(matches, local);
  return completeLiterals(files, cwd, source, literalsFromMatches(matches));
};

const CORE_IMPORT_PREFIX = "fovea-core-import-";
const CORE_CALL_PREFIX = "fovea-core-call-";
const CORE_LITERAL_PREFIX = "fovea-core-literal-";

export const coreScanRules = (files: string[]): ScanRule[] => {
  const rules: ScanRule[] = [];
  let ordinal = 0;
  const add = (
    prefix: string,
    language: string,
    pattern: string,
    constraints?: ScanRule["constraints"],
  ): void => {
    rules.push({
      id: `${prefix}${ordinal++}`,
      language,
      pattern: anonymousVariadics(pattern),
      ...(constraints ? { constraints } : {}),
    });
  };
  for (const [language] of groupByLang(files)) {
    for (const pattern of IMPORT_PATTERNS[language] ?? []) add(CORE_IMPORT_PREFIX, language, pattern);
    for (const pattern of CALL_PATTERNS) {
      const metavar = pattern.startsWith("$O.") ? "M" : "F";
      add(CORE_CALL_PREFIX, language, pattern, { [metavar]: { not: { regex: CALL_WARD_PATTERN } } });
    }
    for (const pattern of STRING_PATTERNS[language] ?? []) add(CORE_LITERAL_PREFIX, language, pattern);
  }
  return rules;
};

export interface ScannedCoreFacts {
  imports: ImportSite[];
  calls: CallSite[];
  literals: LiteralSite[];
}

export const coreFactsFromScan = async (
  files: string[],
  cwd: string,
  source: FileSource,
  matches: readonly ScanMatch[],
): Promise<ScannedCoreFacts> => {
  const imports: ScanMatch[] = [];
  const calls: ScanMatch[] = [];
  const literals: ScanMatch[] = [];
  for (const match of matches) {
    if (match.ruleId.startsWith(CORE_IMPORT_PREFIX)) imports.push(match);
    else if (match.ruleId.startsWith(CORE_CALL_PREFIX)) calls.push(match);
    else if (match.ruleId.startsWith(CORE_LITERAL_PREFIX)) literals.push(match);
  }
  return {
    imports: importsFromMatches(imports),
    calls: callsFromMatches(calls),
    literals: await completeLiterals(files, cwd, source, literalsFromMatches(literals)),
  };
};

// Spread-pushing big arrays overflows the argument-list limit on large repos.
const pushAll = <T>(out: T[], more: T[]): void => { for (const x of more) out.push(x); };

const dedupe = <T>(arr: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};
