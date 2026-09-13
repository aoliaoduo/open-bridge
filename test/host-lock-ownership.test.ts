/**
 * Ownership of the shared-file lock in the Node host's `SharedJsonStore`.
 *
 * The lock file used to record nothing — its mere existence was the lock — and
 * the holder's `finally` unlinked it unconditionally. So this interleaving was
 * possible:
 *
 *   1. Writer A acquires the lock and stalls past the 5 s staleness window
 *      (laptop sleep/resume, an antivirus scan, a debugger break).
 *   2. Writer B decides A is dead, deletes A's lock, and acquires a fresh one.
 *   3. A resumes and its `finally` deletes B's lock, which it never owned.
 *   4. Writer C now holds a lock concurrently with B. Both read-merge-write the
 *      same JSON and the later rename wins, silently dropping the other's key —
 *      the "a second instance ate the first's route token" class of lost update
 *      this lock exists to prevent.
 *
 * With an owner token in the file, a holder only ever removes a lock it still
 * holds. These tests drive the real write path; the staleness window is
 * exercised by ageing the lock file's mtime instead of sleeping through it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ob-lock-"));
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

test("a holder removes its own lock when the write finishes", async () => {
  await withHome(async home => {
    const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
    const lock = path.join(home, "config.json.lock");

    assert.equal(await exists(lock), false, "no lock before a write");

    await host.config.update("port", 4321);

    assert.equal(await exists(lock), false, "the holder cleaned up after itself");
    assert.equal(host.config.get("port", 0), 4321, "and the write landed");
  });
});

test("a writer never deletes a lock it does not own", async () => {
  // What this pins is the WAIT path: a foreign, non-stale lock must be waited
  // for and left byte-identical, never stolen or removed. The following test
  // pins the reclaim path. (The step-3 half of the race above — a resumed holder
  // unlinking a lock that is no longer its own — is guarded by the ownership
  // comparison in withFileLock and is not observable from outside without
  // interleaving inside the private body, so it is covered by that guard rather
  // than by an end-to-end assertion here.)
  await withHome(async home => {
    const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
    const lock = path.join(home, "config.json.lock");

    await fs.writeFile(lock, "owner-someone-else", "utf8");

    const write = host.config.update("port", 7777).then(() => "ok", error => `failed: ${error.message}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await fs.readFile(lock, "utf8"), "owner-someone-else", "an unowned lock is untouched");

    await fs.rm(lock, { force: true });
    assert.equal(await write, "ok", "the writer then proceeded normally");
  });
});

test("a stale lock is reclaimed and the reclaimer owns what it creates", async () => {
  await withHome(async home => {
    const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
    const lock = path.join(home, "config.json.lock");

    // A crashed writer's lock: present, but older than the staleness window.
    // Ageing mtime is how that window is exercised without a real 5 s stall.
    await fs.writeFile(lock, "owner-crashed", "utf8");
    const past = new Date(Date.now() - 10_000);
    await fs.utimes(lock, past, past);

    await host.config.update("port", 5555);

    assert.equal(host.config.get("port", 0), 5555, "the write went through the reclaimed lock");
    assert.equal(await exists(lock), false, "and the reclaimer released the lock it created");
  });
});
