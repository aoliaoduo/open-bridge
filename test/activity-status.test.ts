import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_STATUSES, isActivityStatus } from "../src/mcp/activity-status.js";

test("activity status guard recognises the writer vocabulary, not arbitrary input", () => {
  assert.deepEqual(ACTIVITY_STATUSES, ["running", "completed", "error", "progress", "warning"]);
  for (const status of ACTIVITY_STATUSES) assert.equal(isActivityStatus(status), true);
  for (const value of [null, undefined, 1, {}, [], "", "WARNING", "future-status"]) {
    assert.equal(isActivityStatus(value), false);
  }
});
