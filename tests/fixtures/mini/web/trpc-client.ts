declare const trpc: {
  loadUser: { query(input: { id: string }): Promise<unknown> };
};

export const loadUserFromTrpc = (id: string) => trpc.loadUser.query({ id });
