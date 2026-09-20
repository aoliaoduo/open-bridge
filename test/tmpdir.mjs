/**
 * Best-effort teardown for temporary workspaces. Windows child processes,
 * antivirus and indexers may hold handles briefly after termination.
 * Retry briefly; if cleanup still fails, warn and return false rather than
 * mask the test result. A reported leftover is not claimed to be removed.
 */
import { rmSync } from "node:fs";

const RETRY_DELAYS_MS = [0, 50, 150, 300, 600];

/**
 * Delete a temp directory, tolerating the Windows handle race.
 * Never throws: callers are teardown hooks, where throwing fails a suite that
 * already passed.
 */
export function removeTempDir(dir) {
  if (!dir) return true;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i += 1) {
    const wait = RETRY_DELAYS_MS[i];
    if (wait > 0) sleepSync(wait);
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      // force:true already swallows ENOENT; anything else is a live handle.
      // Only the final attempt is worth reporting.
      if (i === RETRY_DELAYS_MS.length - 1) {
        process.stderr.write(`[test cleanup] left ${dir} behind: ${err?.code ?? err}\n`);
      }
    }
  }
  return false;
}

/**
 * Teardown hooks are sync in most of these suites, and Atomics.wait is the
 * only way to block without turning every caller async.
 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
