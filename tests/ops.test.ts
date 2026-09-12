// End-to-end over the fixture: graph build, the four ops, budget conformance,
// and the session delta contract.

import { describe, expect, it, vi } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { assembleGraphWithIndex as assembleGraphFromBuild } from "../src/core/build.js";
import { assembleGraphWithIndex } from "../src/core/graph.js";
import {
  dwell,
  ensureState,
  ensureStateBackground,
  evictState,
  focus,
  getInflight,
  getState,
  impact,
  sketch,
} from "../src/core/ops.js";
import { getSession, resetSessions } from "../src/core/session.js";
import * as state from "../src/core/state.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;

describe("extracted module compatibility", () => {
  it("re-exports graph assembly and state lifecycle without wrappers", () => {
    expect(assembleGraphFromBuild).toBe(assembleGraphWithIndex);
    expect(ensureState).toBe(state.ensureState);
    expect(ensureStateBackground).toBe(state.ensureStateBackground);
    expect(evictState).toBe(state.evictState);
    expect(getInflight).toBe(state.getInflight);
    expect(getState).toBe(state.getState);
  });
});

describe.skipIf(!hasAstGrep())("fovea ops on the minimonorepo", () => {
  it("builds the graph with anchors and cross-language join edges", async () => {
    const s = await ensureState(FIXTURE);
    expect(s.graph.anchors.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(s.graph.edges.map((e) => e.kind));
    expect(kinds.has("join")).toBe(true);
    expect(kinds.has("contains")).toBe(true);
    expect(kinds.has("invokes")).toBe(true);
    expect(s.graph.edges.every((edge) =>
      !!edge.evidence?.strategy && !!edge.evidence.rule && !!edge.evidence.source,
    )).toBe(true);
    // a join edge crossing server -> web or server -> openapi exists
    const cross = s.graph.edges.some((e) => {
      if (e.kind !== "join") return false;
      const fa = s.graph.nodes[e.a]!.file;
      const fb = s.graph.nodes[e.b]!.file;
      return fa.split("/")[0] !== fb.split("/")[0];
    });
    expect(cross).toBe(true);
  });

  it("sketch silhouettes the repo with feature anchors first", async () => {
    resetSessions();
    const r = await sketch(FIXTURE, 900);
    expect(r.tokens).toBeLessThanOrEqual(900);
    expect(r.text).toContain("fovea sketch");
    expect(r.text).toContain("⚑ GET /api/users/{*}");
    expect(r.text).toMatch(/server\//);
    expect(r.text).toMatch(/web\//);
  });

  it("keeps test and fixture architecture collapsed in a real project sketch", async () => {
    const project = new URL("../", import.meta.url).pathname;
    const r = await sketch(project, 1200);
    expect(Number(r.details.testAnchors)).toBeGreaterThan(0);
    expect(r.text).toContain("test/fixture anchors collapsed");
    expect(r.text).toContain("src/core/");
    expect(r.text).not.toContain("⚑ GET /elixir-health");
  });

  it("focus on a route resolves across languages within budget", async () => {
    resetSessions();
    const r = await focus(FIXTURE, "/api/users/{id}", 1600);
    expect(r.tokens).toBeLessThanOrEqual(1600);
    expect(r.text).toContain("server/main.go");
    expect(r.text).toContain("web/api.ts");
    expect(r.text).toContain("openapi.yaml");
  });

  it("focus on a symbol keeps signatures foveated and budgets", async () => {
    for (const B of [400, 800, 1600, 4000]) {
      resetSessions(); // fresh eyes per budget: deltas otherwise show nothing new
      const r = await focus(FIXTURE, "loadUser", B);
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
    resetSessions();
    const r = await focus(FIXTURE, "loadUser", 4000);
    expect(r.text).toContain("▲"); // hot tier renders full signature lines
    expect(r.text).toContain("loadUser");
  });


  it("recovers equivalent camelCase and inflected symbol queries", async () => {
    resetSessions();
    const plural = await focus(FIXTURE, "loadsUsers", 1200);
    expect(Number(plural.details.seeds)).toBeGreaterThan(0);
    expect(plural.text).toContain("loadUser");

    resetSessions();
    const switchQuery = await focus(FIXTURE, "switchServer", 1200);
    expect(Number(switchQuery.details.seeds)).toBeGreaterThan(0);
    expect(switchQuery.text).toContain("ClientConnection.switchingServers");
    expect(switchQuery.text).toContain("web/server-switcher.ts:2");
  });

  it("suggests nearby symbols when a typo cannot seed the graph", async () => {
    resetSessions();
    const r = await focus(FIXTURE, "loadUsr", 256);
    expect(r.tokens).toBeLessThanOrEqual(256);
    expect(r.details.seeds).toBe(0);
    expect(r.text).toContain("Nearby symbols:");
    expect(r.text).toContain("loadUser");
    expect(Array.isArray(r.details.suggestions)).toBe(true);
  });

  it("explains direct call relationships before the thermal periphery", async () => {
    resetSessions();
    const r = await focus(FIXTURE, "loadUser", 1600);
    expect(r.text).toContain("← caller");
    expect(r.text).toContain("GetUserHandler");
    expect(r.text).toContain("call-target-resolution");
    const direct = (r.details.nodes as Array<{ relation?: string; evidence?: { strategy: string; rule: string; source: string } }>)
      .find((node) => node.relation?.includes("caller"));
    expect(direct?.evidence).toMatchObject({ rule: "call-target-resolution", source: "LoadUser" });
  });

  it("focuses exact protocol feature ids across declarations and clients", async () => {
    const map = await sketch(FIXTURE, 2000);
    for (const feature of [
      "⚑ RPC users.v1.Users/GetUser",
      "⚑ RPC SERVICE users.v1.Users",
      "⚑ GRAPHQL QUERY user",
      "⚑ TRPC loadUser",
      "⚑ CHANNEL users.changed",
    ]) expect(map.text).toContain(feature);

    for (const [query, expected] of [
      ["RPC users.v1.Users/GetUser", ["contracts/users.proto", "web/users.grpc.ts"]],
      ["GRAPHQL QUERY user", ["server/schema.graphql", "web/load-user.graphql"]],
      ["TRPC loadUser", ["server/trpc.ts", "web/trpc-client.ts"]],
      ["CHANNEL users.changed", ["worker/events.py", "web/events.ts"]],
      ["ORPC ping", ["server/orpc.ts"]],
      ["GET /posts", ["server/hono.ts", "web/hono-client.ts"]],
    ] as const) {
      resetSessions();
      const result = await focus(FIXTURE, query, 1800);
      expect(Number(result.details.seeds)).toBeGreaterThan(0);
      for (const file of expected) expect(result.text).toContain(file);
      if (query === "CHANNEL users.changed") {
        expect(result.text).toContain("message-channel-call:publish");
        expect(result.text).toContain("message-channel-call:subscribe");
      }
    }
  });

  it("repeats the active nucleus while suppressing previously seen periphery", async () => {
    resetSessions();
    const first = await focus(FIXTURE, "loadUser", 2000);
    const second = await focus(FIXTURE, "loadUser", 2000);
    expect(Number(second.details.suppressed)).toBeGreaterThan(0);
    expect(second.text).toContain("prior results omitted");
    for (const line of first.text.split("\n").filter((entry) => entry.includes("[focus]"))) {
      expect(second.text).toContain(line);
    }
  });

  it("starts unrelated focuses sharp and never hides their target", async () => {
    resetSessions();
    await focus(FIXTURE, "loadUser", 2000);
    const user = await focus(FIXTURE, "User", 1200);
    expect(user.text).toContain("web/api.ts:3");
    expect(user.text).toContain("[focus]");
    expect(user.details.t).toBe(2);

    await dwell(FIXTURE, 8, 800);
    const search = await focus(FIXTURE, "AirportsController.search", 800);
    expect(search.details.t).toBe(2);
    expect(search.text).toContain("web/airports.controller.ts:7");
  });

  it("supports reproducible fresh focus and source scoping", async () => {
    resetSessions();
    await focus(FIXTURE, "loadUser", 1200);
    const delta = await focus(FIXTURE, "loadUser", 1200);
    expect(Number(delta.details.suppressed)).toBeGreaterThan(0);
    const fresh = await focus(FIXTURE, "loadUser", 1200, {
      fresh: true,
      path: "web",
      language: "TypeScript",
      kind: "function",
    });
    expect(fresh.details.suppressed).toBe(0);
    expect(fresh.text).toContain("web/api.ts:8");
    expect(fresh.text).not.toContain("server/users.go:13");
    expect(Array.isArray(fresh.details.nodes)).toBe(true);
    expect(Array.isArray(fresh.details.suggestedReads)).toBe(true);
    const reads = fresh.details.suggestedReads as Array<{ path: string; offset: number; limit: number }>;
    expect(reads.filter((read) => read.path === "web/api.ts")).toHaveLength(1);

    await focus(FIXTURE, "loadUser", 256, { fresh: true, path: "web", language: "TypeScript" });
    const wider = await dwell(FIXTURE, 8, 1200);
    const widenedNodes = wider.details.nodes as Array<{ file: string; language: string }>;
    expect(widenedNodes.length).toBeGreaterThan(0);
    expect(widenedNodes.every((node) => node.file.startsWith("web/") && node.language === "TypeScript")).toBe(true);
  });

  it("dwell deepens the field and reports the t transition", async () => {
    resetSessions();
    await focus(FIXTURE, "loadUser", 800);
    const d = await dwell(FIXTURE, 2, 1600);
    expect(d.tokens).toBeLessThanOrEqual(1600);
    expect(d.text).toContain("dwell");
    expect(d.text).toContain("context widened 2×");
    expect(Number(d.details.to)).toBe(4);
  });

  it("impact warms the client and spec when the Go handler file is edited", async () => {
    resetSessions();
    const r = await impact(FIXTURE, { files: ["server/users.go"], includeUncommitted: false, budget: 2000 });
    expect(r.tokens).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("fovea impact");
    expect(r.text).toContain("web/api.ts");      // shares the /api/users literal
    expect(r.text).toContain("openapi.yaml");    // same route in the spec
    expect(r.text).toContain("worker/search.rs"); // same route literal in Rust
    expect(r.details.warmedReasons).toBeTruthy();
    const reasons = r.details.warmedReasons as Record<string, string[]>;
    expect(reasons["web/api.ts"]).toContain("shared literal");
    expect(reasons["worker/search.rs"]).not.toContain("graph path");
    const evidence = r.details.warmedEvidence as Record<string, Array<{ strategy: string; rule: string; source: string }>>;
    expect(evidence["web/api.ts"]?.some((item) =>
      item.strategy === "normalized-literal" && item.rule === "literal-path" && item.source.startsWith("/api/users"),
    )).toBe(true);
    // the seed file's own symbols are not part of the review list
    expect(r.text.split("\n").filter((l) => l.startsWith("server/users.go"))).toHaveLength(0);
  });

  it("impact depends on the current cascade, not earlier impact or focus disclosure", async () => {
    resetSessions();
    const prepared = await ensureState(FIXTURE);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const session = getSession(FIXTURE);
      const initial = structuredClone(session);
      const args = { files: ["server/users.go"], includeUncommitted: false, budget: 2000 };
      const first = await impact(FIXTURE, args, prepared);
      expect(session).toEqual(initial);
      await impact(FIXTURE, { ...args, files: ["worker/jobs.py"] }, prepared);
      await focus(FIXTURE, "users", 2000);
      const focused = structuredClone(session);
      expect(await impact(FIXTURE, args, prepared)).toEqual(first);
      expect(session).toEqual(focused);
      expect(session).not.toHaveProperty("reviewMemory");
    } finally {
      clock.mockRestore();
      resetSessions();
    }
  });

  it("reports current heat within budget without retaining seedless suggestions", async () => {
    resetSessions();
    const prepared = await ensureState(FIXTURE);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const args = { files: ["server/users.go"], includeUncommitted: false };
      const first = await impact(FIXTURE, { ...args, budget: 2000 }, prepared);
      for (const B of [256, 300, 512, 2000]) {
        const bounded = await impact(FIXTURE, { ...args, budget: B }, prepared);
        expect(bounded.tokens).toBeLessThanOrEqual(B);
        expect(bounded.details.warmedMass).toEqual(first.details.warmedMass);
        expect(bounded.details.conservedMass).toEqual(first.details.conservedMass);
        for (const key of ["review", "obligations", "epoch"]) expect(bounded.details).not.toHaveProperty(key);
        expect(bounded.text).not.toMatch(/review memory|obligations ·|prior epoch cleared/);
      }
      for (const files of [[], ["nope/nothing.ts"]]) {
        const clean = await impact(FIXTURE, { files, includeUncommitted: false, budget: 256 }, prepared);
        expect(clean.tokens).toBeLessThanOrEqual(256);
        expect(clean.details.seeds).toBe(0);
        expect(clean.text).toContain("no seed files");
        expect(clean.text).not.toContain("web/api.ts");
        for (const key of ["review", "obligations", "epoch", "warmedFiles"]) expect(clean.details).not.toHaveProperty(key);
      }
    } finally {
      clock.mockRestore();
      resetSessions();
    }
  });

  it("budgets are hard even with hundreds of lit nodes (min clamp)", async () => {
    resetSessions();
    for (const B of [256, 300, 400, 600]) {
      const r = await focus(FIXTURE, "users", B); // broad substring: lights most of the graph
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
  });

  it("impact with unknown files guides instead of crashing", async () => {
    const r = await impact(FIXTURE, { files: ["nope/nothing.ts"], includeUncommitted: false });
    expect(r.text).toContain("no seed files");
  });
});
