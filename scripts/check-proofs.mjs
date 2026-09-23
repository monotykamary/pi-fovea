#!/usr/bin/env node
// Check, never rewrite, unless --write was explicitly requested.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { compileKernel, toolchain } from "./compile-bend.mjs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const receipt = "src/verified/generated/manifest.json";
const outputs = ["src/verified/generated/kernel.js", "src/verified/generated/kernel.d.ts"];
const bridgeSources = ["scripts/check-proofs.mjs", "scripts/compile-bend.mjs", "proofs/kernel-abi.json", "proofs/kernel-types.d.ts", "src/verified/policy.ts", "src/core/disclosure.ts"];
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !["--write", "--artifact"].includes(args[0]))) {
  throw new Error("usage: node scripts/check-proofs.mjs [--write|--artifact]");
}
const mode = args[0] ?? "--check";
const read = path => readFileSync(resolve(root, path), "utf8");
const hash = text => createHash("sha256").update(text).digest("hex");
const hashes = paths => Object.fromEntries(paths.map(path => [path, hash(read(path))]));
const bend = (args) => execFileSync(process.env.BEND ?? "bend", args, {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, BEND_NO_TELEMETRY: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 60_000,
  maxBuffer: 16 * 1024 * 1024,
});

// Mask comments and quoted literals, preserving line boundaries. This is a
// deliberately restricted import policy, not an alternative Bend parser.
const codeOnly = source => source.replace(
  /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
  token => token.replace(/[^\n]/g, " "),
);
const unsafeBaseNames = ["Array.fork", "Array.join"];
const unsafeAnnotation = /@\s*unsafe\b/;
const unsafeBaseUse = /\bArray\s*\.\s*(?:fork|join)\b/;

const checkLocalSafety = () => {
  const base = realpathSync(root);
  const visited = new Map();
  const inside = path => {
    const rel = relative(base, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Bend imports must stay inside the repository: ${path}`);
    }
    return path;
  };
  const visit = path => {
    // Check both lexical traversal and symlink resolution before reading.
    const file = inside(realpathSync(inside(resolve(path))));
    if (visited.has(file)) return visited.get(file);
    const code = codeOnly(readFileSync(file, "utf8"));
    visited.set(file, code);
    const name = relative(base, file);
    if (unsafeAnnotation.test(code)) throw new Error(`${name}: @unsafe is forbidden`);
    if (unsafeBaseUse.test(code)) throw new Error(`${name}: unsafe Base primitive is forbidden`);
    for (const line of code.split("\n")) {
      if (!/\bimport\b/.test(line)) continue;
      const statement = line.trim();
      if (statement === "import Base") continue;
      const local = /^import ((?:\.\/|\.\.\/)[\w./-]+\.bend)(?: as [A-Za-z_][\w.]*)?\s*$/.exec(statement);
      if (!local) throw new Error(`${name}: only Base and local .bend imports are allowed`);
      visit(resolve(dirname(file), local[1]));
    }
    return code;
  };
  for (const entry of ["LAWS.bend", "PROOF.bend", "proofs/kernel.bend"]) visit(resolve(base, entry));
  return [...visited.keys()].map(file => relative(base, file).split(sep).join("/")).sort();
};

const checkBaseSafety = source => {
  const code = codeOnly(source);
  const annotations = [...code.matchAll(/@\s*unsafe\b/g)];
  const names = [...code.matchAll(/@\s*unsafe\s+def\s+([\w.]+)/g)].map(match => match[1]).sort();
  if (annotations.length !== 2 || JSON.stringify(names) !== JSON.stringify(unsafeBaseNames)) {
    throw new Error("Bend Base unsafe declarations changed; audit the pinned library before proceeding");
  }
  const identifiers = code.match(/\b[A-Za-z_][\w.]*\b/g) ?? [];
  for (const name of unsafeBaseNames) {
    // In the pinned Base these names occur only at their declarations. Thus
    // rejecting direct uses also rules out indirect uses through Base helpers.
    if (identifiers.filter(identifier => identifier === name).length !== 1) {
      throw new Error(`Bend Base references ${name}; its safe dependency boundary needs review`);
    }
  }
};

try {
  const sources = [...checkLocalSafety(), ...bridgeSources].sort();
  const inputs = hashes(sources);
  const metadata = { version: 1, bend: "2.0.26", toolchain, inputs };
  if (mode === "--artifact") {
    const expected = { ...metadata, outputs: hashes(outputs) };
    if (JSON.stringify(JSON.parse(read(receipt))) !== JSON.stringify(expected)) {
      throw new Error("verified artifact is stale; run bun run proofs:generate and review the diff");
    }
    console.log("verified kernel artifact matches proof sources, ABI, adapters and bridge (no Bend required)");
  } else {
    const version = bend(["version"]).trim();
    if (version !== "bend 2.0.26") throw new Error(`expected bend 2.0.26, got ${version}`);
    checkBaseSafety(bend(["base"]));
    const checked = bend(["PROOF.bend", "--check-only"]).trim();
    if (checked !== "All terms check.") throw new Error(`unexpected proof result: ${checked}`);
    const files = await compileKernel(root, bend);
    const outputHashes = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, hash(text)]));
    files[receipt] = JSON.stringify({ ...metadata, outputs: outputHashes }, null, 2) + "\n";
    for (const [path, text] of Object.entries(files)) {
      if (mode === "--write") {
        mkdirSync(dirname(resolve(root, path)), { recursive: true });
        writeFileSync(resolve(root, path), text);
      } else if (read(path) !== text) {
        throw new Error(`${path}: verified artifact is stale; run bun run proofs:generate and review the diff`);
      }
    }
    console.log(`all laws proved; executable kernel ${mode === "--write" ? "generated" : "reproduced byte-for-byte"}`);
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message);
  process.exitCode = 1;
}
