/**
 * Notifications — the pure half. The wire path (host config + probeHttpHealth
 * + the set_todos/session hooks) is integration-tested; everything computable
 * is pinned here: URL shape, mode gate, idle verdict, completion diff, and the
 * connect-time instructions the AI is handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBarkUrl, clampIdleMinutes, finishNoticeVerdict, idleWatchVerdict, modeSuppresses,
  newlyCompletedTodos, notifyUsageInstructions, parseBarkExtras,
} from "../src/bridge/notify.js";

const KEY = "aaaaaaaaaaaaaaaaaaaaaa"; // obviously fake: a real Bark key must never appear in a repo
const FREQ = { usable: true, enabled: true, mode: "frequent", key: KEY, serverUrl: "https://api.day.app", blocker: "", idleMinutes: 10 } as const;
const DND = { ...FREQ, mode: "dnd" } as const;

// --- the Bark URL -------------------------------------------------------------

test("buildBarkUrl: key first, title/body percent-encoded, group pinned", () => {
  const url = buildBarkUrl("https://api.day.app", KEY, "标题/划", "正文 ?#1");
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://api.day.app");
  assert.equal(parsed.pathname, "/aaaaaaaaaaaaaaaaaaaaaa/%E6%A0%87%E9%A2%98%2F%E5%88%92/%E6%AD%A3%E6%96%87%20%3F%231");
  assert.equal(parsed.searchParams.get("group"), "open-bridge");
});

test("buildBarkUrl: stored trailing slash absorbed; empty segments omitted", () => {
  assert.equal(buildBarkUrl("https://api.day.app/", "k_e_y_1234", "t", ""),
    "https://api.day.app/k_e_y_1234/t?group=open-bridge");
  assert.equal(buildBarkUrl("https://api.day.app", "k_e_y_1234", "", ""),
    "https://api.day.app/k_e_y_1234?group=open-bridge");
});

// --- the mode gate -----------------------------------------------------------------

test("frequent admits every event; dnd admits only the attention floor", () => {
  assert.equal(modeSuppresses("frequent", "progress"), false);
  assert.equal(modeSuppresses("frequent", "attention"), false);
  assert.equal(modeSuppresses("frequent", "finished"), false);
  assert.equal(modeSuppresses("dnd", "progress"), true);
  assert.equal(modeSuppresses("dnd", "attention"), false);
  assert.equal(modeSuppresses("dnd", "finished"), false);
});

// --- idleMinutes clamping ------------------------------------------------------------

test("clampIdleMinutes: 0 is meaningful (off); garbage lands on the default", () => {
  assert.equal(clampIdleMinutes(0), 0);
  assert.equal(clampIdleMinutes(5), 5);
  assert.equal(clampIdleMinutes(1e9), 1440);
  assert.equal(clampIdleMinutes(10.7), 10);
  assert.equal(clampIdleMinutes("25"), 25);
  // The fallback is the configured default (60 in config-defaults), asserted
  // through the constant so a deliberate default change updates this for free.
  assert.equal(clampIdleMinutes(Number.NaN), 60);
  assert.equal(clampIdleMinutes(null), 60);
  assert.equal(clampIdleMinutes(undefined), 60);
  assert.equal(clampIdleMinutes(-1), 60);
});

// --- the set_todos completion diff ------------------------------------------------

test("diff names completed items that were not completed before", () => {
  const prev = [
    { id: "a", title: "A", status: "completed" },
    { id: "b", title: "B", status: "in_progress" },
  ];
  const next = [
    { id: "a", title: "A", status: "completed" },
    { id: "b", title: "B", status: "completed" },
    { id: "c", title: "C", status: "completed" },
  ];
  assert.deepEqual(newlyCompletedTodos(prev, next).map(t => t.id), ["b", "c"]);
  assert.deepEqual(newlyCompletedTodos(next, next), [], "an unchanged replay rings no bell");
});

test("diff reads untrusted lists without tripping (persisted data, hand-edited)", () => {
  // An empty baseline: a completed item was "never seen" — first pass counts.
  assert.deepEqual(newlyCompletedTodos([], [{ id: "x", title: "X", status: "completed" }]).map(t => t.id), ["x"]);
  // Junk entries are dropped, not crashed on; a completed item with neither
  // id nor title cannot be announced, and must not poison the result.
  assert.deepEqual(newlyCompletedTodos([], ["string", null, { status: "completed" }]), []);
  assert.deepEqual(newlyCompletedTodos(["nope"], [{ id: "x", title: "X", status: "completed" }]).map(t => t.id), ["x"]);
});

// --- the idle-watch verdict -------------------------------------------------------

test("the watchdog needs all of: channel, threshold, silence, an open list, no in-flight work", () => {
  // lastUsedMs 7 = "a session exists and went quiet"; the empty table cannot
  // carry open todos anyway, so real episodes always have a clock > 0.
  const ok = { usable: true, idleMinutes: 10, nowMs: 660_007, lastUsedMs: 7,
    activeRequests: 0, hasOpenTodos: true, notifiedForMs: 0 };
  assert.equal(idleWatchVerdict(ok), true);
  assert.equal(idleWatchVerdict({ ...ok, usable: false }), false);
  assert.equal(idleWatchVerdict({ ...ok, idleMinutes: 0 }), false, "0 is off, not always");
  assert.equal(idleWatchVerdict({ ...ok, activeRequests: 1 }), false, "our own slowness does not page anyone");
  assert.equal(idleWatchVerdict({ ...ok, hasOpenTodos: false }), false, "a quiet done list is not an emergency");
  assert.equal(idleWatchVerdict({ ...ok, nowMs: 300_007 }), false, "five minutes is not ten");
});

test("the watchdog latches one notice per episode and re-arms when activity moves the clock", () => {
  const base = { usable: true, idleMinutes: 10, nowMs: 660_007, lastUsedMs: 7,
    activeRequests: 0, hasOpenTodos: true };
  // First bell: the latch (0) does not match this episode's clock.
  assert.equal(idleWatchVerdict({ ...base, notifiedForMs: 0 }), true);
  // The tick stamped the latch with that same clock: silence continues, no repeat.
  assert.equal(idleWatchVerdict({ ...base, nowMs: 720_007, notifiedForMs: 7 }), false);
  // A call moved the clock — old stamp, new episode; threshold counts from there.
  assert.equal(idleWatchVerdict({ ...base, nowMs: 500_005, lastUsedMs: 5, notifiedForMs: 7 }), false, "not silent yet");
  assert.equal(idleWatchVerdict({ ...base, nowMs: 1_200_005, lastUsedMs: 5, notifiedForMs: 7 }), true);
});

// --- what the connect-time AI is taught --------------------------------------------

test("instructions appear only for a usable channel, and name the mode's rules", () => {
  assert.match(notifyUsageInstructions(FREQ), /frequent mode/);
  assert.equal(notifyUsageInstructions(DND).includes("suppressed"), true);
  assert.equal(notifyUsageInstructions({ ...FREQ, usable: false }), "",
    "no lecture about machinery the connect cannot reach");
});

// --- the optional Bark knobs (sound/level/call/badge/url) --------------------

test("buildBarkUrl appends the chosen knobs as query params, in a fixed order", () => {
  const url = new URL(buildBarkUrl("https://api.day.app", KEY, "t", "b", {
    sound: "minuet", level: "timeSensitive", call: 1, badge: 3, url: "https://example.com/report",
  }));
  assert.equal(url.searchParams.get("group"), "open-bridge");
  assert.equal(url.searchParams.get("sound"), "minuet");
  assert.equal(url.searchParams.get("level"), "timeSensitive");
  assert.equal(url.searchParams.get("call"), "1");
  assert.equal(url.searchParams.get("badge"), "3");
  assert.equal(url.searchParams.get("url"), "https://example.com/report");
});

test("buildBarkUrl: no extras means the plain push URL, unchanged shape", () => {
  assert.equal(
    buildBarkUrl("https://api.day.app", KEY, "t", "b"),
    "https://api.day.app/aaaaaaaaaaaaaaaaaaaaaa/t/b?group=open-bridge",
  );
  assert.equal(
    new URL(buildBarkUrl("https://api.day.app", KEY, "t", "b", {})).search,
    "?group=open-bridge",
    "an empty extras object adds nothing",
  );
});

test("parseBarkExtras: absent and empty mean not-provided, not an error", () => {
  assert.deepEqual(parseBarkExtras({}).extras, {});
  assert.deepEqual(parseBarkExtras({ sound: "  ", level: "", call: "", badge: null }).extras, {});
});

test("parseBarkExtras: legal values pass through typed", () => {
  const ok = parseBarkExtras({ sound: "bell", level: "passive", call: 1, badge: 0, url: "http://127.0.0.1:18080/x" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.extras, {
      sound: "bell", level: "passive", call: 1, badge: 0, url: "http://127.0.0.1:18080/x",
    });
  }
});

test("parseBarkExtras: every knob refuses junk by name (the model fixes the call)", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ sound: "bad name!" }, /sound/],
    [{ sound: "x".repeat(65) }, /sound/],
    [{ level: "critical" }, /level must be one of/],
    [{ call: 0 }, /call/],
    [{ call: 11 }, /call/],
    [{ call: "loud" }, /call/],
    [{ badge: -1 }, /badge/],
    [{ badge: 10000 }, /badge/],
    [{ badge: "many" }, /badge/],
    [{ url: "javascript:alert(1)" }, /url/],
    [{ url: "ftp://x" }, /url/],
    [{ url: `https://e.com/${"x".repeat(600)}` }, /url/],
  ];
  for (const [args, pattern] of cases) {
    const result = parseBarkExtras(args as never);
    assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(args)}`);
    if (!result.ok) assert.match(result.error, pattern);
  }
});

// --- the finish watchdog -----------------------------------------------------

/**
 * The complaint this exists for: "网页 AI 经常忘掉" — the model finishes the
 * work, writes its summary, and never calls notify. The idle watchdog cannot
 * cover it (that one requires an OPEN todo, this is the opposite case), so
 * these pin the conditions under which the server speaks for a silent AI.
 */

const DONE = {
  usable: true,
  idleMinutes: 10,
  nowMs: 1_000_000,
  lastUsedMs: 1_000_000 - 60_000, // a minute of quiet: past the settle delay
  activeRequests: 0,
  hasTodos: true,
  allCompleted: true,
  completedAtMs: 1_000_000 - 60_000,
  notifiedSinceMs: 0,
  announcedForMs: 0,
} as const;

test("finish watchdog: a fully completed list nobody announced does get announced", () => {
  assert.equal(finishNoticeVerdict(DONE), true);
});

test("finish watchdog: the AI's own push silences it", () => {
  // A well-behaved model that called notify() after finishing must not cause a
  // second, redundant bell — its push is newer than the completion.
  assert.equal(finishNoticeVerdict({ ...DONE, notifiedSinceMs: DONE.completedAtMs + 1 }), false);
  // But a push from BEFORE the work finished says nothing about this list.
  assert.equal(finishNoticeVerdict({ ...DONE, notifiedSinceMs: DONE.completedAtMs - 1 }), true);
});

test("finish watchdog: unfinished work is the idle watchdog's job, not this one", () => {
  assert.equal(finishNoticeVerdict({ ...DONE, allCompleted: false }), false);
  assert.equal(finishNoticeVerdict({ ...DONE, hasTodos: false }), false);
});

test("finish watchdog: it waits for the run to actually be over", () => {
  // Still working: a call in flight means the ticked list may not be the end.
  assert.equal(finishNoticeVerdict({ ...DONE, activeRequests: 1 }), false);
  // Just ticked the last box — the model's own notify may be the very next
  // call, so the settle delay must keep this quiet and let the AI win.
  assert.equal(finishNoticeVerdict({ ...DONE, lastUsedMs: DONE.nowMs - 1_000 }), false);
});

test("finish watchdog: one announcement per finished list", () => {
  // The latch is the completion clock, so the same completion never repeats...
  assert.equal(finishNoticeVerdict({ ...DONE, announcedForMs: DONE.completedAtMs }), false);
  // ...while a later completion (new work, finished again) re-arms it.
  assert.equal(finishNoticeVerdict({ ...DONE, announcedForMs: DONE.completedAtMs - 5_000 }), true);
});

test("finish watchdog: idleMinutes 0 switches off both watchdogs, not just one", () => {
  assert.equal(finishNoticeVerdict({ ...DONE, idleMinutes: 0 }), false);
  assert.equal(finishNoticeVerdict({ ...DONE, usable: false }), false);
});

test("finish watchdog: a tiny idleMinutes shortens the settle delay instead of outliving it", () => {
  // idleMinutes=1 caps the 45 s settle at 60 s; 30 s of quiet is not yet enough
  // at the default, but the cap must never make the delay LONGER than the knob.
  const tiny = { ...DONE, idleMinutes: 1, lastUsedMs: DONE.nowMs - 50_000 };
  assert.equal(finishNoticeVerdict(tiny), true, "50 s of quiet clears the 45 s settle");
  assert.equal(finishNoticeVerdict({ ...tiny, lastUsedMs: DONE.nowMs - 10_000 }), false);
});
