import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COCHANGE_HALF_LIFE_DAYS, coChangeHistory, effectiveWeight, expectationResiduals } from "../src/core/cochange.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const roots: string[] = [];
const cache = (root: string): string => join(tmpdir(), `pi-fovea-cochange-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_DATE: new Date(NOW).toISOString(), GIT_COMMITTER_DATE: new Date(NOW).toISOString() },
}).trim();
const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fovea-feature-history-"));
  roots.push(root);
  git(root, "init", "-qb", "main");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  return root;
};
const commit = (root: string, subject: string, files: string[]): void => {
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    appendFileSync(join(root, file), `${subject}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "--allow-empty", "-qm", subject);
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache(root), { force: true });
  }
});

const mergeFeature = (root: string, index: number, nested = false): void => {
  git(root, "checkout", "-qb", `feature${index}`);
  commit(root, `server${index}`, ["a.ts"]);
  if (nested) git(root, "checkout", "-qb", `nested${index}`);
  commit(root, `client${index}`, ["b.ts"]);
  if (nested) {
    git(root, "checkout", `feature${index}`);
    git(root, "merge", "--no-ff", "-qm", `inner${index}`, `nested${index}`);
  }
  // More constituent pair commits must not inflate independent support.
  commit(root, `joint${index}`, ["a.ts", "b.ts"]);
  git(root, "checkout", "main");
  commit(root, `standalone${index}`, ["a.ts"]);
  git(root, "merge", "--no-ff", "-X", "theirs", "-qm", `integrate${index}`, `feature${index}`);
};

describe("feature integration history (real Git)", () => {
  it("counts ordinary and nested merge net diffs once, retaining standalone first-parent work", async () => {
    const root = repo();
    commit(root, "init", ["noise.ts"]);
    // Host config must not select combined or suppressed merge diffs.
    git(root, "config", "log.diffMerges", "off");
    mergeFeature(root, 1);
    expect((await coChangeHistory(root, ["a.ts", "b.ts"])).size).toBe(0);
    mergeFeature(root, 2, true);
    const history = await coChangeHistory(root, ["a.ts", "b.ts"]);
    expect(history.get("a.ts")?.[0]).toMatchObject({ partner: "b.ts", n_ij: 2, n_i: 4, n_j: 2, N: 5, lastTs: NOW });
    expect(history.get("b.ts")?.[0]).toMatchObject({ n_i: 2, n_j: 4 });
  });

  it("treats squash integrations as one unit and fast-forward commits as standalone", async () => {
    const root = repo();
    commit(root, "init", []);
    for (let i = 0; i < 2; i++) {
      git(root, "checkout", "-qb", `squash${i}`);
      commit(root, `a${i}`, ["a"]);
      commit(root, `b${i}`, ["b"]);
      git(root, "checkout", "main");
      git(root, "merge", "--squash", `squash${i}`);
      git(root, "commit", "-qm", `squashed${i}`);
    }
    git(root, "checkout", "-qb", "ff");
    commit(root, "unlabeled a", ["a"]);
    commit(root, "unlabeled b", ["b"]);
    git(root, "checkout", "main");
    git(root, "merge", "--ff-only", "ff");
    expect((await coChangeHistory(root, ["a", "b"])).get("a")?.[0]).toMatchObject({ n_ij: 2, n_i: 3, n_j: 3, N: 5 });
  });

  it("recovers explicit split followups/chains, requiring independent support and retaining raw decay", async () => {
    const root = repo();
    for (let i = 0; i < 12; i++) commit(root, `noise${i}`, ["noise"]);
    const feature = (i: number): void => {
      commit(root, `feature ${i}`, ["a"]);
      commit(root, `fixup! feature ${i}`, ["b"]);
      commit(root, `squash! fixup! feature ${i}`, ["a", "b"]);
    };
    feature(1);
    expect((await coChangeHistory(root, ["a", "b"])).size).toBe(0);
    feature(2);
    const two = await coChangeHistory(root, ["a", "b"], NOW);
    expect(two.get("a")?.[0]).toMatchObject({ n_ij: 2, n_i: 2, n_j: 2, N: 14 });
    expect(expectationResiduals(["a"], two, NOW).size).toBe(0);
    feature(3);
    const three = await coChangeHistory(root, ["a", "b"], NOW);
    const p = three.get("a")![0]!;
    expect(p).toMatchObject({ n_ij: 3, n_i: 3, n_j: 3, N: 15, lastTs: NOW });
    const weight = expectationResiduals(["a"], three, NOW).get("b")!;
    expect(weight).toBeGreaterThan(0);
    const later = NOW + COCHANGE_HALF_LIFE_DAYS * DAY;
    expect(await coChangeHistory(root, ["b", "a"], later)).toEqual(three);
    expect(expectationResiduals(["a"], three, later).get("b")).toBeCloseTo(weight / 2, 12);
    expect(effectiveWeight(p.w, COCHANGE_HALF_LIFE_DAYS)).toBeCloseTo(p.w / 2, 12);
    expect(expectationResiduals(["a", "b"], three, NOW).size).toBe(0);
  });

  it("timestamps a linked unit by its latest member, not traversal order or the target date", async () => {
    const root = repo();
    const datedCommit = (subject: string, file: string, date: number): void => {
      appendFileSync(join(root, file), `${subject}\n`);
      git(root, "add", "-A");
      execFileSync("git", ["-C", root, "commit", "-qm", subject], {
        env: { ...process.env, GIT_AUTHOR_DATE: new Date(date).toISOString(), GIT_COMMITTER_DATE: new Date(date).toISOString() },
      });
    };
    datedCommit("first", "a", NOW - 100 * DAY);
    datedCommit("fixup! first", "b", NOW - 10 * DAY);
    // Clock skew: a newer commit can have an older timestamp.
    datedCommit("second", "a", NOW - 2 * DAY);
    datedCommit("squash! second", "b", NOW - 5 * DAY);
    const history = await coChangeHistory(root, ["a", "b"], NOW);
    expect(history.get("a")?.[0]).toMatchObject({ n_ij: 2, n_i: 2, N: 2, lastTs: NOW - 2 * DAY });
  });

  it("counts deletion-only boundaries without touching deleted paths or grouping them with re-adds", async () => {
    const root = repo();
    commit(root, "pair1", ["a", "b"]);
    commit(root, "pair2", ["a", "b"]);
    git(root, "rm", "b");
    git(root, "commit", "-qm", "deletion");
    commit(root, "restore", ["b"]);
    expect((await coChangeHistory(root, ["a", "b"])).get("a")?.[0]).toMatchObject({ n_ij: 2, n_i: 2, n_j: 3, N: 4 });
  });

  it("does not group proximity, issue references, ambiguous, missing, or future subjects", async () => {
    const root = repo();
    for (let i = 0; i < 3; i++) {
      commit(root, `feature #42 part ${i}`, ["a"]);
      commit(root, "forgot this #42", ["b"]);
      commit(root, "duplicate", ["a"]);
      commit(root, "fixup! duplicate", ["b"]);
      commit(root, `fixup! future${i}`, ["b"]);
      commit(root, `future${i}`, ["a"]);
      commit(root, "squash! missing target", ["b"]);
    }
    expect((await coChangeHistory(root, ["a", "b"])).size).toBe(0);
  });

  it("caps the aggregate before pairs, but includes all oversized touches in denominators", async () => {
    const root = repo();
    commit(root, "small1", ["a", "b"]);
    commit(root, "small2", ["a", "b"]);
    const extras = Array.from({ length: 23 }, (_, i) => `extra${i}`);
    git(root, "checkout", "-qb", "bulk");
    commit(root, "bulk first", ["a", ...extras.slice(0, 12)]);
    commit(root, "bulk second", ["b", ...extras.slice(12)]);
    git(root, "checkout", "main");
    git(root, "merge", "--no-ff", "-qm", "release boundary", "bulk");
    commit(root, "large split", ["a", ...extras.slice(0, 12)]);
    commit(root, "fixup! large split", ["b", ...extras.slice(12)]);
    const history = await coChangeHistory(root, ["a", "b", ...extras]);
    expect(history.size).toBe(2);
    expect(history.get("a")?.[0]).toMatchObject({ n_ij: 2, n_i: 4, n_j: 4, N: 4 });
  });

  it("preserves NUL-delimited odd paths, collision-safe pair identities, and subroot counts", async () => {
    const root = repo();
    const names = ["a|b", "c", "a", "b|c", "white space ", "tab\tname", "line\nname", "日本語", "back\\slash", "FOVEA"];
    const files = names.map((name) => `sub/${name}`);
    for (let i = 0; i < 2; i++) commit(root, `paths${i}`, files);
    commit(root, "outside", ["elsewhere"]);
    const full = await coChangeHistory(root, files);
    expect(full.get("sub/a|b")?.find((p) => p.partner === "sub/c")).toMatchObject({ n_ij: 2, n_i: 2, N: 3 });
    const subroot = join(root, "sub");
    try {
      const sub = await coChangeHistory(subroot, names);
      expect([...sub.keys()].sort()).toEqual([...names].sort());
      for (const name of names) {
        expect(sub.get(name)).toHaveLength(names.length - 1);
        expect(sub.get(name)?.[0]).toMatchObject({ n_ij: 2, n_i: 2, N: 3 });
      }
    } finally { rmSync(cache(subroot), { force: true }); }
  });

  it("invalidates v3 cache and tracked-file identity", async () => {
    const root = repo();
    commit(root, "one", ["a", "b"]);
    commit(root, "two", ["a", "b"]);
    await coChangeHistory(root, ["a", "b"]);
    const raw = JSON.parse(readFileSync(cache(root), "utf8"));
    expect(raw.v).toBe(4);
    writeFileSync(cache(root), JSON.stringify({ ...raw, v: 3, pairs: [] }));
    expect((await coChangeHistory(root, ["a", "b"])).get("a")?.[0]?.n_ij).toBe(2);
    expect((await coChangeHistory(root, ["a"])).size).toBe(0);
  });

  it("omits shallow synthetic roots and invalidates after deepen at identical HEAD", async () => {
    const source = repo();
    for (let i = 0; i < 5; i++) commit(source, `joint${i}`, ["a", "b"]);
    const root = mkdtempSync(join(tmpdir(), "fovea-feature-shallow-"));
    roots.push(root);
    git(root, "clone", "--depth=2", `file://${source}`, ".");
    const head = git(root, "rev-parse", "HEAD");
    expect((await coChangeHistory(root, ["a", "b"])).size).toBe(0);
    const before = JSON.parse(readFileSync(cache(root), "utf8")).key;
    git(root, "fetch", "--deepen=2");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect((await coChangeHistory(root, ["a", "b"])).get("a")?.[0]).toMatchObject({ n_ij: 3, n_i: 3, N: 3 });
    expect(JSON.parse(readFileSync(cache(root), "utf8")).key).not.toBe(before);
    git(root, "fetch", "--unshallow");
    expect((await coChangeHistory(root, ["a", "b"])).get("a")?.[0]).toMatchObject({ n_ij: 5, N: 5 });
  });

  it("bounds first-parent observations to 400 even with empty commits", async () => {
    const root = repo();
    commit(root, "old1", ["a", "b"]);
    commit(root, "old2", ["a", "b"]);
    // Fast plumbing avoids 400 process pairs while still creating real Git objects.
    const tree = git(root, "rev-parse", "HEAD^{tree}");
    let parent = git(root, "rev-parse", "HEAD");
    for (let i = 0; i < 400; i++) parent = git(root, "commit-tree", tree, "-p", parent, "-m", `empty${i}`);
    git(root, "update-ref", "refs/heads/main", parent);
    expect((await coChangeHistory(root, ["a", "b"])).size).toBe(0);
    expect(JSON.parse(readFileSync(cache(root), "utf8")).commits).toBe(400);
  }, 30_000);
});
