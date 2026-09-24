#!/usr/bin/env node
// Stage a CLI-only distribution without renaming or rewriting the Pi package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv.length <= 3, "usage: node scripts/pack-cli.mjs [package.tgz]");
const archive = resolve(process.argv[2] ?? join(root, "dist/fovea-cli.tgz"));
// Use the same proof and fresh-bundle gate as pi-fovea's prepack lifecycle.
execFileSync("bun", ["run", "prepack"], { cwd: root, stdio: "inherit" });
const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const source = read("package.json");
const receiptPath = "src/verified/generated/manifest.json";
const receipt = read(receiptPath);
const files = [...new Set([
  "dist/cli.mjs", "skills/fovea/SKILL.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/licenses/bend-apache-2.0.txt",
  receiptPath, ...Object.keys(receipt.inputs), ...Object.keys(receipt.outputs),
])];
// Allowlist metadata so Pi peers, extension registration, and install/build
// scripts cannot leak into the standalone distribution. Proof sources stay
// with the receipt for independent auditing; they are not runtime imports.
const manifest = {
  name: "@monotykamary/fovea",
  version: source.version,
  description: "Token-budgeted repository navigation for agent shells and CI, powered by a cross-language code graph.",
  type: "module",
  license: source.license,
  engines: source.engines,
  author: source.author,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  keywords: [...source.keywords.filter(word => !word.startsWith("pi-")), "cli"],
  bin: { fovea: "dist/cli.mjs" },
  files: [...files, "README.md"],
  optionalDependencies: source.optionalDependencies,
  trustedDependencies: source.trustedDependencies,
  publishConfig: { access: "public" },
};
const staging = mkdtempSync(join(tmpdir(), "fovea-cli-pack-"));
try {
  for (const path of files) {
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  copyFileSync(join(root, "docs/cli.md"), join(staging, "README.md"));
  chmodSync(join(staging, manifest.bin.fovea), 0o755);
  writeFileSync(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync("bun", ["pm", "pack", "--filename", archive, "--quiet"], { cwd: staging, stdio: "inherit" });
  console.log(`${manifest.name}@${manifest.version}: ${archive}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
