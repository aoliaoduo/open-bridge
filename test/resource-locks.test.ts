import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  acquireLocks,
  lockSnapshot,
  resetLocks,
  type LockRelease,
} from "../src/bridge/runtime/resource-locks.js";

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

test("a timed-out writer's removal wakes the reader queued behind it", async () => {
  // Writer priority keeps a reader queued behind an earlier conflicting writer,
  // even when the reader's own key is free. So when that writer's deadline
  // fires, its removal UNBLOCKS the reader — and the wait-timer path used to
  // splice the writer out without pumping. The reader then stayed queued
  // against a key nobody held and was rejected with "another tool call is still
  // holding it" after its own full deadline, with the key demonstrably free.
  const held = await acquireLocks({ keys: ["file:a"], mode: "write", label: "holder" }, FAST);

  // The writer must be queued BEFORE the reader asks, otherwise the reader takes
  // the conflict-free fast path and never waits behind it.
  const writer = acquireLocks({ keys: ["file:a", "file:b"], mode: "write", label: "writer" }, { ...FAST, waitTimeoutMs: 60 });
  const writerRejected = assert.rejects(writer, /Timed out/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(lockSnapshot().waiting.map(entry => entry.label), ["writer"], "the writer is queued first");

  // A reader on file:b only: grantable throughout, but blocked by that writer.
  // Its deadline is comfortably later than the writer's, so a reader that is
  // not woken by the timeout has time to be granted before this asserts.
  let granted = false;
  const reader = acquireLocks({ keys: ["file:b"], mode: "read", label: "reader" }, { ...FAST, waitTimeoutMs: 400 })
    .then(release => { granted = true; return release; });

  await whileLoopRuns(async () => {
    await writerRejected;
    for (let i = 0; i < 30 && !granted; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  });

  assert.equal(granted, true, "the reader was granted as soon as the writer left the queue");
  assert.equal(lockSnapshot().waiting.some(entry => entry.label === "reader"), false);
  (await reader)();
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

test("a handed-off lock outlives the hold timeout: a live process keeps it", () =>
  whileLoopRuns(async () => {
    // Regression: a spawn that declares resource_keys hands the lease to the
    // process so the resource stays reserved "for the process's lifetime"
    // (dispatcher.handOffToProcess). The hold-timeout backstop used to stay
    // armed, so a dev server outliving holdTimeoutMs had its lock reclaimed and
    // re-granted to the next caller while it was still running — the exact
    // double-claim resource_keys exists to prevent.
    const reclaims: Array<{ keys: string[]; label: string }> = [];
    const release = await acquireLocks(
      { keys: ["port:5173"], mode: "write", label: "dev server" },
      { holdTimeoutMs: 40, waitTimeoutMs: 200, onReclaim: info => reclaims.push(info) },
    );

    // The caller returns from its handler, the process is alive: hand off.
    release.handOff?.();

    await new Promise(resolve => setTimeout(resolve, 110));

    assert.equal(reclaims.length, 0, "the clock must not reclaim a live process's lock");
    assert.deepEqual(
      lockSnapshot().held.map(entry => entry.key),
      ["port:5173"],
      "the key is still reported as held",
    );

    // A second caller declaring the same port must be refused outright.
    await assert.rejects(
      acquireLocks({ keys: ["port:5173"], mode: "write", label: "second server" }, { holdTimeoutMs: 0, waitTimeoutMs: 80 }),
      /Timed out after .* waiting for port:5173/,
      "the reserved port cannot be claimed twice",
    );

    // Only the process exiting — which calls the handed-off release — frees it.
    release();
    assert.deepEqual(lockSnapshot(), { held: [], waiting: [] });

    // handOff after release is a harmless no-op.
    release.handOff?.();
    const next = await acquireLocks({ keys: ["port:5173"], mode: "write", label: "third" }, FAST);
    next();
  }));

test("a lock that is never handed off is still reclaimed by the hold timeout", async () => {
  // The backstop must survive the fix: a plain synchronous call that never
  // returns is still reclaimed, so one wedged tool call cannot wedge a key.
  const reclaims: string[] = [];
  await acquireLocks(
    { keys: ["file:a"], mode: "write", label: "wedged" },
    { holdTimeoutMs: 40, waitTimeoutMs: 500, onReclaim: info => reclaims.push(info.label) },
  );
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.deepEqual(reclaims, ["wedged"]);
  assert.deepEqual(lockSnapshot().held, []);
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

test("holdTimeoutMs 0 means unlimited: the holder is never reclaimed", () =>
  whileLoopRuns(async () => {
    const reclaims: string[] = [];
    const holder = await acquireLocks(
      { keys: ["file:zero-hold"], mode: "write", label: "holder" },
      { holdTimeoutMs: 0, waitTimeoutMs: 1_000, onReclaim: info => reclaims.push(info.label) },
    );
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(reclaims, [], "0 must not arm a reclaim timer (the console renders it as 0 = unlimited)");
    // Still held, not reclaimed: a second writer has to time out.
    await assert.rejects(
      acquireLocks(
        { keys: ["file:zero-hold"], mode: "write", label: "other" },
        { holdTimeoutMs: 0, waitTimeoutMs: 80 },
      ),
      /Timed out/,
    );
    holder();
  }));

test("waitTimeoutMs 0 means unlimited: a queued caller waits instead of being rejected", () =>
  whileLoopRuns(async () => {
    const release = await acquireLocks(
      { keys: ["file:zero-wait"], mode: "write", label: "holder" },
      FAST,
    );
    let granted = false;
    const pending = acquireLocks(
      { keys: ["file:zero-wait"], mode: "write", label: "waiter" },
      { holdTimeoutMs: 0, waitTimeoutMs: 0 },
    ).then(release2 => { granted = true; return release2; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(granted, false, "0 must not arm a wait deadline (the console renders it as 0 = unlimited)");
    release();
    const waiterRelease = await pending;
    assert.equal(granted, true, "the waiter is granted as soon as the holder releases");
    waiterRelease();
  }));

test("high concurrency: many callers on independent and shared keys resolve correctly", async () => {
  const count = 25;
  const results: number[] = [];
  const promises = Array.from({ length: count }, async (_, i) => {
    const key = `key:${i % 5}`;
    const mode = i % 2 === 0 ? "read" : "write";
    const release = await acquireLocks({ keys: [key], mode, label: `task-${i}` }, FAST);
    results.push(i);
    await new Promise(r => setTimeout(r, 2));
    release();
  });
  await Promise.all(promises);
  assert.equal(results.length, count);
  assert.deepEqual(lockSnapshot(), { held: [], waiting: [] });
});
