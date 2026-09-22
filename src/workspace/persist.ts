import * as fs from "node:fs/promises";

/**
 * Write `data` by way of a same-directory temp file and a rename.
 *
 * An interrupted (or concurrent-reader) in-place write used to leave a
 * torn/truncated target behind, while the rename is atomic on every supported
 * platform and replaces the target.
 *
 * Accepts a Buffer as well as a string because the binary write path needs it;
 * `fs.writeFile` treats a missing encoding as utf8 for strings, so one function
 * covers both callers instead of two copies of this rule.
 *
 * Deliberately NOT synced, unlike the data-dir store in `host/node-host.ts`.
 * This path carries workspace files an agent writes many times a minute, where
 * a lost tail is re-written by the next edit and a sync would be paid on every
 * one of them; that path carries three files that cannot be reconstructed, so
 * it buys durability instead. Same primitive, two different answers, because
 * the two have different costs for being wrong.
 */
export async function writeFileAtomic(fullPath: string, data: Buffer | string): Promise<void> {
  const temp = `${fullPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, fullPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Persist text content for a file path. */
export async function persistText(fullPath: string, content: string): Promise<void> {
  await writeFileAtomic(fullPath, content);
}
