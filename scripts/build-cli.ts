// Publish artifact for the global install path. Bundles the CLI into one
// self-contained ESM file so `npm i -g pi-fovea` runs on plain node >= 20 —
// no tsx, no node_modules. Dev never builds: `bun run fovea` and `bun run run
// check` run from source (pi loads the extension from src/ via jiti); only
// `prepack` (npm/bun run pack & publish) invokes this.

import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("../cli.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});

// esbuild hoists the entry's tsx shebang alongside the banner; a global bin
// needs exactly one shebang, pointing at node.
const bundled = await readFile(outfile, "utf8");
await writeFile(outfile, bundled.replace(/^(#!.*\n)+/, "#!/usr/bin/env node\n"));
console.log("wrote dist/cli.mjs");
