import { test } from "node:test";
import assert from "node:assert/strict";
import { waitTool } from "../src/bridge/process-tools.js";

/**
 * Await a wait with one ref'd handle of our own in the event loop.
 *
 * `waitTool` unrefs its timer on purpose — a pending wait must not be the thing
 * keeping a draining process alive, since `open-bridge serve` has to be able to
 * exit during one — so the timer a test is waiting on holds nothing open. On
 * CI's ubuntu 22.x job that is precisely the state node's runner reads as "the
 * loop resolved": it drained the loop mid-test, cancelled the whole file
 *   cancelledByParent · "Promise resolution is still pending but the event loop
 *   has already resolved"
 * and took all five cases with it, while the 24.x job passed. The production
 * code is not the wrong part, so the gap is closed here: a ref'd interval lives
 * exactly as long as the call being asserted, standing in for the server and
 * its connections, which is what keeps a real Bridge's loop non-empty.
 */
function holdWhile<T>(call: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => { /* see above: the loop must not drain mid-assertion */ }, 1_000);
  return call.finally(() => clearInterval(keepAlive));
}

/**
 * waitTool used to accept any safe integer, but setTimeout past 2147483647
 * warns and fires at ~1 ms (measured in this repo's own investigation of
 * timeout_ms: 1e18 — see clamp-ms.test.ts). A caller asking to wait 3e9 ms
 * got an instant return that still claimed `waited_ms: 3000000000`, so the
 * caller's schedule silently ran 35 days early. The fix routes ms through
 * clampMs, whose ceiling is the 32-bit timer limit.
 *
 * The overflow case is therefore probed, never awaited: a capped wait runs
 * 24.8 days and awaiting it in a test would hang the runner. The probe
 * asserts the call does NOT settle within 300 ms — the old code settled in
 * ~1 ms, which is exactly the red this test exists to pin.
 */
function unsettledWithin(ms: number, call: Promise<unknown>): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });
    setTimeout(() => resolve(!settled), ms);
  });
}

test("a normal wait returns the ms it actually waited", async () => {
  const startedAt = Date.now();
  const result = await holdWhile(waitTool({ ms: 120 })) as { waited_ms: number };
  assert.equal(result.waited_ms, 120);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 100, `elapsed ${elapsed} ms — the wait did not happen`);
});

test("an overflowing ms is capped to the timer limit, not fired at ~1 ms", async () => {
  const stillPending = await unsettledWithin(300, waitTool({ ms: 3_000_000_000 }));
  assert.ok(
    stillPending,
    "wait {ms: 3e9} settled within 300 ms — a 32-bit timer overflow fired it at ~1 ms (old bug is back)",
  );
  // The capped value is observable on the settled shape only, so clampMs is
  // asserted directly here as the ceiling waitTool now routes through.
  const { clampMs, MAX_TIMER_MS } = await import("../src/bridge/process-tools.js");
  assert.equal(clampMs(3_000_000_000, 0), MAX_TIMER_MS);
});

test("garbage ms falls back to 0 (a no-op wait), never a NaN timer", async () => {
  assert.equal((await holdWhile(waitTool({ ms: "abc" })) as { waited_ms: number }).waited_ms, 0);
  assert.equal((await holdWhile(waitTool({ ms: null })) as { waited_ms: number }).waited_ms, 0);
});

test("negative ms falls back to 0 rather than a negative timer", async () => {
  assert.equal((await holdWhile(waitTool({ ms: -5 })) as { waited_ms: number }).waited_ms, 0);
});

test("fractional ms is refused (an integer number of milliseconds or nothing)", async () => {
  await assert.rejects(() => holdWhile(waitTool({ ms: 1.5 })), /ms must be an integer/);
});
