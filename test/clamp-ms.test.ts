import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMs } from "../src/bridge/tools/process-tools.js";

// MCP arguments are LLM-generated: a "30s" string, a null, or a negative all
// reach the handlers. The raw Math.max(Number(x), 0) pattern passed NaN
// through, and setTimeout(cb, NaN) fired at ~0 ms — instantly "timing out"
// wait_process and wedging shell sessions behind a pendingMarker.

test("valid numbers pass through unchanged", () => {
  assert.equal(clampMs(1_000, 999), 1_000);
  assert.equal(clampMs(0, 999), 0);
  assert.equal(clampMs(2_500, 999), 2_500);
});

test("garbage falls back instead of becoming NaN", () => {
  assert.equal(clampMs("abc", 120_000), 120_000);
  assert.equal(clampMs(null, 250), 250);
  assert.equal(clampMs(-5, 250), 250);
  assert.equal(clampMs(Number.NaN, 120_000), 120_000);
  assert.equal(clampMs(Number.POSITIVE_INFINITY, 120_000), 120_000);
  assert.equal(clampMs({ ms: 5 }, 250), 250);
});

test("numeric strings are accepted (a careful client may quote them)", () => {
  assert.equal(clampMs("5000", 250), 5000);
});

test("undefined takes the fallback, which is the documented default", () => {
  assert.equal(clampMs(undefined, 120_000), 120_000);
  assert.equal(clampMs(undefined, 0), 0);
});

test("an explicit max caps the value (interact_with_process waits at most 60 s)", () => {
  assert.equal(clampMs(250, 250, 60_000), 250);
  assert.equal(clampMs(600_000, 250, 60_000), 60_000);
  assert.equal(clampMs(60_000, 250, 60_000), 60_000);
  assert.equal(clampMs("abc", 250, 60_000), 250);
  assert.equal(clampMs(undefined, 250, 60_000), 250);
});

test("without an explicit max, large values still pass through", () => {
  // An hour is a legitimate wait and must survive: the ceiling added below is
  // about protecting the timer, not second-guessing long waits.
  assert.equal(clampMs(3_600_000, 250), 3_600_000);
});

/**
 * setTimeout keeps its delay in a 32-bit signed int; past 2147483647 Node
 * warns and uses 1ms instead. So `timeout_ms: 1e18` -- plainly "wait as long
 * as it takes" -- used to return in 38ms (measured) and report a process that
 * was still running as finished. Same inversion as the NaN case, at the other
 * end of the range.
 *
 * Three of the five call sites passed no max, so the ceiling belongs in the
 * helper rather than in each caller's memory.
 */
test("values beyond the 32-bit timer limit are capped, not passed through", () => {
  assert.equal(clampMs(1e18, 250), 2_147_483_647, "1e18 would have fired at ~1ms");
  assert.equal(clampMs(2_147_483_648, 250), 2_147_483_647, "one past the limit is capped");
  assert.equal(clampMs(2_147_483_647, 250), 2_147_483_647, "the largest usable value is untouched");
  assert.equal(clampMs(Number.MAX_SAFE_INTEGER, 250), 2_147_483_647);
  // An explicit max still wins when it is tighter -- the cap is a backstop.
  assert.equal(clampMs(1e18, 250, 60_000), 60_000);
  // A fallback cannot smuggle an overflowing value in either.
  assert.equal(clampMs("nonsense", 1e18), 2_147_483_647);
});
