import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  acquireLocks,
  lockSnapshot,
  resetLocks,
  type LockRelease,
} from "../src/bridge/resource-locks.js";

const FAST = { holdTimeoutMs: 5_000, waitTimeoutMs: 2_000 };

/**
 * Run `fn` while a ref'd timer holds the event loop open.
 *
 * Every timer inside resource-locks is deliberately `unref()`d — a pending lock
 * must never pin a process open — so in a test process with nothing else
 * running, the loop can drain before those timers fire. Node then cancels the
 * still-pending test with "Promise resolution is still pending but the event
 * loop has already resolved" (observed on Node 20 and 22; Node 24's runner
 * keeps the loop alive on its own).
 *
 * A real server always has the listening socket holding the loop open, which is
 * why this only ever bites the tests. Waiting on a lock deadline restores that
 * condition explicitly.
 */
async function whileLoopRuns<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = setTimeout(() => { /* hold the loop */ }, 30_000);
  try {
    return await fn();
  } finally {
    clearTimeout(keepAlive);
  }
}

beforeEach(() => resetLocks());

test("a writer excludes another writer on the same key", async () => {
  const first = await acquireLocks({ keys: ["file:a"], mode: "write", label: "one" }, FAST);
  let secondHeld = false;
  const second = acquireLocks({ keys: ["file:a"], mode: "write", label: "two" }, FAST)
    .then(release => { secondHeld = true; return release; });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(secondHeld, false, "second writer must wait");
  assert.equal(lockSnapshot().waiting.length, 1);

  first();
  const releaseSecond = await second;
  assert.equal(secondHeld, true);
  releaseSecond();
  assert.deepEqual(lockSnapshot(), { held: [], waiting: [] });
});

test("different keys do not block each other", async () => {
  const a = await acquireLocks({ keys: ["file:a"], mode: "write", label: "a" }, FAST);
  const b = await acquireLocks({ keys: ["file:b"], mode: "write", label: "b" }, FAST);
  assert.equal(lockSnapshot().held.length, 2);
  a();
  b();
});

test("readers share a key but a writer still excludes them", async () => {
  const r1 = await acquireLocks({ keys: ["file:a"], mode: "read", label: "r1" }, FAST);
  const r2 = await acquireLocks({ keys: ["file:a"], mode: "read", label: "r2" }, FAST);
  assert.equal(lockSnapshot().held.length, 2, "readers coexist");

  let writerHeld = false;
  const writer = acquireLocks({ keys: ["file:a"], mode: "write", label: "w" }, FAST)
    .then(release => { writerHeld = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writerHeld, false, "writer waits for readers");

  r1();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(writerHeld, false, "one reader still holds it");
  r2();
  const releaseWriter = await writer;
  assert.equal(writerHeld, true);
  releaseWriter();
});

test("a queued writer blocks later readers so they cannot starve it", async () => {
  const r1 = await acquireLocks({ keys: ["file:a"], mode: "read", label: "r1" }, FAST);
  const writer = acquireLocks({ keys: ["file:a"], mode: "write", label: "w" }, FAST);

  let lateReader = false;
  const reader = acquireLocks({ keys: ["file:a"], mode: "read", label: "late" }, FAST)
    .then(release => { lateReader = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lateReader, false, "reader must queue behind the writer");

  // Releasing r1 lets the queued writer in; the reader must still wait for it.
  r1();
  const releaseWriter = await writer;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lateReader, false, "the reader is still held off by the writer");

  releaseWriter();
  const releaseReader = await reader;
  assert.equal(lateReader, true, "reader proceeds once the writer is done");
  releaseReader();
});

test("multi-key acquisition is atomic and cannot deadlock across callers", async () => {
  const a = await acquireLocks({ keys: ["file:x", "file:y"], mode: "write", label: "a" }, FAST);
  let bHeld = false;
  // Overlapping key sets in the opposite order: the second caller must simply
  // wait (no cycle), because both acquire all keys at once or none.
  const b = acquireLocks({ keys: ["file:y", "file:x"], mode: "write", label: "b" }, FAST)
    .then(release => { bHeld = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(bHeld, false);
  a();
  (await b)();
  assert.deepEqual(lockSnapshot().held, []);
});

test("release is idempotent", async () => {
  const release = await acquireLocks({ keys: ["file:a"], mode: "write", label: "a" }, FAST);
  release();
  release();
  assert.deepEqual(lockSnapshot().held, []);
  // The key is free again, so a later caller is granted immediately.
  (await acquireLocks({ keys: ["file:a"], mode: "write", label: "b" }, FAST))();
});

test("no keys means no queueing at all", async () => {
  const release = await acquireLocks({ keys: [], mode: "write", label: "noop" }, FAST);
  assert.deepEqual(lockSnapshot(), { held: [], waiting: [] });
  release();
});

test("a wait deadline turns a stuck holder into a clear error", async () => {
  const held: LockRelease = await acquireLocks({ keys: ["file:a"], mode: "write", label: "holder" }, { ...FAST, waitTimeoutMs: 60 });
  // Nothing else is pending here, so the test has to hold the loop open for the
  // unref'd wait timer to fire (see whileLoopRuns).
  await whileLoopRuns(() => assert.rejects(
    acquireLocks({ keys: ["file:a"], mode: "write", label: "waiter" }, { ...FAST, waitTimeoutMs: 60 }),
    /Timed out after .*waiting for file:a/,
  ));
  assert.equal(lockSnapshot().waiting.length, 0, "the timed-out waiter left the queue");
  held();
});

test("the hold timeout reclaims an overrun lock and reports it", async () => {
  const reclaims: Array<{ keys: string[]; label: string }> = [];
  const release = await acquireLocks(
    { keys: ["file:a"], mode: "write", label: "slow" },
    { holdTimeoutMs: 40, waitTimeoutMs: 500, onReclaim: info => reclaims.push(info) },
  );
  // Hold past the cap: the scheduler reclaims it even though nobody released.
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(reclaims.length, 1);
  assert.deepEqual(reclaims[0].keys, ["file:a"]);
  assert.deepEqual(lockSnapshot().held, [], "the lock is free again");

  // The original holder's late release must be a no-op, not a double release.
  release();
  assert.deepEqual(lockSnapshot().held, []);
  const next = await acquireLocks({ keys: ["file:a"], mode: "write", label: "next" }, FAST);
  assert.equal(lockSnapshot().held.length, 1);
  next();
});

test("contention is reported once when a waiter passes the threshold", async () => {
  const notices: string[] = [];
  const held = await acquireLocks({ keys: ["res:build"], mode: "write", label: "build-a" }, FAST);
  const waiter = acquireLocks(
    { keys: ["res:build"], mode: "write", label: "build-b" },
    { ...FAST, waitTimeoutMs: 8_000, onContention: info => notices.push(info.label) },
  );
  // CONTENTION_NOTICE_MS is 3s; wait it out so the notice fires.
  await new Promise(resolve => setTimeout(resolve, 3_200));
  assert.deepEqual(notices, ["build-b"]);
  held();
  (await waiter)();
});
