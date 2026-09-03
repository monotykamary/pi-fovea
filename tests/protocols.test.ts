import { describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { extractAnchors } from "../src/core/anchors.js";
import { extractSymbols } from "../src/core/extract.js";
import { extractProtocolAnchors } from "../src/core/protocols.js";
import { makeFileSource } from "../src/core/source.js";
import type { SymbolRec } from "../src/core/types.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;
const DOCUMENTS = ["contracts/users.proto", "server/schema.graphql", "web/load-user.graphql"];
const CODE = ["web/users.grpc.ts", "server/trpc.ts", "web/trpc-client.ts", "worker/events.py", "web/events.ts"];

const enclosing = (symbols: SymbolRec[]) => (file: string, line: number): string | undefined => {
  let best: SymbolRec | undefined;
  for (const symbol of symbols) {
    if (symbol.file === file && symbol.line <= line && (!best || symbol.line > best.line)) best = symbol;
  }
  return best ? `${best.name}@${best.file}` : `file:${file}`;
};

describe("exact protocol documents", () => {
  it("anchors protobuf RPCs and matching GraphQL root fields without a model", async () => {
    const anchors = await extractProtocolAnchors(DOCUMENTS, makeFileSource(FIXTURE));
    const byId = new Map<string, typeof anchors>();
    for (const item of anchors) (byId.get(item.id) ?? byId.set(item.id, []).get(item.id)!).push(item);

    expect(byId.get("RPC users.v1.Users/GetUser")).toMatchObject([
      { file: "contracts/users.proto", ruleId: "proto-rpc-declaration" },
    ]);
    expect(byId.get("RPC SERVICE users.v1.Users")).toMatchObject([
      { file: "contracts/users.proto", line: 7, ruleId: "proto-service-declaration" },
    ]);
    expect(byId.get("RPC MESSAGE users.v1.GetUserRequest")?.map((item) => item.ruleId)).toEqual([
      "proto-rpc-request-type",
      "proto-message-declaration",
    ]);
    expect(byId.get("RPC MESSAGE users.v1.User")?.map((item) => item.ruleId)).toEqual([
      "proto-rpc-response-type",
      "proto-message-declaration",
      "proto-message-field-type",
      "proto-message-field-type",
      "proto-map-value-type",
    ]);
    expect(byId.get("GRAPHQL QUERY user")?.map((item) => item.file)).toEqual([
      "server/schema.graphql",
      "web/load-user.graphql",
    ]);
    expect(byId.get("GRAPHQL SUBSCRIPTION userChanged")).toMatchObject([
      { file: "server/schema.graphql", ruleId: "graphql-root-field" },
    ]);
    expect(byId.get("GRAPHQL OPERATION QUERY LoadUser")).toMatchObject([
      { file: "web/load-user.graphql", line: 1, ruleId: "graphql-operation-declaration" },
    ]);
    expect([...new Set(byId.get("GRAPHQL TYPE Query")?.map((item) => item.file))]).toEqual([
      "server/schema.graphql",
      "web/load-user.graphql",
    ]);
    expect(byId.get("GRAPHQL TYPE Query")?.some((item) =>
      item.ruleId === "graphql-inline-fragment-type" && item.line === 2,
    )).toBe(true);
    expect(byId.get("GRAPHQL TYPE UserFilter")).toContainEqual(expect.objectContaining(
      { file: "web/load-user.graphql", line: 1, ruleId: "graphql-variable-type" },
    ));
    expect(byId.has("GRAPHQL TYPE true")).toBe(false);
    expect(byId.get("GRAPHQL TYPE User")?.map((item) => item.ruleId)).toEqual([
      "graphql-field-type",
      "graphql-field-type",
      "graphql-union-member",
      "graphql-type-declaration",
    ]);
    expect(byId.get("GRAPHQL TYPE UserRole")?.map((item) => item.ruleId)).toEqual([
      "graphql-enum-declaration",
      "graphql-field-type",
    ]);
    expect(byId.get("GRAPHQL TYPE DateTime")?.map((item) => item.ruleId)).toEqual([
      "graphql-scalar-declaration",
      "graphql-field-type",
      "graphql-field-type",
    ]);
    expect(byId.get("GRAPHQL TYPE UserResult")?.map((item) => item.ruleId)).toEqual([
      "graphql-union-declaration",
    ]);
    expect(byId.get("GRAPHQL TYPE NotFound")?.map((item) => item.ruleId)).toEqual([
      "graphql-union-member",
      "graphql-type-declaration",
    ]);
    expect(byId.get("GRAPHQL TYPE Timestamped")?.map((item) => item.ruleId)).toEqual([
      "graphql-interface-declaration",
      "graphql-implements-type",
    ]);
    expect(byId.has("RPC SERVICE users.v1.Guessed")).toBe(false);
    expect(byId.has("RPC MESSAGE users.v1.Ghost")).toBe(false);
    expect(byId.has("GRAPHQL OPERATION QUERY Guessed")).toBe(false);
    expect(byId.has("GRAPHQL TYPE Ghost")).toBe(false);
  });
});

describe.skipIf(!hasAstGrep())("exact protocol call shapes", () => {
  it("anchors only literal gRPC paths, declared tRPC procedures, and channel keys", async () => {
    const symbols = await extractSymbols(CODE, FIXTURE);
    const anchors = await extractAnchors(CODE, FIXTURE, enclosing(symbols));
    const sites = anchors.map((item) => `${item.id}@${item.file}`);

    expect(sites).toContain("RPC users.v1.Users/GetUser@web/users.grpc.ts");
    expect(sites).toContain("RPC SERVICE users.v1.Users@web/users.grpc.ts");
    expect(sites).toContain("TRPC loadUser@server/trpc.ts");
    expect(sites).toContain("TRPC loadUser@web/trpc-client.ts");
    expect(sites).toContain("CHANNEL users.changed@worker/events.py");
    expect(sites).toContain("CHANNEL users.changed@web/events.ts");
    expect(sites.some((site) => site.startsWith("RPC users.v1.Users/Computed@"))).toBe(false);
    expect(sites.some((site) => site.startsWith("CHANNEL users.computed@"))).toBe(false);
    expect(anchors.find((item) => item.id === "TRPC loadUser" && item.file === "server/trpc.ts")?.ruleId)
      .toBe("trpc-procedure-declaration:query");
    expect(anchors.find((item) => item.id === "CHANNEL users.changed" && item.file === "worker/events.py")?.ruleId)
      .toBe("message-channel-call:publish");
    expect(anchors.find((item) => item.id === "CHANNEL users.changed" && item.file === "web/events.ts")?.ruleId)
      .toBe("message-channel-call:subscribe");
    expect(anchors.every((item) => typeof item.ruleId === "string")).toBe(true);
  });
});

describe.skipIf(!hasAstGrep())("orpc and hono call shapes", () => {
  it("anchors oRPC router members and standalone procedures beyond the first slot", async () => {
    const FILES = ["server/orpc.ts", "server/trpc.ts"];
    const symbols = await extractSymbols(FILES, FIXTURE);
    const anchors = await extractAnchors(FILES, FIXTURE, enclosing(symbols));
    const sites = anchors.map((item) => `${item.id}@${item.file}`);

    expect(sites).toContain("ORPC ping@server/orpc.ts");
    expect(sites).toContain("ORPC pong@server/orpc.ts");
    expect(sites).toContain("ORPC echo@server/orpc.ts");
    expect(sites).toContain("ORPC listPlanet@server/orpc.ts");
    expect(sites).toContain("ORPC findPlanet@server/orpc.ts");
    expect(anchors.find((item) => item.id === "ORPC ping")?.ruleId).toBe("orpc-procedure-declaration:route");
    expect(anchors.find((item) => item.id === "ORPC pong")).toMatchObject({ line: 11, ruleId: "orpc-procedure-declaration:handler" });
    expect(anchors.find((item) => item.id === "ORPC echo")).toMatchObject({ line: 12, ruleId: "orpc-procedure-declaration:handler" });
    expect(anchors.find((item) => item.id === "ORPC listPlanet")).toMatchObject({ line: 15, ruleId: "orpc-procedure-declaration:handler" });
    expect(sites.some((site) => site.startsWith("ORPC detachedHandler@"))).toBe(false);
    expect(sites.some((site) => site.startsWith("ORPC wrongRoot@"))).toBe(false);
    expect(sites).toContain("TRPC createUser@server/trpc.ts");
    expect(anchors.find((item) => item.id === "TRPC createUser")).toMatchObject({ line: 18, ruleId: "trpc-procedure-declaration:mutation" });
  });

  it("anchors Hono routes and joins the RPC client to the server-declared hub", async () => {
    const FILES = ["server/hono.ts", "web/hono-client.ts"];
    const symbols = await extractSymbols(FILES, FIXTURE);
    const anchors = await extractAnchors(FILES, FIXTURE, enclosing(symbols));
    const byId = new Map<string, typeof anchors>();
    for (const item of anchors) (byId.get(item.id) ?? byId.set(item.id, []).get(item.id)!).push(item);

    expect(
      [...(byId.get("GET /posts") ?? [])]
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((item) => [item.file, item.ruleId]),
    ).toEqual([
      ["server/hono.ts", "http-route-call"],
      ["web/hono-client.ts", "hono-rpc-client-call"],
    ]);
    expect(byId.get("POST /health")).toMatchObject([
      { file: "web/hono-client.ts", ruleId: "hono-rpc-client-call" },
    ]);
    expect(byId.get("PUT /posts/{*}")).toMatchObject([
      { file: "server/hono.ts", ruleId: "http-method-route-on" },
    ]);
    expect(byId.get("ALL /wild")).toMatchObject([{ file: "server/hono.ts", ruleId: "http-route-call" }]);
    expect(byId.get("ANY /middleware")).toMatchObject([{ file: "server/hono.ts", ruleId: "http-route-call" }]);
    const ids = anchors.map((item) => item.id);
    expect(ids.some((id) => id.includes("purge"))).toBe(false);
    expect(ids.some((id) => id.includes("/a") || id.includes("/b"))).toBe(false);
    expect(ids.some((id) => id.includes("deep"))).toBe(false);
  });
});
