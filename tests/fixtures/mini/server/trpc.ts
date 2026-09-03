interface Procedure {
  query: (handler: () => unknown) => unknown;
  mutation: (handler: () => unknown) => unknown;
  input: (schema?: unknown) => Procedure;
}

const publicProcedure: Procedure = {
  query: (handler: () => unknown) => handler,
  mutation: (handler: () => unknown) => handler,
  input: () => publicProcedure,
};

const t = { procedure: publicProcedure };
const router = (procedures: object) => procedures;

export const appRouter = router({
  loadUser: publicProcedure.query(() => ({ id: "fixture-user" })),
  createUser: t.procedure.input("schema").mutation(() => ({ id: "new-user" })),
});
