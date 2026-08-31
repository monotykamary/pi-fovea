import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COCHANGE_HALF_LIFE_DAYS,
  coChangeHistory,
  expectationResiduals,
} from "../src/core/cochange.js";
import type { CoChangeHistory, CoChangePartner } from "../src/core/cochange.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const partner = (
  file: string,
  overrides: Partial<CoChangePartner> = {},
): CoChangePartner => ({
  partner: file,
  w: 0.4,
  lastTs: NOW,
  n_ij: 18,
  n_i: 20,
  n_j: 20,
  N: 100,
  ...overrides,
});

const historyOf = (entries: Array<[string, CoChangePartner[]]>): CoChangeHistory =>
  new Map(entries);

describe("unmet-companion expectation residuals", () => {
  it("returns a strong historical companion that is absent from the change", () => {
    const history = historyOf([
      ["src/a.ts", [
        partner("src/companion.ts"),
        partner("src/already-changed.ts"),
      ]],
    ]);

    const residuals = expectationResiduals(
      ["src/a.ts", "src/already-changed.ts"],
      history,
      NOW,
    );

    expect([...residuals.keys()]).toEqual(["src/companion.ts"]);
    expect(residuals.get("src/companion.ts")).toBeGreaterThan(0.45);
    expect(residuals.get("src/companion.ts")).toBeLessThanOrEqual(1);
  });

  it("rejects a weak pair whose conservative conditional rate does not beat its base rate", () => {
    const history = historyOf([
      ["src/a.ts", [partner("src/common.ts", {
        n_ij: 3,
        n_i: 20,
        n_j: 10,
        N: 100,
      })]],
    ]);

    expect(expectationResiduals(["src/a.ts"], history, NOW).size).toBe(0);
  });

  it("applies the existing half-life decay at use time", () => {
    const history = historyOf([
      ["src/a.ts", [
        partner("src/fresh.ts"),
        partner("src/old.ts", {
          lastTs: NOW - COCHANGE_HALF_LIFE_DAYS * DAY,
        }),
      ]],
    ]);

    const residuals = expectationResiduals(["src/a.ts"], history, NOW);
    expect(residuals.get("src/old.ts")).toBeCloseTo(residuals.get("src/fresh.ts")! / 2, 12);
  });

  it("requires at least three joint commits", () => {
    const history = historyOf([
      ["src/a.ts", [partner("src/two-hit.ts", {
        n_ij: 2,
        n_i: 3,
        n_j: 2,
        N: 100,
      })]],
    ]);

    expect(expectationResiduals(["src/a.ts"], history, NOW).has("src/two-hit.ts")).toBe(false);
  });

  it("adds evidence from changed files and caps a residual at one", () => {
    const strong = {
      n_ij: 100,
      n_i: 100,
      n_j: 100,
      N: 1000,
    } satisfies Partial<CoChangePartner>;
    const history = historyOf([
      ["src/a.ts", [partner("src/shared.ts", strong)]],
      ["src/b.ts", [partner("src/shared.ts", strong)]],
    ]);

    const residuals = expectationResiduals(["src/b.ts", "src/a.ts"], history, NOW);
    expect(residuals.get("src/shared.ts")).toBe(1);
  });

  it("is deterministic and orders equal weights by path", () => {
    const history = historyOf([
      ["src/source.ts", [
        partner("src/zeta.ts"),
        partner("src/beta.ts", { n_ij: 10, n_i: 20, n_j: 10 }),
        partner("src/alpha.ts"),
      ]],
    ]);

    const first = expectationResiduals(["src/source.ts", "src/source.ts"], history, NOW);
    const second = expectationResiduals(["src/source.ts", "src/source.ts"], history, NOW);

    expect([...first]).toEqual([...second]);
    expect([...first.keys()]).toEqual(["src/alpha.ts", "src/zeta.ts", "src/beta.ts"]);
  });
});

describe("co-change directional counts", () => {
  it("retains joint, directional, and total touch counts from the bounded git window", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-residual-counts-"));
    let sequence = 0;
    const commit = (files: string[]): void => {
      sequence++;
      for (const file of files) appendFileSync(join(root, file), `${sequence}\n`, "utf8");
      execSync("git add -A", { cwd: root });
      execSync(`git -c user.name=t -c user.email=t@t commit -qm c${sequence}`, { cwd: root });
    };

    try {
      execSync("git init -qb main", { cwd: root });
      commit(["a.ts", "b.ts"]);
      commit(["a.ts"]);
      commit(["a.ts", "b.ts"]);
      commit(["b.ts"]);
      commit(["a.ts", "b.ts"]);
      commit(["a.ts"]);
      commit(["c.ts"]);

      const history = await coChangeHistory(root, ["a.ts", "b.ts", "c.ts"], NOW);
      const ab = history.get("a.ts")?.find((p) => p.partner === "b.ts");
      const ba = history.get("b.ts")?.find((p) => p.partner === "a.ts");

      expect(ab).toMatchObject({ n_ij: 3, n_i: 5, n_j: 4, N: 7 });
      expect(ba).toMatchObject({ n_ij: 3, n_i: 4, n_j: 5, N: 7 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
