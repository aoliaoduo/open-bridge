import { test } from "node:test";
import assert from "node:assert/strict";
import { clampMs } from "../src/bridge/process-tools.js";

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
