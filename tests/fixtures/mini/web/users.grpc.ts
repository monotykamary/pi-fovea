export function loadUserRpc(client: any, request: unknown, callback: (error?: Error) => void) {
  const computedPath = "/users.v1.Users/Computed";
  client.makeUnaryRequest(computedPath, JSON.stringify, JSON.parse, request, callback);
  return client.makeUnaryRequest(
    "/users.v1.Users/GetUser",
    JSON.stringify,
    JSON.parse,
    request,
    callback,
  );
}
