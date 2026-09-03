// Hono RPC client over an inferred app: the property names the route stem.
const client: any = {};

client.posts.$get();
client.health.$post();

// Negative: a deeper chain changes the receiver, so it stays unanchored.
export const deepChain = client.deep.chain.$get();
