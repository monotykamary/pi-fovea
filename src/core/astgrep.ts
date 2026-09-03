// Thin runner over the ast-grep CLI. All extraction goes through here.
// Resolution: FOVEA_AST_GREP env var, then `ast-grep` on PATH.
//
// Everything is async and gated: a cold build fans chunk invocations out to
// SPAWN_CONCURRENCY processes instead of serializing spawnSync behind the
// TUI's event loop; the loop never stalls waiting on a child process.

import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPAWN_CONCURRENCY, envInt, mapLimit, spawnGate } from "./asyncutil.js";

export const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "Tsx", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "Tsx", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  // Second tier: symbols via ast-grep outline; name derivation is heuristic.
  ex: "Elixir", exs: "Elixir",
  rb: "Ruby",
  c: "C", h: "C",
  cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  java: "Java",
  kt: "Kotlin", kts: "Kotlin",
  lua: "Lua",
  php: "Php",
  swift: "Swift",
  scala: "Scala",
  hs: "Haskell",
  sh: "Bash",
};

// Compiled artifacts masquerading as source extensions.
const BINARY_EXTS = new Set(["beam", "pyc", "o", "obj", "so", "a", "d"]);
export const isBinaryExt = (file: string): boolean =>
  BINARY_EXTS.has(file.split(".").pop()?.toLowerCase() ?? "");

// Non-code files: literals are regex-extracted so config/spec files can join.
const CONFIG_EXTS = new Set([
  "yaml", "yml", "json", "toml", "env", "tf", "hcl", "md",
  // Parsed by the exact protocol readers; kept out of ast-grep language scans.
  "proto", "graphql", "gql",
]);

export interface AgMatch {
  file: string;                    // as passed to ast-grep (repo-relative)
  line: number;                    // 1-indexed
  text: string;                    // full matched node text
  single: Record<string, string>;  // $VAR -> text (single metavars)
  /** Line (1-indexed) of each single capture; 0 when the raw match lacks ranges. */
  singleLines: Record<string, number>;
  multi: Record<string, Array<{ text: string; line: number }>>; // $$$VAR -> occurrences
}

interface ScanConstraint {
  regex?: string;
  not?: ScanConstraint;
  all?: ScanConstraint[];
}

export interface ScanRule {
  id: string;
  language: string;
  pattern: string;
  constraints?: Record<string, ScanConstraint>;
}

export interface ScanMatch extends AgMatch {
  ruleId: string;
}

/** Drop redundant named variadic captures while preserving matching and match text. */
export const anonymousVariadics = (pattern: string): string =>
  pattern.replace(/\$\$\$[A-Za-z_][A-Za-z0-9_]*/g, () => "$$$");

const binary = (): string => process.env.FOVEA_AST_GREP ?? "ast-grep";

// One spawnSync probe per binary path, memoized: ensureState used to pay a
// ~40ms subprocess on EVERY invocation. Success is sticky; failures re-probe
// after a short TTL so an install mid-session self-heals without a reload.
const availability = new Map<string, { ok: boolean; at: number }>();
const availabilityInflight = new Map<string, Promise<boolean>>();
const FAILURE_TTL_MS = 15_000;

export const hasAstGrep = (): boolean => {
  const bin = binary();
  const hit = availability.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) return hit.ok;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const ok = !r.error && r.status === 0;
  availability.set(bin, { ok, at: Date.now() });
  return ok;
};

/** Non-blocking availability probe for extension hooks and graph builds. */
export const hasAstGrepAsync = (): Promise<boolean> => {
  const bin = binary();
  const hit = availability.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) return Promise.resolve(hit.ok);
  const pending = availabilityInflight.get(bin);
  if (pending) return pending;
  const probe = spawnGate.run(
    () => new Promise<boolean>((resolve) => {
      execFile(bin, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (error) => {
        resolve(!error);
      });
    }),
  ).then((ok) => {
    availability.set(bin, { ok, at: Date.now() });
    return ok;
  }).finally(() => availabilityInflight.delete(bin));
  availabilityInflight.set(bin, probe);
  return probe;
};

// Import-file argument lists on Windows cap around 8k chars; keep chunks
// conservative. Extraction batches align to this boundary so each consolidated
// scan normally pays one process.
export const AST_GREP_CHUNK = envInt("FOVEA_AST_GREP_CHUNK", 160, 32, 2048);

// Extraction honesty ledger: a failed ast-grep invocation implicates every
// file in its chunk. build.ts drains this once per fact pass and folds it
// into the extraction report surfaced by tools, /fovea status, `fovea status`.
export interface ExtractionFailure {
  op: "outline" | "outline-structured" | "run";
  lang?: string;
  files: string[];
}
const failures: ExtractionFailure[] = [];
const recordFailure = (op: ExtractionFailure["op"], files: string[], lang?: string): void => {
  failures.push({ op, lang, files });
};
export const drainExtractionFailures = (): ExtractionFailure[] => failures.splice(0, failures.length);

const RUN_TIMEOUT = 120_000;
// 160-file chunks answer a few MB typically; the cap exists so a pathological
// JSON dump fails one chunk instead of inflating the gate's resident set.
const RUN_MAX_BUFFER = 16 * 1024 * 1024;

interface RunResult { ok: boolean; stdout: string; split: boolean }

const run = async (args: string[], cwd: string): Promise<RunResult> =>
  spawnGate.run(
    () =>
      new Promise<RunResult>((resolve) => {
        execFile(
          binary(),
          args,
          { cwd, encoding: "utf8", timeout: RUN_TIMEOUT, maxBuffer: RUN_MAX_BUFFER },
          (error, stdout, stderr) => {
            // A maxBuffer breach is a memory guard, not an extraction error:
            // rerun smaller chunks until each response fits the same ceiling.
            if (error && (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error.code === "E2BIG")) {
              resolve({ ok: false, stdout: "", split: true });
              return;
            }
            // Spawn errors surface a non-numeric code (ENOENT/EACCES); a
            // numeric code is a real process exit. Killed/signaled = timeout.
            if (error && typeof error.code !== "number") {
              resolve({ ok: false, stdout: "", split: false });
              return;
            }
            const status = (error && typeof error.code === "number" ? error.code : 0) as number;
            if (status !== 0) {
              // grep convention: `ast-grep run` exits 1 silently on zero
              // matches, so a bare non-zero status is not a failure. Only a
              // verbose one is.
              if ((stderr ?? "").trim()) {
                resolve({ ok: false, stdout: "", split: false });
                return;
              }
              resolve({ ok: true, stdout: "", split: false });
              return;
            }
            resolve({ ok: true, stdout: stdout ?? "", split: false });
          },
        );
      }),
  );

export const langOf = (file: string): string | undefined => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
};

export const isConfigFile = (file: string): boolean => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONFIG_EXTS.has(ext);
};

export const groupByLang = (files: string[]): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const lang = langOf(f);
    if (!lang) continue;
    const arr = m.get(lang) ?? [];
    arr.push(f);
    m.set(lang, arr);
  }
  return m;
};

// `ast-grep outline` is the uniform symbol source across languages.
// Expanded JSON is primary; the legacy text view remains as a compatibility fallback.
interface OutlineRange {
  start: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface OutlineSymbol {
  role: "item" | "member";
  symbolType: string;
  name: string;
  range: OutlineRange;
  signature: string;
  astKind?: string;
  members?: OutlineSymbol[];
}

export interface OutlineFile {
  path: string;
  language: string;
  items: OutlineSymbol[];
}

// Chunks of one stage fan out concurrently, bounded by the shared spawn gate.
// Order is preserved (mapLimit keeps indices) so concatenated text output
// stays deterministic for the outline parser.
const runChunked = async (
  files: string[],
  chunkArgs: (chunk: string[]) => string[],
  cwd: string,
): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += AST_GREP_CHUNK) chunks.push(files.slice(i, i + AST_GREP_CHUNK));
  const adaptive = async (chunk: string[]): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
    const result = await run(chunkArgs(chunk), cwd);
    if (!result.split || chunk.length === 1) return [{ chunk, result }];
    const middle = Math.ceil(chunk.length / 2);
    const halves = await Promise.all([
      adaptive(chunk.slice(0, middle)),
      adaptive(chunk.slice(middle)),
    ]);
    return [...halves[0], ...halves[1]];
  };
  const settled = await mapLimit(chunks, SPAWN_CONCURRENCY, adaptive);
  return settled.flat();
};

// Expanded JSON preserves each member's own range and signature. Return
// undefined when the installed ast-grep predates this interface so callers can
// fall back without presenting parent locations as exact member locations.
export const outlineStructured = async (files: string[], _lang: string, cwd: string): Promise<OutlineFile[] | undefined> => {
  const out: OutlineFile[] = [];
  // A subprocess failure here is NOT recorded: extractSymbols falls back to
  // the text outline for old ast-grep versions, and that text run is what
  // records a genuine failure (old versions must not read as failures).
  const settled = await runChunked(
    files,
    (chunk) => ["outline", "--json=compact", "--view=expanded", ...chunk],
    cwd,
  );
  for (const { result } of settled) {
    if (!result.stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as OutlineFile[];
      if (!Array.isArray(parsed)) return undefined;
      for (const file of parsed) out.push(file);
    } catch {
      return undefined;
    }
  }
  return out;
};

export const outline = async (files: string[], lang: string, cwd: string): Promise<string> => {
  let out = "";
  const settled = await runChunked(files, (chunk) => ["outline", ...chunk], cwd);
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("outline", chunk, lang);
      continue;
    }
    out += result.stdout;
  }
  return out;
};

interface RawMatch {
  text: string;
  range: { start: { line: number; column: number } };
  file: string;
  metaVariables?: {
    single?: Record<string, { text: string; range?: { start: { line: number } } }>;
    multi?: Record<string, Array<{ text: string; range?: { start: { line: number } } }>>;
  };
}

interface RawScanMatch extends RawMatch { ruleId: string }

const fromRawMatch = (m: RawMatch): AgMatch => {
  const single: Record<string, string> = {};
  const singleLines: Record<string, number> = {};
  const multi: Record<string, Array<{ text: string; line: number }>> = {};
  for (const [key, value] of Object.entries(m.metaVariables?.single ?? {})) {
    single[key] = value.text;
    singleLines[key] = value.range ? value.range.start.line + 1 : 0;
  }
  for (const [key, value] of Object.entries(m.metaVariables?.multi ?? {}))
    multi[key] = value.map((item) => ({ text: item.text, line: item.range ? item.range.start.line + 1 : 0 }));
  return { file: m.file, line: m.range.start.line + 1, text: m.text, single, singleLines, multi };
};

const scanSupport = new Map<string, { ok: boolean; at: number }>();
const scanSupportInflight = new Map<string, Promise<boolean>>();

const hasRuleScan = (): Promise<boolean> => {
  const bin = binary();
  const hit = scanSupport.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) return Promise.resolve(hit.ok);
  const pending = scanSupportInflight.get(bin);
  if (pending) return pending;
  const probe = spawnGate.run(
    () => new Promise<boolean>((resolve) => {
      execFile(bin, ["scan", "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (error) => {
        resolve(!error);
      });
    }),
  ).then((ok) => {
    scanSupport.set(bin, { ok, at: Date.now() });
    return ok;
  }).finally(() => scanSupportInflight.delete(bin));
  scanSupportInflight.set(bin, probe);
  return probe;
};

const scanRuleFiles = new Map<string, Promise<string>>();

const materializeRuleFile = (rules: readonly ScanRule[]): Promise<string> => {
  const key = JSON.stringify(rules);
  const hit = scanRuleFiles.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-fovea-scan-"));
    const documents = rules.map(({ id, language, pattern, constraints }) => JSON.stringify({
      id,
      language,
      rule: { pattern },
      ...(constraints ? { constraints } : {}),
    }));
    const rulePath = join(root, "rules.yml");
    await writeFile(rulePath, documents.join("\n---\n"));
    return rulePath;
  })();
  scanRuleFiles.set(key, pending);
  return pending;
};

const scanChunk = (
  rulePath: string,
  files: string[],
  cwd: string,
): Promise<ScanMatch[] | undefined> => spawnGate.run(
  () => new Promise<ScanMatch[] | undefined>((resolve) => {
    const child = spawn(
      binary(),
      ["scan", "--rule", rulePath, "--json=stream", ...files],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const matches: ScanMatch[] = [];
    let carry = "";
    let parseFailed = false;
    let timedOut = false;
    let settled = false;
    const finish = (value: ScanMatch[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const accept = (line: string): void => {
      if (!line || parseFailed) return;
      try {
        const raw = JSON.parse(line) as RawScanMatch;
        if (!raw.ruleId || !raw.range?.start || typeof raw.file !== "string") {
          parseFailed = true;
          return;
        }
        matches.push({ ...fromRawMatch(raw), ruleId: raw.ruleId });
      } catch {
        parseFailed = true;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (carry + chunk).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) accept(line);
    });
    child.stderr.resume();
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (carry.trim()) accept(carry);
      finish(code === 0 && !timedOut && !parseFailed ? matches : undefined);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT);
    timer.unref?.();
  }),
);

/**
 * Run a mixed-language rule set in one ast-grep parse per file chunk.
 * Undefined means the optimized interface was unavailable or failed; callers
 * then use the legacy per-pattern path, preserving compatibility and partial
 * extraction behavior for malformed repository rules.
 */
export const scanRules = async (
  rules: readonly ScanRule[],
  files: string[],
  cwd: string,
): Promise<ScanMatch[] | undefined> => {
  if (!rules.length || !files.length) return [];
  if (!(await hasRuleScan())) return undefined;
  let rulePath: string;
  try {
    rulePath = await materializeRuleFile(rules);
  } catch {
    return undefined;
  }
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += AST_GREP_CHUNK) {
    chunks.push(files.slice(i, i + AST_GREP_CHUNK));
  }
  const settled = await mapLimit(chunks, SPAWN_CONCURRENCY, (chunk) =>
    scanChunk(rulePath, chunk, cwd),
  );
  if (settled.some((matches) => matches === undefined)) return undefined;
  const out: ScanMatch[] = [];
  for (const matches of settled) for (const match of matches!) out.push(match);
  return out;
};

// `ast-grep run --pattern` with JSON output for a set of files of one language.
const patternRun = async (
  pattern: string,
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const out: AgMatch[] = [];
  const settled = await runChunked(
    files,
    (chunk) => ["run", "--pattern", pattern, "--lang", lang, "--json=compact", ...chunk],
    cwd,
  );
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!result.stdout.trim()) continue;
    let parsed: RawMatch[];
    try {
      parsed = JSON.parse(result.stdout) as RawMatch[];
    } catch {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!Array.isArray(parsed)) {
      recordFailure("run", chunk, lang);
      continue;
    }
    for (const m of parsed) out.push(fromRawMatch(m));
  }
  return out;
};

// First match of any of the patterns, per language/file set, concatenated.
// Patterns run concurrently (bounded by the spawn gate): per-stage latency
// collapses from O(patterns * chunks) processes-sequential to ~the slowest
// slice of chunks wide SPAWN_CONCURRENCY.
export const patternRunAll = async (
  patterns: string[],
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const perPattern = await mapLimit(patterns, patterns.length || 1, (p) => patternRun(p, lang, files, cwd));
  const out: AgMatch[] = [];
  for (const matches of perPattern) for (const m of matches) out.push(m);
  return out;
};
