/**
 * Unit tests for the public-domain watch policy (src/bridge/tunnel/tunnel-watch.ts):
 * the probe cadence, the consecutive-`free` counter, and the claim gate.
 *
 * The point of these tests is the asymmetry the incident taught: a *healthy*
 * borrowed tunnel is checked lazily, while an endpoint that has stopped answering
 * is checked quickly — and a claim still needs two unambiguous "nobody is here"
 * answers, never a guess.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAIM_FREE_ROUNDS, WATCH_INTERVAL_HEALTHY_MS, WATCH_INTERVAL_UNHEALTHY_MS,
  nextFreeRounds, shouldClaimDomain, watchIntervalMs,
} from "../src/bridge/tunnel/tunnel-watch.js";

test("a healthy tunnel is probed lazily, an unhealthy one quickly", () => {
  assert.equal(watchIntervalMs(true), WATCH_INTERVAL_HEALTHY_MS);
  assert.equal(watchIntervalMs(false), WATCH_INTERVAL_UNHEALTHY_MS);
  assert.ok(WATCH_INTERVAL_UNHEALTHY_MS < WATCH_INTERVAL_HEALTHY_MS,
    "the unhealthy cadence must be the faster one — that is the whole change");
});

test("only a `free` verdict advances the counter", () => {
  assert.equal(nextFreeRounds(0, "free"), 1);
  assert.equal(nextFreeRounds(1, "free"), 2);
  for (const verdict of ["mine", "other", "unknown"] as const) {
    assert.equal(nextFreeRounds(5, verdict), 0, `${verdict} proves nothing about the domain`);
  }
});

test("claiming needs two consecutive free verdicts, not one", () => {
  assert.equal(CLAIM_FREE_ROUNDS, 2, "the documented contract");
  assert.equal(shouldClaimDomain(0, false), false);
  assert.equal(shouldClaimDomain(1, false), false, "one free answer is not enough");
  assert.equal(shouldClaimDomain(2, false), true);
});

test("an unknown verdict after a free one resets the count, so a flapping edge never claims", () => {
  let rounds = nextFreeRounds(0, "free");     // 1
  rounds = nextFreeRounds(rounds, "unknown"); // 0 — the holder may be mid-reconnect
  assert.equal(shouldClaimDomain(rounds, false), false);
  rounds = nextFreeRounds(rounds, "free");    // 1
  assert.equal(shouldClaimDomain(rounds, false), false, "still needs a second consecutive one");
  rounds = nextFreeRounds(rounds, "free");    // 2
  assert.equal(shouldClaimDomain(rounds, false), true);
});

test("a busy instance never claims, however free the domain looks", () => {
  assert.equal(shouldClaimDomain(5, true), false, "the reconnect chain is the other claimant");
  assert.equal(shouldClaimDomain(2, true), false);
  assert.equal(shouldClaimDomain(2, false), true);
});
