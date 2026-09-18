import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Tests must never prune a real session's caches or leave their own behind. */
export function isolatedTestTemp(prefix: string): Record<"TMPDIR" | "TMP" | "TEMP", string> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  process.once("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A killed child may still hold a Windows handle; never mask test results.
    }
  });
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}
