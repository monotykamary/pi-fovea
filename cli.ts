#!/usr/bin/env tsx
// pi-fovea CLI — the extension without pi, for agent shells and pipes:
//   fovea status [root]
//   fovea sketch [root] [budget]
//   fovea focus [root] <query> [budget]
//   fovea dwell [root] [factor] [budget]     (deepens the in-process focus)
//   fovea impact [root] [--files a,b] [--symbols x,y] [--base ref] [--no-uncommitted] [budget]
//   fovea anchors [root] [filter]             (every feature anchor, sorted)
//   fovea rules [root]                        (tier-3 discovered shape hypotheses)
//
// The CLI is stateless across invocations (dwell needs a prior focus in the
// same process — combine ops inside pi, where sessions persist); stdout is
// the rendered field, nothing else, so it composes with head/grep/$().

import { statSync } from "node:fs";
import { coverageSummary, ensureState, sketch, focus, dwell, impact } from "./src/core/ops.js";
import { aggregateFiles, posterior, promote } from "./src/core/discover.js";
import { DEFAULT_PACK } from "./src/core/anchors.js";

const [, , cmd = "status", ...argv] = process.argv;

const VALUE_FLAGS = new Set(["files", "symbols", "base"]);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) flags.set(name, argv[++i] ?? "");
    else flags.set(name, true);
  } else {
    pos.push(a);
  }
}
const str = (name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};
const numAt = (i: number): number | undefined => {
  const n = Number(pos[i]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
// Root is the first positional that names a path; everything else is arg data.
// Existing directories count as paths even when bare ("next", "kernel").
const rootAt = (i: number): string => {
  const p = pos[i];
  if (p === undefined) return ".";
  if (p.includes("/") || p === ".") return p;
  try {
    if (statSync(p).isDirectory()) return p;
  } catch { /* not a path */ }
  return ".";
};

try {
  let out = "";
  if (cmd === "status") {
    const s = await sketch(rootAt(0), 256);
    const testAnchors = Number(s.details.testAnchors ?? 0);
    const failed = Number(s.details.extractionFailures ?? 0);
    const unreadable = Array.isArray(s.details.extractionUnreadable) ? s.details.extractionUnreadable.length : 0;
    const oversized = Array.isArray(s.details.extractionOversized) ? s.details.extractionOversized.length : 0;
    const generated = Array.isArray(s.details.extractionGenerated) ? s.details.extractionGenerated.length : 0;
    out = `${coverageSummary(s.details)}, ${s.details.nodes} symbols, ${s.details.productionAnchors ?? s.details.anchors} production anchors` +
      (testAnchors ? `, ${testAnchors} test/fixture anchors collapsed` : "") +
      (failed ? `, !${failed} files failed extraction` : "") +
      (unreadable ? `, !${unreadable} files unreadable` : "") +
      (oversized ? `, !${oversized} files over size cap` : "") +
      (generated ? `, !${generated} generated files skipped` : "");
  } else if (cmd === "sketch") {
    const root = rootAt(0);
    const B = numAt(pos[0] === root && pos.length > 1 ? 1 : 0) ?? 512;
    out = (await sketch(root, B)).text;
  } else if (cmd === "focus") {
    const root = rootAt(0);
    const q = pos[0] !== root ? pos[0] : pos[1];
    if (!q) { console.error("fovea focus <query>"); process.exit(2); }
    const bi = pos.indexOf(q) + 1;
    out = (await focus(root, q, numAt(bi) ?? 512)).text;
  } else if (cmd === "dwell") {
    const root = rootAt(0);
    const factor = numAt(pos[0] === root ? 1 : 0) ?? 2;
    const B = numAt(pos[0] === root ? 2 : 1) ?? 512;
    out = (await dwell(root, factor, B)).text;
  } else if (cmd === "impact") {
    const root = rootAt(0);
    const B = pos[0] === root ? numAt(1) : numAt(0);
    out = (await impact(root, {
      files: str("files")?.split(",").filter(Boolean),
      symbols: str("symbols")?.split(",").filter(Boolean),
      base: str("base"),
      includeUncommitted: !flags.has("no-uncommitted"),
      budget: B ?? 512,
    })).text;
  } else if (cmd === "anchors") {
    const root = rootAt(0);
    const filter = pos.find((p) => p !== root);
    const rows = (await ensureState(root)).graph.anchors
      .map((a) => `${a.implicit ? "△" : " "}\t${a.kind}\t${a.id}\t${a.file}:${a.line}`)
      .filter((r) => (!filter || r.includes(filter)) && (!flags.has("discovered") || r.startsWith("△")))
      .sort();
    out = rows.join("\n");
  } else if (cmd === "rules") {
    const root = rootAt(0);
    const st = await ensureState(root);
    const sigs = aggregateFiles(Object.fromEntries(Object.entries(st.facts).map(([k, v]) => [k, v.sigs])));
    const promoted = promote(sigs, DEFAULT_PACK);
    if (flags.has("adopt") && promoted.length) {
      const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      mkdirSync(join(root, ".fovea"), { recursive: true });
      const rulesFile = join(root, ".fovea", "rules.json");
      let existing = { rules: [] as unknown[] };
      try { existing = JSON.parse(readFileSync(rulesFile, "utf8")); } catch { /* new */ }
      const stamp = promoted.map((r) => ({
        id: r.id.slice("implicit:".length),
        langs: r.langs,
        pattern: r.patterns[0],
        methods: r.methods,
        kind: r.kind,
      }));
      existing.rules = [...existing.rules, ...stamp];
      writeFileSync(rulesFile, JSON.stringify(existing, null, 2) + "\n");
      out = `wrote ${stamp.length} discovered rule(s) to .fovea/rules.json`;
    } else if (flags.has("sigs")) {
      out = sigs.filter((s) => s.pathN > 0)
        .sort((a, b) => posterior(b.pathN, b.n) - posterior(a.pathN, a.n))
        .map((s) => `${posterior(s.pathN, s.n).toFixed(2)}  ${s.pathN}/${s.n} across ${s.files} files  ${s.key}`)
        .join("\n");
    } else if (!promoted.length) {
      out = "(no unknown shape passes the promotion floor — tier-1/2 coverage is doing fine)";
    } else {
      out = promoted.map((r) => JSON.stringify({
        id: r.id.slice("implicit:".length),
        langs: r.langs,
        pattern: r.patterns[0],
        methods: r.methods.replace(/\(\?i\)/, ""),
        kind: r.kind,
        _evidence: `p̂=${r.evidence.posterior.toFixed(2)} (${r.evidence.pathN}/${r.evidence.n} sites, ${r.evidence.files} files)`,
      })).join("\n");
    }
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
  console.log(out);
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
