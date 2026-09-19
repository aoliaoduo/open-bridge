/**
 * What the watchdogs read while a LONG call is running.
 *
 * The 2026-07-28-era (modern, stateless) path stamps one clock and counts
 * nothing: `modernLastUsed` is written when a request ARRIVES, and
 * `activeRequests` only ever counted legacy sessions. A tool call that takes
 * longer than the finish settle window therefore looked exactly like
 * silence — a run whose own duration outlasted the threshold. The exported
 * observation is the one both watchdogs share, so this is where the rule is
 * pinned: an in-flight request is activity, and the clock they read is the END
 * of the last request, not its beginning.
 *
 * Why it matters in one line from this workspace's own log: "sent finished"
 * (the phone bell) fired at 11:43:51, 11:51:51 and 11:59:51 — each one within
 * seconds of a 60-70 s `npm run verify` completing, i.e. mid-turn, while the AI
 * was still working.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { finishNoticeVerdict, latestSessionActivity } from "../src/bridge/notify.js";
import { state } from "../src/bridge/state.js";

/** The state object as the fix defines it; assigned through a cast so this file
 *  also RUNS (and fails an assertion) against the unfixed code. */
const modern = state as { modernLastUsed: number; modernInFlight?: number };

function reset(): void {
  state.sessions.clear();
  modern.modernLastUsed = 0;
  if ("modernInFlight" in modern) modern.modernInFlight = 0;
}

/** The verdict inputs the finish watchdog assembles, from the shared snapshot. */
function finishVerdict(nowMs: number, canSpeak = true): boolean {
  const activity = latestSessionActivity();
  return finishNoticeVerdict({
    canSpeak,
    idleMinutes: 60,
    nowMs,
    lastUsedMs: activity.lastUsedMs,
    activeRequests: activity.activeRequests,
    hasTodos: false,
    allCompleted: true,
    completedAtMs: activity.lastUsedMs,
    notifiedSinceMs: 0,
    announcedForMs: 0,
  });
}

test("a request in flight counts as activity, even when it started long ago", () => {
  reset();
  const now = 1_800_000_000_000;
  // Arrived 10 minutes ago and still running: the shape of a long build, a
  // slow verify, a test suite. Nothing has arrived since.
  modern.modernLastUsed = now - 600_000;
  modern.modernInFlight = 1;

  const activity = latestSessionActivity();
  assert.ok(activity.activeRequests >= 1,
    "an in-flight modern request must be visible as activity — otherwise the Bridge pages the operator about its own processing");
  assert.equal(finishVerdict(now), false, "no ending may be announced while a request is being served");
});

test("the activity clock is the END of the last request, not its beginning", () => {
  reset();
  const now = 1_800_000_000_000;
  // The request just finished: the handler stamped the clock on the way out.
  modern.modernLastUsed = now;
  modern.modernInFlight = 0;

  assert.equal(finishVerdict(now), false, "the settle window starts at completion, not at arrival");
  assert.equal(finishVerdict(now + 599_000), false, "just under ten minutes of quiet is inside the settle window");
  assert.equal(finishVerdict(now + 600_000), true, "a genuinely quiet ten minutes after it is an ending");
});

test("no request in flight and nothing recent is still the honest silence it always was", () => {
  reset();
  const now = 1_800_000_000_000;
  modern.modernLastUsed = 0;
  modern.modernInFlight = 0;
  assert.equal(latestSessionActivity().activeRequests, 0);
  assert.equal(finishVerdict(now), false, "a Bridge nobody ever called has no ending to announce");
});
