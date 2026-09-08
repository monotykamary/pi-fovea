import { describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { distribution, refreshProbe, revealedIds } from "../scripts/bench-support.js";

describe("benchmark gates", () => {
  it("scores identities rather than ambiguous names and enforces actual budgets", () => {
    const result = { text: "same", tokens: 1, details: { nodes: [{ id: "same@a.ts" }, { id: "same@b.ts" }] } };
    expect([...revealedIds(result, 1)]).toEqual(["same@a.ts", "same@b.ts"]);
    expect(() => revealedIds(result, 0)).toThrow("budget exceeded");
    expect(() => revealedIds({ ...result, tokens: 2 }, 2)).toThrow("reported token estimate drifted");
    expect(distribution([3, 1, 2])).toBe("median 2.00ms · p95 3.00ms · n=3");
  });

  it.skipIf(!hasAstGrep())("requires incremental refresh and clean rebuild to do equivalent work", async () => {
    const rows = await refreshProbe();
    expect(rows.map((row) => row.scenario)).toEqual(["unchanged", "locations", "semantic", "addition", "deletion"]);
  }, 120_000);
});
