// Extraction honesty: a failed ast-grep stage must be reported (per-file)
// instead of silently thinning the graph — and a healthy pass reports zero.
// The failing runs point FOVEA_AST_GREP at a wrapper that answers --version
// but exits 1 for everything else, so ensureState proceeds into genuinely
// broken extraction.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AST_GREP_CHUNK, hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor, listFiles, loadFacts } from "../src/core/build.js";
import { sketch } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";

const SRC = new URL("./fixtures/mini", import.meta.url).pathname;

// Separate temp roots per test: a broken-extraction fact pass writes an empty
// cache keyed by root, which must never leak a poisoned graph into other runs.
const copyFixture = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "fovea-report-"));
  cpSync(SRC, root, { recursive: true });
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    },
  };
};

const fakeAstGrep = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "fovea-fake-sg-"));
  const bin = join(dir, "sg-fail");
  // stderr text matters: grep-family CLIs exit 1 silently on zero matches,
  // so genuine failures are told apart by having something to say.
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sg-fail 0.0.0"; exit 0; fi\necho "sg-fail: synthetic failure" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  return bin;
};

const scanlessAstGrep = (): string => {
  const real = execFileSync("sh", ["-c", "command -v ast-grep"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "fovea-scanless-sg-"));
  const bin = join(dir, "sg-run-only");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "scan" ]; then exit 2; fi\nexec "${real}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};

const countingAstGrep = (log: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "fovea-counting-sg-"));
  const bin = join(dir, "sg-count");
  // Concurrent shell printf calls can interleave even with append redirection.
  // Keep each subprocess record separate so the scheduling count stays exact.
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "${log}.$$"\nif [ "$1" = "--version" ]; then echo "sg-count 0.0.0"; exit 0; fi\nif [ "$1" = "scan" ] && [ "$2" = "--help" ]; then exit 0; fi\nif [ "$1" = "scan" ]; then exit 0; fi\nif [ "$1" = "outline" ] && [ "$2" = "--json=compact" ]; then printf '[]'; exit 0; fi\nif [ "$1" = "outline" ]; then exit 0; fi\nexit 2\n`);
  chmodSync(bin, 0o755);
  return bin;
};

afterEach(() => vi.unstubAllEnvs());

describe("bounded discovery", () => {
  it("treats nested Git repositories and worktrees as project boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-umbrella-"));
    try {
      writeFileSync(join(root, "top.ts"), "export const top = 1;\n");
      mkdirSync(join(root, "plain"));
      writeFileSync(join(root, "plain", "seen.ts"), "export const seen = 1;\n");
      mkdirSync(join(root, "repo", ".git"), { recursive: true });
      writeFileSync(join(root, "repo", "hidden.ts"), "export const hidden = 1;\n");
      mkdirSync(join(root, "worktree"));
      writeFileSync(join(root, "worktree", ".git"), "gitdir: /tmp/elsewhere\n");
      writeFileSync(join(root, "worktree", "hidden.ts"), "export const hidden = 2;\n");

      expect(await listFiles(root)).toEqual(["plain/seen.ts", "top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips Cargo package caches during umbrella walks", async () => {
    // ~/.cargo/registry/src and ~/.cargo/git/checkouts hold vendored crate
    // copies (e.g. aws-lc-sys' generated BoringSSL tables), the same class of
    // dependency payload as node_modules or vendor.
    const root = mkdtempSync(join(tmpdir(), "fovea-cargo-"));
    try {
      writeFileSync(join(root, "top.ts"), "export const top = 1;\n");
      const registry = join(root, ".cargo", "registry", "src", "index.crates.io-deadbeef", "aws-lc-sys-0.42.0");
      mkdirSync(registry, { recursive: true });
      writeFileSync(join(registry, "lib.rs"), "pub fn cached() {}\n");
      const checkout = join(root, ".cargo", "git", "checkouts", "some-abc123", "deadbeef");
      mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, "main.rs"), "fn main() {}\n");
      expect(await listFiles(root)).toEqual(["top.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports and omits individual source files over the memory safety cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-oversized-"));
    try {
      writeFileSync(join(root, "generated.ts"), "x".repeat(2 * 1024 * 1024 + 1));
      const { store, report } = await loadFacts(root, await listFiles(root));
      expect(report.oversized).toEqual(["generated.ts"]);
      expect(store.facts.has("generated.ts")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });
});

describe("extraction failure reporting", () => {
  it("names the implicated files when every ast-grep invocation fails", async () => {
    const { root, cleanup } = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      const files = await listFiles(root);
      const { store, report } = await loadFacts(root, files);
      expect(report.unreadable).toEqual([]);
      expect(report.failed.length).toBeGreaterThan(0);
      expect(report.failed).toContain("server/main.go");
      expect(store.facts.get("server/main.go")?.symbols).toEqual([]);

      // A fact-free hash/stat marker preserves honest failure coverage without
      // retrying unchanged broken extraction on every launch.
      const unchanged = await loadFacts(root, files);
      expect(unchanged.dirty).toEqual([]);
      expect(unchanged.report.failed).toContain("server/main.go");

      writeFileSync(join(root, "server/main.go"), "package server\nfunc Changed() {}\n");
      const changed = await loadFacts(root, files);
      expect(changed.dirty).toContain("server/main.go");
      expect(changed.report.failed).toContain("server/main.go");
    } finally {
      cleanup();
    }
  });

  it("sketch renders the failure banner and exposes the failure details", async () => {
    const { root, cleanup } = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      resetSessions();
      const r = await sketch(root, 900);
      expect(Number(r.details.extractionFailures)).toBeGreaterThan(0);
      expect((r.details.extractionFailedFiles as string[]).length).toBeGreaterThan(0);
      expect(r.text).toContain("failed extraction");
    } finally {
      cleanup();
    }
  });
});

describe("consolidated extraction scheduling", () => {
  it("runs one rule scan per configured batch and does not re-anchor a cold dirty set", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-scan-count-"));
    const log = join(root, "invocations.log");
    try {
      for (let i = 0; i <= AST_GREP_CHUNK; i++) {
        writeFileSync(join(root, `file-${String(i).padStart(3, "0")}.ts`), `export const value${i} = ${i};\n`);
      }
      vi.stubEnv("FOVEA_AST_GREP", countingAstGrep(log));
      const outcome = await loadFacts(root, await listFiles(root));
      expect(outcome.report.failed).toEqual([]);
      const invocations = readdirSync(root)
        .filter((name) => name.startsWith("invocations.log."))
        .map((name) => readFileSync(join(root, name), "utf8").trim());
      expect(invocations.filter((line) => line.startsWith("scan --rule "))).toHaveLength(2);
      expect(invocations.filter((line) => line.startsWith("outline "))).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    }
  });
});

describe.skipIf(!hasAstGrep())("healthy extraction", () => {
  it("reports zero failures and drains a previous run's ledger", async () => {
    const bad = copyFixture();
    const good = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      await loadFacts(bad.root, await listFiles(bad.root)); // poison the ledger, then drain
      vi.unstubAllEnvs();
      const { report } = await loadFacts(good.root, await listFiles(good.root));
      expect(report.failed).toEqual([]);
      expect(report.unreadable).toEqual([]);
      resetSessions();
      const r = await sketch(good.root, 900);
      expect(Number(r.details.extractionFailures)).toBe(0);
      expect(r.text).not.toContain("failed extraction");
    } finally {
      bad.cleanup();
      good.cleanup();
    }
  });

  it("produces the same normalized facts as the legacy per-pattern fallback", async () => {
    const scanned = copyFixture();
    const legacy = copyFixture();
    try {
      vi.unstubAllEnvs();
      const scanOutcome = await loadFacts(scanned.root, await listFiles(scanned.root));
      vi.stubEnv("FOVEA_AST_GREP", scanlessAstGrep());
      const legacyOutcome = await loadFacts(legacy.root, await listFiles(legacy.root));
      expect(scanOutcome.report.failed).toEqual([]);
      expect(legacyOutcome.report.failed).toEqual([]);

      const normalize = (facts: typeof scanOutcome.store.facts) => {
        const sort = <T>(items: T[]): T[] => [...items].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        );
        return [...facts].sort(([a], [b]) => a.localeCompare(b)).map(([file, record]) => ({
          file,
          sha1: record.sha1,
          symbols: sort(record.symbols),
          imports: sort(record.imports),
          calls: sort(record.calls),
          literals: sort(record.literals),
          anchors: sort(record.anchors),
          sigs: record.sigs,
        }));
      };
      expect(normalize(scanOutcome.store.facts)).toEqual(normalize(legacyOutcome.store.facts));
    } finally {
      scanned.cleanup();
      legacy.cleanup();
    }
  });
});
