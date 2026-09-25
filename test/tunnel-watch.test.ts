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
  createWatchChain, nextFreeRounds, shouldClaimDomain, watchIntervalMs,
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

test("a retired chain's in-flight round neither acts again nor reschedules", async () => {
  // The tunnel watch used to key "should I reschedule?" on the timer handle
  // alone: the handle is SPENT the moment it fires, so a stop (or a claim
  // taking over) during a round in flight could not reach the chain — the
  // round's finally re-armed a ghost chain that kept claiming free domains
  // and restarted deliberately stopped instances. The chain therefore carries
  // a generation: stop() bumps it, and a retired round's finally is a no-op.
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const setTimer = (fn: () => void, ms: number): unknown => {
    const timer = { fn, ms, cleared: false };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };
  const microtasks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  const roundChainIds: number[] = [];
  const chain = createWatchChain({
    round: async chainId => {
      roundChainIds.push(chainId);
      return true;
    },
    intervalMs: () => 10,
    setTimer,
    clearTimer,
    onError: () => assert.fail("no errors expected"),
  });

  chain.start();
  assert.equal(timers.length, 1);
  assert.equal(chain.generation(), 0);

  timers[0]!.fn();          // the round fires and is in flight
  chain.stop();             // retired mid-round
  await microtasks();       // the round settles; its finally runs

  assert.equal(roundChainIds.length, 1);
  assert.equal(timers.length, 1, "the retired round scheduled nothing new");
  assert.equal(timers[0]!.cleared, false, "nothing left to clear (the handle was spent)");
});

test("a live chain keeps rescheduling across rounds and reports the generation", async () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number): unknown => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (handle: unknown): void => {
    const index = timers.indexOf(handle as { fn: () => void });
    if (index >= 0) timers.splice(index, 1);
  };

  let rounds = 0;
  const chain = createWatchChain({
    round: async () => {
      rounds += 1;
      return rounds < 3;   // healthy, healthy, unhealthy
    },
    intervalMs: healthy => (healthy ? 10 : 20),
    setTimer,
    clearTimer,
    onError: () => assert.fail("no errors expected"),
  });

  chain.start();
  for (let round = 0; round < 3; round += 1) {
    assert.equal(timers.length, 1, "exactly one pending timer per round");
    const fired = timers.shift()!;   // firing spends the handle
    fired.fn();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(rounds, 3, "the chain re-armed itself after every round");
  const lastInterval = timers.length === 1 ? timers[0]!.ms : -1;
  assert.equal(lastInterval, 20, "an unhealthy round is checked quickly");

  // A stop clears the pending timer; a start after it begins a new generation.
  chain.stop();
  assert.equal(timers.length, 0, "stop cancels the pending round");
  chain.start();
  assert.equal(chain.generation(), 1, "start after stop is a new chain generation");
  chain.stop();
});
