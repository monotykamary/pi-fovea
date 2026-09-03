// Hono-style route registration: verb methods, method-overload `.on`,
// mounts, and shapes that must fail closed (arrays, non-HTTP verbs).
const app: any = {};

app.get("/posts", (c: unknown) => c);
app.on("PUT", "/posts/:id", (c: unknown) => c);
app.on("GET", ["/a", "/b"], (c: unknown) => c);
app.all("/wild", (c: unknown) => c);
app.use("/middleware", (c: unknown) => c);
app.on("PURGE", "/purge", (c: unknown) => c);

export default app;
