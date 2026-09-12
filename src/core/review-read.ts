// Best-effort local read exposure. Unknown/rewritten results remain unacknowledged.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { observeReviewRevision, recordReviewRead, type ReviewMemory } from "./review.js";

// Keep snapshot work bounded even for a read of a giant or growing file.
const MAX_BYTES = 1024 * 1024;
const snapshot = async (path: string): Promise<{ revision: string; text: string } | undefined> => {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > stat.size || size > MAX_BYTES) return;
    const content = bytes.subarray(0, size);
    return { revision: createHash("sha1").update(content).digest("hex"), text: content.toString("utf8") };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
};

export const captureReviewRead = async (
  memory: ReviewMemory | undefined, root: string, file: string, args: { offset?: unknown; limit?: unknown },
) => {
  const entry = memory?.entries.get(file);
  if (!memory || !entry) return;
  const start = args.offset === undefined ? 1 : args.offset;
  const limit = args.limit;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 ||
    (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1))) return;
  const before = await snapshot(join(root, file));
  if (!before || memory.entries.get(file) !== entry) return;
  return { memory, entry, root, file, start, limit: limit as number | undefined, before };
};

export const finishReviewRead = async (
  capture: NonNullable<Awaited<ReturnType<typeof captureReviewRead>>>, result: unknown,
): Promise<void> => {
  const { memory, entry, root, file, before, start, limit } = capture;
  if (memory.entries.get(file) !== entry) return;
  const after = await snapshot(join(root, file));
  if (memory.entries.get(file) !== entry) return;
  observeReviewRevision(memory, file, after?.revision);
  if (!after || after.revision !== before.revision) return;
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") return;
  // Native read appends either a user-limit notice or a byte/line truncation
  // notice. Compare the actual returned source prefix, never the requested limit.
  const body = content[0].text.replace(/\n\n\[(?:\d+ more lines in file\. Use offset=\d+ to continue\.|Showing lines \d+-\d+ of \d+(?: \([^\n]*\))?\. Use offset=\d+ to continue\.)\]$/, "");
  if (!body.length) return;
  const lines = body.split("\n").length;
  if (limit !== undefined && lines > limit) return;
  const source = before.text.split("\n");
  if (start + lines - 1 > source.length || source.slice(start - 1, start - 1 + lines).join("\n") !== body) return;
  recordReviewRead(memory, file, after.revision, { start, end: start + lines - 1 });
};
