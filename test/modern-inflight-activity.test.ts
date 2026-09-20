/** In-flight modern requests are activity; the settle clock starts at completion. */
import assert from "node:assert/strict";
import test from "node:test";
import { finishNoticeVerdict, latestSessionActivity } from "../src/bridge/notify.js";
import { state } from "../src/bridge/state.js";

function reset(): void {
  state.sessions.clear();
  state.modernLastUsed = 0;
  state.modernInFlight = 0;
}

/** The verdict inputs the finish watchdog assembles, from the shared snapshot. */
function finishVerdict(nowMs: number, canSpeak = true): boolean {
  const activity = latestSessionActivity();
  return finishNoticeVerdict({
    canSpeak,
    nowMs,
    lastUsedMs: activity.lastUsedMs,
    activeRequests: activity.activeRequests,
    notifiedSinceMs: 0,
    announcedForMs: 0,
  });
}

test("a request in flight counts as activity, even when it started long ago", () => {
  reset();
  const now = 1_800_000_000_000;
  // Arrived 10 minutes ago and still running: the shape of a long build, a
  // slow verify, a test suite. Nothing has arrived since.
  state.modernLastUsed = now - 600_000;
  state.modernInFlight = 1;

  const activity = latestSessionActivity();
  assert.ok(activity.activeRequests >= 1,
    "an in-flight modern request must be visible as activity — otherwise the Bridge pages the operator about its own processing");
  assert.equal(finishVerdict(now), false, "no ending may be announced while a request is being served");
});

test("the activity clock is the END of the last request, not its beginning", () => {
  reset();
  const now = 1_800_000_000_000;
  // The request just finished: the handler stamped the clock on the way out.
  state.modernLastUsed = now;
  state.modernInFlight = 0;

  assert.equal(finishVerdict(now), false, "the settle window starts at completion, not at arrival");
  assert.equal(finishVerdict(now + 599_000), false, "just under ten minutes of quiet is inside the settle window");
  assert.equal(finishVerdict(now + 600_000), true, "a genuinely quiet ten minutes after it is an ending");
});

test("no request in flight and nothing recent is still the honest silence it always was", () => {
  reset();
  const now = 1_800_000_000_000;
  state.modernLastUsed = 0;
  state.modernInFlight = 0;
  assert.equal(latestSessionActivity().activeRequests, 0);
  assert.equal(finishVerdict(now), false, "a Bridge nobody ever called has no ending to announce");
});
