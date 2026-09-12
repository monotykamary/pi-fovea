// Shared scheduling primitives. Pi runs extensions on the single Node event
// loop that also serves the TUI: every long sync IO/CPU stretch freezes the
// interface. The two fixes are (a) never block on one subprocess/file at a
// time and (b) yield inside irreversibly synchronous CPU sweeps so input and
// rendering keep flowing.

export const envInt = (name: string, dflt: number, min: number, max: number): number => {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return dflt;
  return Math.max(min, Math.min(max, Math.floor(raw)));
};

/**
 * Max concurrent child processes (ast-grep, git) across the whole extension.
 * ast-grep already parallelizes parsing inside each process (auto --threads
 * ≈ cores), so values above ~4 mostly add contention instead of throughput.
 */
export const SPAWN_CONCURRENCY = envInt("FOVEA_SPAWN_CONCURRENCY", 3, 1, 32);
/** Max concurrent file reads/stats. */
export const IO_CONCURRENCY = envInt("FOVEA_IO_CONCURRENCY", 32, 4, 512);
/** Bounded observation ring; independent of heavyweight graph residency. */
export const OBSERVED_ROOT_LIMIT = envInt("FOVEA_MAX_ROOTS", 32, 1, 32);
/** Heavy graphs, fact stores, and numerical vectors remain a small hot cache. */
export const ROOT_CACHE_LIMIT = envInt("FOVEA_CACHE_ROOTS", 2, 1, 32);

/** Run fn over items with a global concurrency cap, preserving input order. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return out;
};

/** A semaphore all subprocess spawns share, so burst callers stay bounded. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export const spawnGate = new Semaphore(SPAWN_CONCURRENCY);

/** Yield one macrotask; lets the TUI repaint and drain input mid-sweep. */
export const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Yielding loop helper for long synchronous sweeps. Returns a promise; call
 * sites `await forEachChunked(...)` so 100k-node assemblies never hold the
 * event loop for longer than one batch (~a few ms).
 */
export const forEachChunked = async <T>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T, index: number) => void,
): Promise<void> => {
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && i % batchSize === 0) await yieldToLoop();
    fn(items[i]!, i);
  }
};
