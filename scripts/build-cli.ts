// Publish artifact for the global install path. Bundles the CLI into one
// self-contained ESM file so `npm i -g pi-fovea` runs on plain node >= 20 —
// no tsx or development dependencies. Pi loads the extension from src/ via jiti;
// only CLI packaging needs this build.

import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

const result = await build({
  entryPoints: [fileURLToPath(new URL("../cli.ts", import.meta.url))],
  outfile,
  bundle: true,
  metafile: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !isBuiltin(dependency.path)) {
      throw new Error(`Unbundled CLI dependency: ${dependency.path}`);
    }
  }
}

// esbuild hoists the entry's tsx shebang alongside the banner; a global bin
// needs exactly one shebang, pointing at node.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/^(#!.*\n)+/, "#!/usr/bin/env node\n"));
console.log("wrote dist/cli.mjs");
