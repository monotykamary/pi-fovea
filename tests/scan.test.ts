// The consolidated scan path must stay on for every batch composition.
//
// Regression (found by profiling a cold build): the flask rule pins its
// method literally (`$R.add_url_rule($P, $$$H)`) while anchorScanPlan
// attached an unconditional M constraint. ast-grep rejects an entire
// rules.yml over that ("Undefined meta var `M`", exit 8), scanRules returns
// undefined for the whole batch, and extraction silently reroutes onto
// per-pattern spawns that re-parse every file for every pattern.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasAstGrep, liveConstraints, scanRules } from "../src/core/astgrep.js";
import { anchorScanPlan } from "../src/core/anchors.js";

describe("scan rule hygiene", () => {
  it("drops constraints whose metavar the pattern never defines", () => {
    // The flask regression: the method is pinned in the pattern, no $M anywhere.
    expect(liveConstraints("$R.add_url_rule($P, $$$H)", { M: { regex: "^add_url_rule$" } })).toBeUndefined();
    // Dead keys go, live keys stay.
    expect(liveConstraints("$O.$M($$$)", { M: { regex: "^x$" }, F: { regex: "^y$" } }))
      .toEqual({ M: { regex: "^x$" } });
    expect(liveConstraints("$R.$M($P, $$$H)", { M: { regex: "^x$" }, R: { regex: "^y$" } }))
      .toEqual({ M: { regex: "^x$" }, R: { regex: "^y$" } });
    // $M2 does not read as defining $M; named ($$A) and multi ($$$S) captures do satisfy their keys.
    expect(liveConstraints("$M2($P)", { M: { regex: "^x$" } })).toBeUndefined();
    expect(liveConstraints("foo($$A, $B)", { A: { regex: "^a$" }, C: { regex: "^c$" } }))
      .toEqual({ A: { regex: "^a$" } });
    expect(liveConstraints("import $$$S from $M", { S: { regex: "^s$" } }))
      .toEqual({ S: { regex: "^s$" } });
  });
});

describe.skipIf(!hasAstGrep())("consolidated scan (ast-grep present)", () => {
  it("keeps the flask batch on the consolidated path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fovea-scan-test-"));
    try {
      writeFileSync(
        join(dir, "app.py"),
        'from flask import Flask\n\napp = Flask(__name__)\n\n\ndef get_user(id: int):\n    return {}\n\n\napp.add_url_rule("/users/<int:id>", "user_detail", get_user)\n',
      );
      const plan = anchorScanPlan(["app.py"]);
      const scanned = await scanRules(plan.rules, ["app.py"], dir);
      // The stale M constraint used to void the entire rules.yml (undefined)
      // and reroute this batch onto per-pattern fallback spawns.
      expect(scanned).toBeDefined();
      const flask = scanned!.filter((m) => m.ruleId.startsWith("fovea-anchor-match"));
      expect(flask.length).toBeGreaterThan(0);
      // $P captures the full string-literal node, quotes included; anchor
      // processing strips them later, so compare on the stripped text.
      expect(flask.some((m) => (m.single.P ?? "").replace(/"/g, "") === "/users/<int:id>")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes a parseable rules.yml across pack rules for mixed languages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fovea-scan-mix-"));
    try {
      writeFileSync(join(dir, "app.py"), 'app.add_url_rule("/u/<int:id>", "detail", get_user)\n');
      writeFileSync(join(dir, "api.ts"), 'const r = express.Router();\nr.get("/health", handler);\nexport { r };\n');
      writeFileSync(join(dir, "routes.rb"), 'Rails.application.routes.draw do\n  get "users/:id", to: "users#show"\nend\n');
      const files = ["app.py", "api.ts", "routes.rb"];
      const plan = anchorScanPlan(files);
      const scanned = await scanRules(plan.rules, files, dir);
      expect(scanned).toBeDefined();
      expect(scanned!.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
