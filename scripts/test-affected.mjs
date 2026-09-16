#!/usr/bin/env node
// Selects only the vitest files a change touches, and nothing else.
//
//   default          working tree against HEAD, for local iteration
//   --base <ref>     <ref> against HEAD, for a CI push range or pull request
//
// There is deliberately no full-suite fallback. An unusable selection runs
// nothing and exits, and CI pairs this with the curated smoke floor
// (bun run test:smoke) so a docs-only push still exercises the pipeline.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const baseIndex = argv.indexOf("--base");
// Either source selects range mode: the CI script passes --base, and an
// operator can export PI_TEST_BASE when running the file directly.
const baseFromFlag = baseIndex >= 0;
const base = baseFromFlag ? (argv[baseIndex + 1] ?? "") : (process.env.PI_TEST_BASE ?? "");
const rangeMode = baseFromFlag || process.env.PI_TEST_BASE !== undefined;

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
// Base resolution reports its own short message, so git's usage dump stays out.
const gitQuiet = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// A deletion cannot be run, so deleted paths never enter the selection.
const changedPaths = (spec) =>
  git(["diff", "--name-only", "--diff-filter=d", spec]).split("\n").filter(Boolean);

let changed;
if (rangeMode) {
  if (!base) {
    console.log("no base provided (PI_TEST_BASE is empty); nothing to select");
    process.exit(0);
  }
  if (/^0+$/.test(base)) {
    console.log(`base ${base} is not a commit (new branch push); nothing to select`);
    process.exit(0);
  }
  try {
    // Three-dot compares against the merge base, so a pull request sees only
    // its own commits even after the target branch moved on.
    changed = gitQuiet(["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`])
      .split("\n")
      .filter(Boolean);
  } catch {
    console.error(`cannot resolve base ${base}; nothing to select`);
    process.exit(0);
  }
} else {
  // No flag at all: the local dirty-tree mode.
  try {
    changed = changedPaths("HEAD");
  } catch {
    console.error(
      "git unavailable; cannot determine affected tests (there is no full-suite fallback)",
    );
    process.exit(1);
  }
  const untracked = (() => {
    try {
      return git(["ls-files", "--others", "--exclude-standard", "--", "src", "tests", "cli.ts", "scripts"])
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  })();
  changed = [...changed, ...untracked];
}

const files = [...new Set(changed)].filter((file) => fs.existsSync(file));
const isTestFile = (file) => /\.test\.(?:ts|tsx)$/.test(file);
// Harness configuration is not source. A vitest.config change selects nothing
// here on purpose, and CI's smoke floor covers that case.
const isHarnessConfig = (file) => /^vitest\.config\./.test(file) || /^tsconfig/.test(file);
const isCode = (file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) && !file.startsWith("dist/");
const direct = files.filter(isTestFile);
const related = files.filter((file) => isCode(file) && !isTestFile(file) && !isHarnessConfig(file));

if (direct.length === 0 && related.length === 0) {
  console.log(`${base ? `vs ${base}` : "dirty tree"}: no changed source/test files; nothing to run`);
  process.exit(0);
}

const runs = [];
if (related.length > 0) runs.push(["vitest", "related", ...related]);
if (direct.length > 0) runs.push(["vitest", "run", ...direct]);
console.log(
  `${base ? `vs ${base}` : "dirty tree"}: ${related.length} changed source file(s), ${direct.length} changed test file(s)`,
);
console.log(runs.map((args) => "vitest " + args.slice(2).join(" ")).join(" && "));
if (argv.includes("--dry-run")) {
  console.log("dry run: selection printed, nothing executed");
  process.exit(0);
}
try {
  for (const args of runs) execFileSync("bunx", args, { stdio: "inherit" });
} catch {
  process.exit(1);
}
