/**
 * Resource-lock ownership across a managed process's auto-restart lifecycle.
 *
 * This is the one path that had no coverage at all, and it leaked locks in
 * production: `dispatcher.handOffToProcess` moves a call's `resource_keys` lease
 * onto the spawned command AND disarms the lock's hold-timeout backstop (a live
 * process owns the resource, so no clock may reclaim it). The close handler then
 * deliberately keeps that handle alive while a restart is pending. So anything
 * that cancels the restart has to release the handle itself — the backstop that
 * would otherwise recover it is gone by design, and the process it belonged to
 * has already exited.
 *
 * The failure it pins: every later call declaring the same `resource_keys`
 * waited out the full `concurrency.waitTimeoutMs` and failed with "another tool
 * call is still holding it", while the console kept showing a dead command as
 * the holder. When `restart_process` had already replaced the CommandState in
 * `state.commands`, even `pruneCommands`' hourly safety net could not free it.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { acquireLocks, lockSnapshot, resetLocks } from "../src/bridge/runtime/resource-locks.js";
import { cancelPendingRestart, cancelScheduledRestart, terminateProcess, type CommandState } from "../src/bridge/runtime/processes.js";

const FAST = { holdTimeoutMs: 5_000, waitTimeoutMs: 200 };

beforeEach(() => resetLocks());

/**
 * A crashed command that is waiting out `restartDelayMs`, holding a resource
 * lease the dispatcher handed off to it. `terminateProcess` never touches
 * `child` on the `done` path, so the inert stand-in is enough to exercise the
 * real cancel-and-release logic.
 */
function crashedWithPendingRestart(release: () => void): CommandState {
  return {
    id: "cmd-pending-restart",
    done: true,
    exitCode: 1,
    endedAt: Date.now(),
    requestedStop: undefined,
    autoRestart: true,
    maxRestarts: 3,
    restartDelayMs: 60_000,
    lastEvent: "restart_scheduled",
    restartTimer: setTimeout(() => { /* never fires inside the test window */ }, 60_000),
    releaseResourceLocks: release,
    child: { pid: undefined } as unknown as CommandState["child"],
  } as unknown as CommandState;
}

test("cancelling a pending auto-restart releases the resource lease it held", async () => {
  const release = await acquireLocks({ keys: ["res:port:5173"], mode: "write", label: "start_process · res:port:5173" }, FAST);
  // The dispatcher's hand-off: the lock now lives as long as the process, and
  // the hold-timeout backstop can no longer reclaim it.
  release.handOff?.();
  let leaseReleased = false;
  const command = crashedWithPendingRestart(() => {
    leaseReleased = true;
    release();
  });

  await terminateProcess(command, "terminated");

  assert.equal(command.restartTimer, undefined, "the scheduled restart is cancelled");
  assert.equal(leaseReleased, true, "the cancelled restart's lease is released");

  // The proof that matters: the key is free again, so the next caller is granted
  // immediately instead of waiting out the whole wait deadline.
  const started = Date.now();
  const again = await acquireLocks({ keys: ["res:port:5173"], mode: "write", label: "second caller" }, FAST);
  again();
  assert.ok(Date.now() - started < 150, "re-acquiring the key does not wait out the deadline");
  assert.deepEqual(lockSnapshot().waiting, [], "nobody is left queued behind the dead command");
});

test("a cancelled command is marked stopped, so a late timer cannot resurrect it", () => {
  // `cancelPendingRestart` runs on paths that do not set `requestedStop` first
  // (the policy toggle, the fresh-instance sweep), and the restart callback
  // checks that flag before respawning.
  const command = crashedWithPendingRestart(() => { /* lease not under test here */ });
  assert.equal(command.requestedStop, undefined, "nothing marked it before the cancel");

  cancelPendingRestart(command);

  assert.equal(command.restartTimer, undefined);
  assert.equal(command.requestedStop, "stopped", "the cancelled command is marked stopped");
});

test("a lease that a restart is carrying is not released by the termination", async () => {
  // `restart_process` takes the handle off the old command before terminating
  // it and puts it on the replacement (process-tools.ts). This pins the
  // mechanism it relies on: once the handle has been detached, terminating the
  // old record must not release a lease the replacement now owns — otherwise
  // the reservation is silently given up for the replacement's whole lifetime,
  // and a second caller declaring the same `resource_keys` is granted the same
  // port or output directory.
  const release = await acquireLocks({ keys: ["res:port:5173"], mode: "write", label: "start_process · res:port:5173" }, FAST);
  release.handOff?.();
  let releasedByOldRecord = false;
  const oldRecord = crashedWithPendingRestart(() => {
    releasedByOldRecord = true;
    release();
  });

  // What restartProcess does before calling terminateProcess.
  const carried = oldRecord.releaseResourceLocks;
  oldRecord.releaseResourceLocks = undefined;

  await terminateProcess(oldRecord, "stopped");

  assert.equal(releasedByOldRecord, false, "the old record no longer holds the lease");

  // The replacement now owns it and can still free the key on its own exit.
  assert.equal(typeof carried, "function");
  carried?.();
  assert.equal(lockSnapshot().held.some(entry => entry.key === "res:port:5173"), false, "the replacement's exit frees it");
});

test("cancelling a command that never held a lease is harmless", () => {
  const command = crashedWithPendingRestart(() => { /* not reached */ });
  delete command.releaseResourceLocks;
  assert.doesNotThrow(() => cancelPendingRestart(command));
  assert.equal(command.restartTimer, undefined);
});

test("the policy toggle's cancel releases the lease without marking the command stopped", async () => {
  // `set_process_policy {auto_restart: false}` used to bare-clearTimeout the
  // scheduled restart: the hand-off had already disarmed the hold-timeout
  // backstop, so the lease stayed with the dead command until the hourly prune
  // and every later caller declaring the same key waited out the deadline. The
  // toggle is NOT a stop, though — the command crashed, and the operator only
  // declined to bring it back — so the marking side of `cancelPendingRestart`
  // (requestedStop, which rewrites a crash into a requested stop in every
  // snapshot) must not apply.
  const release = await acquireLocks({ keys: ["res:port:5174"], mode: "write", label: "start_process · res:port:5174" }, FAST);
  release.handOff?.();
  let leaseReleased = false;
  const command = crashedWithPendingRestart(() => {
    leaseReleased = true;
    release();
  });
  assert.equal(command.requestedStop, undefined, "nothing marked it before the toggle");

  cancelScheduledRestart(command);

  assert.equal(command.restartTimer, undefined, "the scheduled restart is cancelled");
  assert.equal(leaseReleased, true, "the cancelled restart's lease is released");
  assert.equal(command.requestedStop, undefined, "the policy toggle is not a stop");
  assert.equal(command.lastEvent, "restart_cancelled");

  const started = Date.now();
  const again = await acquireLocks({ keys: ["res:port:5174"], mode: "write", label: "second caller" }, FAST);
  again();
  assert.ok(Date.now() - started < 150, "re-acquiring the key does not wait out the deadline");
});

test("the policy toggle's cancel is a no-op while the process is still live", async () => {
  // A live process holding a hand-off lease has no scheduled restart; the
  // toggle only changes what happens AFTER its eventual exit, so the lease of
  // a RUNNING process must not be released by the policy write itself.
  const release = await acquireLocks({ keys: ["res:port:5175"], mode: "write", label: "start_process · res:port:5175" }, FAST);
  release.handOff?.();
  let leaseReleased = false;
  const command = crashedWithPendingRestart(() => {
    leaseReleased = true;
    release();
  });
  command.done = false;
  command.restartTimer = undefined;

  cancelScheduledRestart(command);

  assert.equal(leaseReleased, false, "a live process keeps its lease through a policy change");
  release();
});

test("terminating a LIVE process leaves the lease to the close handler", async () => {
  // terminateProcess used to release the resource lease at REQUEST time
  // (cancelPendingRestart releases unconditionally): for a process that was
  // still alive the lock went idle while the process kept running — a second
  // start_process could claim the same port before the first one died, and a
  // kill that failed outright left the survivor running unclaimed. The
  // release belongs to the close handler; only an already-exited command
  // with a cancelled restart needs the cancellation to release, because no
  // second close will come.
  const release = await acquireLocks({ keys: ["res:port:5176"], mode: "write", label: "start_process · res:port:5176" }, FAST);
  release.handOff?.();
  let released = false;
  let onClose: (() => void) | undefined;
  const command = {
    id: "cmd-live-terminate",
    done: false,
    exitCode: null,
    autoRestart: false,
    maxRestarts: 3,
    restartDelayMs: 1000,
    lastEvent: "started",
    startedAt: Date.now(),
    command: "node server.js",
    cwd: ".",
    env: {},
    restartCount: 0,
    releaseResourceLocks: () => { released = true; release(); },
    child: {
      // pid: undefined routes terminateProcess through the direct kill()
      // branch on every platform; the stub fires close on the microtask, as
      // a real dying process would.
      pid: undefined,
      killed: false,
      kill() { queueMicrotask(() => onClose?.()); },
      once(event: string, fn: () => void) { if (event === "close") onClose = fn; },
      off() {},
    } as unknown as CommandState["child"],
  } as unknown as CommandState;

  const stopped = await terminateProcess(command, "terminated");
  assert.equal(stopped, true, "the stub's close settles the termination");
  assert.equal(released, false, "the terminate request itself must not release the lease");
});
