import { test } from "node:test";
import assert from "node:assert/strict";
import { requireRestartKnob } from "../src/bridge/runtime/processes.js";

// Same class as clamp-ms.test.ts, one level up. MCP arguments are LLM-generated,
// so "abc", "5s", 2.5 and -1 all reach the handler. `save_service` already
// refused these; `set_process_policy` ran them through `Math.max(0, Number(x))`,
// which for NaN is NaN — not 0. The NaN then landed on a LIVE process, where it
// disabled auto-restart (`restartCount < NaN` is always false) or fired
// `setTimeout(NaN)` at ~0 ms, turning one crash into a crash-loop. Both entry
// points now share one validator, so they cannot drift apart again.

test("valid non-negative integers pass through unchanged", () => {
  assert.equal(requireRestartKnob(3, "max_restarts"), 3);
  assert.equal(requireRestartKnob(0, "max_restarts"), 0);
  assert.equal(requireRestartKnob(2500, "restart_delay_ms"), 2500);
});

test("numeric strings are accepted (a careful client may quote them)", () => {
  assert.equal(requireRestartKnob("5", "max_restarts"), 5);
  assert.equal(requireRestartKnob("1000", "restart_delay_ms"), 1000);
});

test("values that cannot become an integer are refused, not stored as NaN", () => {
  const bad: unknown[] = ["abc", "5s", Number.NaN, Number.POSITIVE_INFINITY, {}, 2.5, -1, -0.5];
  for (const value of bad) {
    assert.throws(
      () => requireRestartKnob(value, "max_restarts"),
      /max_restarts must be a non-negative integer/,
      `max_restarts=${String(value)} must be refused`,
    );
    assert.throws(
      () => requireRestartKnob(value, "restart_delay_ms"),
      /restart_delay_ms must be a non-negative integer/,
      `restart_delay_ms=${String(value)} must be refused`,
    );
  }
});

test("values that DO coerce to a valid integer still do — behaviour unchanged", () => {
  // Deliberately not tightened: save_service already accepted these, and
  // refusing them would trade a real bug for a lost capability.
  assert.equal(requireRestartKnob(null, "max_restarts"), 0);
  assert.equal(requireRestartKnob(true, "max_restarts"), 1);
  assert.equal(requireRestartKnob([], "restart_delay_ms"), 0);
});

test("the message names the knob that was wrong, and its expected type", () => {
  assert.throws(
    () => requireRestartKnob("abc", "restart_delay_ms"),
    /restart_delay_ms must be a non-negative integer\. \(expected 'restart_delay_ms': number\)/,
  );
});
