#!/usr/bin/env node
// Inspect the actual archive, not files resolved through this checkout's deps.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "fovea-package-"));
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"], ...options,
});

try {
  const args = process.argv.slice(2);
  const cliOnly = args[0] === "--cli";
  if (cliOnly) args.shift();
  assert(args.length <= 1 && !args[0]?.startsWith("-"), "usage: node scripts/check-package.mjs [--cli] [package.tgz]");
  const archive = args[0] ? resolve(args[0]) : join(temp, "package.tgz");
  if (!args[0]) {
    if (cliOnly) run(process.execPath, ["scripts/pack-cli.mjs", archive]);
    else run("bun", ["pm", "pack", "--filename", archive, "--quiet"]);
  }
  const entries = run("tar", ["-tzf", archive]).trim().split("\n");
  assert(!entries.some(path => path.endsWith(".tgz")), "archive must not contain other release archives");
  run("tar", ["-xzf", archive, "-C", temp]);
  const unpacked = join(temp, "package");
  const read = path => readFileSync(join(unpacked, path), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, cliOnly ? "@monotykamary/fovea" : expected.name);
  assert.equal(pkg.version, expected.version);
  assert.deepEqual(pkg.bin, { fovea: "dist/cli.mjs" });
  assert.deepEqual(pkg.engines, expected.engines);
  assert.deepEqual(pkg.optionalDependencies, expected.optionalDependencies);
  assert.deepEqual(pkg.trustedDependencies, expected.trustedDependencies);
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  if (cliOnly) {
    for (const key of ["pi", "exports", "dependencies", "peerDependencies", "peerDependenciesMeta", "devDependencies", "scripts", "workspaces"]) {
      assert(!(key in pkg), `CLI-only manifest must not include ${key}`);
    }
    for (const path of ["src/index.ts", "skills/pi-fovea", "cli.ts"]) {
      assert(!existsSync(join(unpacked, path)), `CLI-only archive must not include ${path}`);
    }
    assert.equal(read("README.md"), readFileSync(join(root, "docs/cli.md"), "utf8"));
  } else {
    assert.deepEqual(pkg.pi, expected.pi);
    assert.deepEqual(pkg.exports, expected.exports);
  }
  for (const name of cliOnly ? ["fovea"] : ["fovea", "pi-fovea"]) {
    const path = `skills/${name}/SKILL.md`;
    assert.equal(read(path), readFileSync(join(root, path), "utf8"), `packaged skill drift: ${name}`);
  }
  assert(!existsSync(join(unpacked, "node_modules")), "archive must not ship installed dependencies");
  for (const path of [
    ...Object.values(pkg.bin), ...Object.values(pkg.exports ?? {}), ...(pkg.pi?.extensions ?? []),
    ...(pkg.pi?.skills ?? []), "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/licenses/bend-apache-2.0.txt",
  ]) assert(existsSync(join(unpacked, path)), `missing package entry: ${path}`);

  const receiptPath = "src/verified/generated/manifest.json";
  assert.equal(read(receiptPath), readFileSync(join(root, receiptPath), "utf8"), "packaged receipt drift");
  const receipt = JSON.parse(read(receiptPath));
  for (const [path, hash] of Object.entries({ ...receipt.inputs, ...receipt.outputs })) {
    assert.equal(createHash("sha256").update(read(path)).digest("hex"), hash, `packaged proof drift: ${path}`);
  }
  const bin = join(unpacked, pkg.bin.fovea);
  assert(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"), "CLI must run on plain Node");
  const fixture = join(temp, "fixture");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "entry.bend"), "def packagedProbe() -> Nat:\n  1n\n");
  const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", BEND: join(temp, "missing-bend"),
    FOVEA_AST_GREP: join(temp, "missing-ast-grep") };
  const sketch = run(process.execPath, [bin, "sketch", fixture, "512"], { cwd: temp, env });
  assert.match(sketch, /fovea sketch/);
  assert.match(sketch, /packagedProbe/);
  const kernelUrl = pathToFileURL(join(unpacked, "src/verified/generated/kernel.js")).href;
  const abi = JSON.parse(read("proofs/kernel-abi.json"));
  run(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import * as kernel from ${JSON.stringify(kernelUrl)};
assert.deepEqual(Object.keys(kernel).sort(), ${JSON.stringify(Object.keys(abi).sort())});
assert.equal(kernel.shownCount(3n, 2n), 2n);
assert.deepEqual(kernel.basisStep(2n, 3n), {$: "Next", at: 2n, previous: 1n, older: 0n});
`], { cwd: temp, env });
  if (cliOnly) {
    // Exercise npm's actual global bin link in a disposable prefix, offline and
    // without optional parsers. No change to the user's global installation.
    const prefix = join(temp, "global");
    run("npm", ["install", "--global", "--prefix", prefix, "--cache", join(temp, "npm-cache"),
      "--offline", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: temp, env });
    const installed = run(join(prefix, "bin/fovea"), ["sketch", fixture, "512"], { cwd: temp, env });
    assert.match(installed, /fovea sketch/);
    assert.match(installed, /packagedProbe/);
  }
  console.log(`${pkg.name}@${pkg.version}: isolated tarball, entry points, proof receipts, licenses, CLI and kernel verified${cliOnly ? ", global npm bin verified" : ""}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
