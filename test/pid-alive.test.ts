/**
 * `pidAlive` used to collapse every signal-0 failure into "no such process".
 * EPERM is the opposite answer — the process EXISTS but may not be signalled
 * (an elevated instance probed from a normal terminal on Windows) — and
 * reading it as death made an elevated instance invisible to `instances`,
 * let `stop --pid` refuse, and let a same-directory `serve` recycle the live
 * serve lock as "stale" and start a second instance on the same workspace.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pidAlive } from "../src/process/pid-alive.js";

const errno = (code: string): (pid: number) => void => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return () => {
    throw error;
  };
};

test("EPERM means alive: the process exists but may not be signalled", () => {
  assert.equal(pidAlive(4242, errno("EPERM")), true,
    "an unprobeable process is a live instance, not a stale record");
});

test("ESRCH means dead, and a successful probe means alive", () => {
  assert.equal(pidAlive(4242, errno("ESRCH")), false);
  assert.equal(pidAlive(4242, () => undefined), true);
});

test("garbage pids are dead without probing", () => {
  assert.equal(pidAlive(0, errno("EPERM")), false);
  assert.equal(pidAlive(Number.NaN, errno("EPERM")), false);
});
