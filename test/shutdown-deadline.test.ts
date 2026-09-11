import assert from "node:assert/strict";
import test from "node:test";
import {armShutdownDeadline, SHUTDOWN_DEADLINE_MS} from "../src/bridge/shutdown-deadline.js";

/**
 * "stop" has to end with a dead process even when a step inside the graceful
 * path never resolves (a wedged transport close, a file lock that keeps being
 * retried). The deadline is the guarantee; the console-close and Ctrl+C paths
 * both arm it before their first await.
 */
test("the deadline fires when the graceful path does not finish", async () => {
  let fired = 0;
  armShutdownDeadline(() => { fired += 1; }, 5);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fired, 1);
});

test("a finished shutdown cancels the deadline", async () => {
  let fired = 0;
  const cancel = armShutdownDeadline(() => { fired += 1; }, 5);
  cancel();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fired, 0);
});

test("the default deadline is long enough for a real drain", () => {
  assert.ok(SHUTDOWN_DEADLINE_MS >= 5_000, String(SHUTDOWN_DEADLINE_MS));
});
