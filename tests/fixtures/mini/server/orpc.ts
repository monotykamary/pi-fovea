// oRPC-style procedure declarations rooted at the `os` builder identifier.
const os: any = {
  route: (handler: unknown) => handler,
  handler: (handler: unknown) => handler,
  input: () => os,
  router: (members: Record<string, unknown>) => members,
};

export const planetRouter = os.router({
  ping: os.route(async () => "pong"),
  pong: os.handler(() => "ping"),
  echo: os.input("schema").handler(({ input }: { input: unknown }) => input),
});

export const listPlanet = os.planet.list
  .handler(async ({ input }: { input: unknown }) => input);
export const findPlanet: unknown = os.input("schema").handler(() => null);

// Negative: receivers not rooted at `os` stay unanchored.
export const detached = os.input("schema");
export const detachedHandler = detached.handler(() => "detached");
const wrongBuilder = { route: (handler: unknown) => handler };
export const wrongRoot = wrongBuilder.route(async () => "wrong");
