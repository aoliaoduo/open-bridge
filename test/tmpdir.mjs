/**
 * Removing a temp workspace on Windows is not reliably synchronous.
 *
 * A test that spawns the bridge leaves the OS holding handles for a moment
 * after SIGTERM: the child's own exit is asynchronous, and antivirus or the
 * indexer may still have the directory open. `rmSync` then fails with EPERM
 * (or EBUSY/ENOTEMPTY) on a tree that is about to become deletable. The test
 * body has already passed at that point, so the failure lands in `after` and
 * reports a green suite as a red run.
 *
 * Seen on CI at run 34875097474: a docs-only commit failed on
 * `ob-timeout-ws-*` while the identical tree passed on the commit before and
 * the commit after. That is the shape of the problem -- it is not a bug the
 * suite is meant to catch, and a random red teaches contributors to ignore
 * CI, which is worse than the flake.
 *
 * So: retry briefly, then give up quietly. Cleanup failing is not a test
 * result. The OS reclaims the temp directory regardless, and a leaked folder
 * under TMPDIR costs nothing compared to a suite nobody trusts.
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
