import {readdir, rm} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

/**
 * Remove build output.
 *
 * Two scopes, because one of them caused a real outage: `npm run build:core`
 * (the fast, test-facing build) reached this script with no argument, which
 * deleted all of `dist/` — including `dist/ui`, the vite bundle a RUNNING
 * instance serves `/console` from on every request. Running the core build next
 * to a live instance therefore made the operator's panel answer
 * `{"error":"Console UI is not built..."}`, and that message says nothing about
 * the build that had just removed it.
 *
 *   all  (default, `scripts/clean.mjs`)       — everything; the full build
 *                                               rebuilds the UI in the same
 *                                               command, so nothing is lost
 *   core (`scripts/clean.mjs core`)           — everything except `dist/ui`,
 *                                               which only vite produces
 *
 * Stale core output is still removed in both scopes: that is the point of
 * cleaning at all (a deleted source file must not leave its compiled twin).
 */
export async function cleanDist(rootDir, scope = "all") {
  const dist = path.join(rootDir, "dist");
  const keep = scope === "core" ? new Set(["ui"]) : new Set();
  const entries = await readdir(dist, {withFileTypes: true}).catch(() => []);
  const removed = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    await rm(path.join(dist, entry.name), {recursive: true, force: true});
    removed.push(entry.name);
  }
  return removed;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await cleanDist(fileURLToPath(new URL("..", import.meta.url)), process.argv[2] ?? "all");
}
