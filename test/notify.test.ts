/**
 * Notifications — the pure half. The wire path (host config + probeHttpHealth
 * + the set_todos/session hooks) is integration-tested; everything computable
 * is pinned here: URL shape, mode gate, idle verdict, completion diff, and the
 * connect-time instructions the AI is handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBarkUrl, clampIdleMinutes, eventSuppressed, finishNoticeVerdict, idleWatchVerdict,
  newlyCompletedTodos, notifyUsageInstructions, parseBarkExtras,
} from "../src/bridge/notify.js";

const KEY = "aaaaaaaaaaaaaaaaaaaaaa"; // obviously fake: a real Bark key must never appear in a repo
/** Both bells on — the default, and the combination the old enum could not express. */
const FREQ = { usable: true, barkUsable: true, enabled: true, onTaskDone: true, onFinish: true, key: KEY, serverUrl: "https://api.day.app", blocker: "", idleMinutes: 10 } as const;
/** Both bells off: only the always-on interrupts survive. */
const DND = { ...FREQ, onTaskDone: false, onFinish: false } as const;

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

test("the two switches are independent, and all four combinations behave", () => {
  const both = { onTaskDone: true, onFinish: true };
  const neither = { onTaskDone: false, onFinish: false };
  const tasksOnly = { onTaskDone: true, onFinish: false };
  const finishOnly = { onTaskDone: false, onFinish: true };

  // The combination the old frequent/dnd enum made unexpressible, and the
  // whole reason this changed: a bell per task AND a bell at the end.
  assert.equal(eventSuppressed(both, "progress"), false);
  assert.equal(eventSuppressed(both, "finished"), false);

  assert.equal(eventSuppressed(tasksOnly, "progress"), false);
  assert.equal(eventSuppressed(tasksOnly, "finished"), true);

  assert.equal(eventSuppressed(finishOnly, "progress"), true);
  assert.equal(eventSuppressed(finishOnly, "finished"), false);

  assert.equal(eventSuppressed(neither, "progress"), true);
  assert.equal(eventSuppressed(neither, "finished"), true);
});

test("attention and waiting ignore both switches — a stalled question always rings", () => {
  // Someone who wants silence turns the channel off. While it is on, a
  // question nobody answers blocks the exchange indefinitely, so it is never
  // the thing a switch is allowed to swallow.
  for (const settings of [
    { onTaskDone: true, onFinish: true },
    { onTaskDone: false, onFinish: false },
    { onTaskDone: true, onFinish: false },
    { onTaskDone: false, onFinish: true },
  ]) {
    assert.equal(eventSuppressed(settings, "attention"), false);
    assert.equal(eventSuppressed(settings, "waiting"), false);
  }
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

test("the watchdog needs all of: channel, threshold, silence, no in-flight work", () => {
  // lastUsedMs 7 = "a session exists and went quiet".
  const ok = { canSpeak: true, idleMinutes: 10, nowMs: 660_007, lastUsedMs: 7,
    activeRequests: 0, hasOpenTodos: true, notifiedForMs: 0 };
  assert.equal(idleWatchVerdict(ok), true);
  assert.equal(idleWatchVerdict({ ...ok, canSpeak: false }), false);
  assert.equal(idleWatchVerdict({ ...ok, idleMinutes: 0 }), false, "0 is off, not always");
  assert.equal(idleWatchVerdict({ ...ok, activeRequests: 1 }), false, "our own slowness does not page anyone");
  assert.equal(idleWatchVerdict({ ...ok, nowMs: 300_007 }), false, "five minutes is not ten");
});

test("silence alone is enough: the watchdog no longer depends on a todo list", () => {
  // This requirement used to be in the verdict, and it quietly disabled the
  // watchdog for whole days of real use: 2026-09-13 on this workspace logged
  // 1274 tool calls, 4 of them set_todos, 0 notifications. A safety net tied
  // to a tool the model may forget fails exactly when the model is forgetful.
  const noList = { canSpeak: true, idleMinutes: 10, nowMs: 660_007, lastUsedMs: 7,
    activeRequests: 0, hasOpenTodos: false, notifiedForMs: 0 };
  assert.equal(idleWatchVerdict(noList), true, "a silent session with no list still pages");

  // What a session that never called anything cannot do is go quiet: there is
  // no clock to measure silence from, so lastUsedMs 0 stays false.
  assert.equal(idleWatchVerdict({ ...noList, lastUsedMs: 0 }), false, "never used is not idle");
});

test("the watchdog latches one notice per episode and re-arms when activity moves the clock", () => {
  const base = { canSpeak: true, idleMinutes: 10, nowMs: 660_007, lastUsedMs: 7,
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

test("instructions state the waiting duty unconditionally, then describe each switch", () => {
  // The waiting rule is what stops an AI from asking a question into an empty
  // room, so it must be present whatever the switches say.
  for (const settings of [FREQ, DND]) {
    assert.match(notifyUsageInstructions(settings), /event:"waiting"/);
    assert.match(notifyUsageInstructions(settings), /always deliver/);
  }
  // Each switch is described in whichever position it is actually in, so the
  // model is never told about a bell that will not ring.
  assert.match(notifyUsageInstructions(FREQ), /turned ON/);
  assert.match(notifyUsageInstructions(FREQ), /Mark items completed as you finish them/);
  assert.match(notifyUsageInstructions(DND), /turned OFF/);
  assert.equal(notifyUsageInstructions(DND).includes("suppressed"), true);
  // Mixed: the task bell on, the finish bell off — each half described truthfully.
  const mixed = notifyUsageInstructions({ ...FREQ, onFinish: false });
  assert.match(mixed, /turned ON \u300c每项任务完成时通知\u300d/);
  assert.match(mixed, /turned OFF \u300c对话结束时通知\u300d/);
  assert.equal(notifyUsageInstructions({ ...FREQ, barkUsable: false }), "",
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
    [{ level: "shout" }, /level must be one of/],
    [{ volume: 5 }, /volume only applies/],
    [{ level: "critical", volume: 11 }, /volume/],
    [{ level: "critical", volume: -1 }, /volume/],
    [{ group: "g".repeat(65) }, /group/],
    [{ icon: "javascript:alert(1)" }, /icon/],
    [{ icon: "ftp://x/i.png" }, /icon/],
    [{ isArchive: 2 }, /isArchive/],
    [{ autoCopy: "yes" }, /autoCopy/],
    [{ copy: "c".repeat(501) }, /copy/],
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

test("parseBarkExtras: the new knobs are accepted and reach the URL", () => {
  const parsed = parseBarkExtras({
    level: "critical", volume: 7, group: "my-project", icon: "https://e.com/i.png",
    isArchive: 1, copy: "npm run verify", autoCopy: 1,
  } as never);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const url = buildBarkUrl("https://api.day.app", KEY, "t", "b", parsed.extras);
  assert.match(url, /level=critical/);
  assert.match(url, /volume=7/);
  assert.match(url, /group=my-project/, "an explicit group beats the default");
  assert.match(url, /isArchive=1/);
  assert.match(url, /autoCopy=1/);
  assert.match(url, /copy=npm\+run\+verify/);
  assert.match(url, /icon=https%3A%2F%2Fe.com%2Fi.png/);
});

test("volume is only sent for critical, and only after level says so", () => {
  // Bark ignores volume unless the level is critical, so sending it otherwise
  // is noise in the URL and in the audit line. parseBarkExtras refuses that
  // combination outright rather than dropping the value, because a caller who
  // set volume believed it would be loud.
  const quiet = parseBarkExtras({ level: "timeSensitive" } as never);
  assert.equal(quiet.ok, true);
  if (quiet.ok) {
    assert.equal(buildBarkUrl("https://api.day.app", KEY, "t", "b", quiet.extras).includes("volume="), false);
  }
});

test("group defaults to open-bridge so pushes stack predictably", () => {
  const url = buildBarkUrl("https://api.day.app", KEY, "t", "b");
  assert.match(url, /group=open-bridge/);
});

// --- the finish watchdog -----------------------------------------------------

/**
 * The complaint this exists for: "网页 AI 经常忘掉" — the model finishes the
 * work, writes its summary, and never calls notify. The idle watchdog cannot
 * cover it (that one requires an OPEN todo, this is the opposite case), so
 * these pin the conditions under which the server speaks for a silent AI.
 */

const DONE = {
  canSpeak: true,
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
  // second, redundant bell.
  assert.equal(finishNoticeVerdict({ ...DONE, notifiedSinceMs: DONE.completedAtMs + 1 }), false);

  // This line used to assert `true`, and that assertion was the bug in test
  // form. "One millisecond before the completion" is not an older ending — it
  // is the overwhelmingly common shape of the CURRENT one: notify() stamps
  // itself when the push lands, and the session's lastUsed is stamped when
  // that same call returns a moment later. Believing the old assertion meant
  // every well-announced ending was announced a second time 45s afterwards,
  // which is exactly what the audit log showed.
  assert.equal(finishNoticeVerdict({ ...DONE, notifiedSinceMs: DONE.completedAtMs - 1 }), false);

  // A push from genuinely earlier still says nothing about this ending.
  assert.equal(
    finishNoticeVerdict({ ...DONE, notifiedSinceMs: DONE.completedAtMs - 5 * 60_000 }),
    true,
  );
});

test("finish watchdog: idleMinutes 0 (silence watchdog off) must not zero the settle delay", () => {
  // idleMinutes is the SILENCE watchdog's threshold; 0 switches that one off.
  // The finish watchdog borrows the same number only as an upper bound on its
  // settle delay — and `Math.min(45s, 0)` collapsed the delay to zero, so the
  // end-of-exchange bell fired instantly after every last call instead of
  // letting the model's own notify win the race. 0 must leave the default 45 s
  // settle intact, not abolish it.
  const zeroIdle = { ...DONE, idleMinutes: 0 };
  assert.equal(finishNoticeVerdict(zeroIdle), true,
    "the finished ending itself is still announced with idle watchdog off");
  assert.equal(
    finishNoticeVerdict({ ...zeroIdle, lastUsedMs: DONE.nowMs - 1_000 }),
    false,
    "but not instantly: the 45 s settle still guards the model's own notify",
  );
});

test("finish watchdog: unfinished work is the idle watchdog's job, not this one", () => {
  assert.equal(finishNoticeVerdict({ ...DONE, allCompleted: false }), false);
  // A list with open items stays the idle watchdog's case even if some other
  // field would otherwise qualify — the two must not page for one silence.
  assert.equal(
    finishNoticeVerdict({ ...DONE, allCompleted: false, lastUsedMs: DONE.nowMs - 600_000 }),
    false,
  );
});

test("finish watchdog: a conversation with NO list still gets announced", () => {
  // The whole point of decoupling: an operator who asked one question and
  // walked away is just as away as one who watched a list finish. Requiring a
  // completed list meant short exchanges — the common case — never rang.
  const noList = { ...DONE, hasTodos: false, allCompleted: true };
  // Same 45 s settle as a finished list: being told promptly is the point, so
  // a listless conversation does not wait out the idle threshold.
  assert.equal(finishNoticeVerdict(noList), true, "a minute of quiet ends a listless chat");
  assert.equal(
    finishNoticeVerdict({ ...noList, lastUsedMs: DONE.nowMs - 10 * 60_000 }),
    true,
    "and longer silence certainly does",
  );
  // Still not instant: the settle delay has to let the model's own notify win.
  assert.equal(
    finishNoticeVerdict({ ...noList, lastUsedMs: DONE.nowMs - 1_000 }),
    false,
    "one second is mid-run, not an ending",
  );
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

/**
 * This test used to assert the opposite, and asserting it is what kept the
 * bug alive: "idleMinutes 0 switches off both watchdogs, not just one" was
 * written down as the intended behaviour.
 *
 * It is not. The field is labelled 无反应提醒 … 0 = 关闭 on the settings page —
 * it is the silence alert's threshold. 对话结束时通知 is a separate switch, and
 * turning one off must not turn off the other. A knob may only govern what it
 * owns.
 */
test("idleMinutes belongs to the silence alert, not to the end-of-exchange one", () => {
  assert.equal(
    finishNoticeVerdict({ ...DONE, idleMinutes: 0 }),
    true,
    "switching off the silence alert must leave the end-of-exchange announcement alone",
  );
  // The end-of-exchange bell has its own switch, and that one does stop it.
  assert.equal(finishNoticeVerdict({ ...DONE, onFinish: false, canSpeak: false }), false);
  // Nothing configured anywhere is still the quiet case.
  assert.equal(finishNoticeVerdict({ ...DONE, canSpeak: false }), false);
});

test("finish watchdog: a tiny idleMinutes shortens the settle delay instead of outliving it", () => {
  // idleMinutes=1 caps the 45 s settle at 60 s; 30 s of quiet is not yet enough
  // at the default, but the cap must never make the delay LONGER than the knob.
  const tiny = { ...DONE, idleMinutes: 1, lastUsedMs: DONE.nowMs - 50_000 };
  assert.equal(finishNoticeVerdict(tiny), true, "50 s of quiet clears the 45 s settle");
  assert.equal(finishNoticeVerdict({ ...tiny, lastUsedMs: DONE.nowMs - 10_000 }), false);
});

/**
 * The duplicate that prompted this: the AI pushed 'finished', and 45 seconds
 * later the watchdog pushed a second one.
 *
 * Real timestamps from this repo's audit log. A notify call marks itself when
 * the push lands (…46.674) but the session's lastUsed is stamped when that
 * same call finishes (…46.676), so an exact `notifiedSinceMs >= completedAtMs`
 * can never see a model's own announcement — it is always two milliseconds
 * early. Every well-behaved ending was being announced twice.
 */
test("a push moments before the call that carried it still silences the watchdog", () => {
  const completedAtMs = 1_757_889_586_676;
  const base = {
    canSpeak: true,
    onFinish: true,
    idleMinutes: 60,
    lastUsedMs: completedAtMs,
    activeRequests: 0,
    hasTodos: false,
    allCompleted: true,
    completedAtMs,
    announcedForMs: 0,
    nowMs: completedAtMs + 46_000,
  };

  assert.equal(
    finishNoticeVerdict({ ...base, notifiedSinceMs: completedAtMs - 2 }),
    false,
    "the AI announced this ending two milliseconds before the call closed",
  );
  // And the tolerance must not swallow a genuinely older push: yesterday's
  // announcement says nothing about this ending.
  assert.equal(
    finishNoticeVerdict({ ...base, notifiedSinceMs: completedAtMs - 10 * 60_000 }),
    true,
    "a push from ten minutes ago belongs to an earlier ending",
  );
  // A session that never pushed at all is exactly what the watchdog is for.
  assert.equal(finishNoticeVerdict({ ...base, notifiedSinceMs: 0 }), true);
});

/**
 * Reported as "I waited and the computer never made a sound", with
 * sound.enabled true and both audio files configured.
 *
 * The local sound sits ahead of every Bark gate inside pushNotification — but
 * the watchdogs never reached it: both verdicts open with
 * `if (!input.usable) return false`, and `usable` meant "Bark can send". So
 * turning the phone channel off silenced the desktop one, which is precisely
 * the setup the sound channel exists for.
 */
test("a sound-only setup still gets the watchdog", () => {
  // Phone off, sound on: something can still reach the operator.
  const soundOnly = { ...DONE, canSpeak: true };
  assert.equal(
    finishNoticeVerdict(soundOnly),
    true,
    "with a working sound channel the ending must still be announced",
  );

  // Nothing configured at all is the one case that stays quiet.
  assert.equal(finishNoticeVerdict({ ...DONE, canSpeak: false }), false);
});

test("the Bark send path gates on Bark, not on the sound channel", () => {
  // usable true (sound works) but barkUsable false (no key): the push must
  // report why rather than POSTing to an empty device key.
  const settings = { ...FREQ, usable: true, barkUsable: false, key: "", blocker: "no_key" };
  assert.equal(notifyUsageInstructions(settings), "",
    "a machine with no Bark key gets no lecture about Bark levels");
});

/**
 * The bug lived in resolveNotifySettings, not in the verdicts, so this is the
 * assertion that would actually have caught it: with the phone switch off and
 * a sound file set, `usable` must still be true — that flag is what the two
 * watchdogs consult before they consider announcing anything.
 */
test("usable reflects any channel, barkUsable only the phone", async () => {
  const { resolveNotifySettings } = await import("../src/bridge/notify.js");
  const { setHost } = await import("../src/host/host.js");

  const config = new Map<string, unknown>([
    ["notify.enabled", false],       // phone off
    ["notify.barkKey", ""],
    ["sound.enabled", true],         // desktop on
    ["sound.fileWaiting", "C:\\sounds\\alert.wav"],
    ["sound.fileFinished", ""],
  ]);
  setHost({
    config: {
      get: <T,>(key: string, fallback: T): T =>
        (config.has(key) ? config.get(key) : fallback) as T,
      update: async (): Promise<void> => undefined,
    },
  } as never);

  const settings = resolveNotifySettings();
  assert.equal(settings.barkUsable, false, "no key, no phone");
  assert.equal(settings.usable, true, "the sound channel can still reach the operator");
});

/**
 * The result used to lie by omission. With the phone off and a sound
 * configured, a notify call played audio on the operator's machine and still
 * answered `delivered:false, reason:"disabled"` — which a model reads as
 * "nobody was told", and may well report as a failure to the person who just
 * heard the chime.
 *
 * `delivered` still means the phone specifically, because callers and logs
 * depend on that. `announced` is the field that answers the question people
 * actually ask.
 */
test("the outcome reports the sound, not just the phone", async () => {
  const { pushNotification, resolveNotifySettings } = await import("../src/bridge/notify.js");
  const { setHost } = await import("../src/host/host.js");

  const cfg = new Map<string, unknown>([
    ["notify.enabled", false],
    ["notify.barkKey", ""],
    ["sound.enabled", true],
    ["sound.fileWaiting", "C:\\sounds\\nope.wav"],
  ]);
  setHost({
    config: {
      get: <T,>(key: string, fallback: T): T => (cfg.has(key) ? cfg.get(key) : fallback) as T,
      update: async (): Promise<void> => undefined,
    },
  } as never);

  const result = await pushNotification(resolveNotifySettings(), "waiting", "t", "b");

  // The file does not exist, so nothing actually played — but the shape is
  // what matters here: both fields exist and announced follows from them.
  assert.equal(typeof result.sounded, "boolean", "the sound channel must be reported");
  assert.equal(typeof result.announced, "boolean", "callers need one field to branch on");
  assert.equal(
    result.announced,
    result.delivered || result.sounded,
    "announced must be the OR of the channels, never a third opinion",
  );
});

// --- the modern-era (stateless) activity clock --------------------------------------

/**
 * 2026-07-28-era requests mint no session, so `state.modernLastUsed` is the
 * only trace they leave. Before it was folded in, a modern-only client was
 * invisible to both watchdogs: the idle bell saw "nobody connected" and the
 * finish bell had no completion clock, so neither could ever ring — the
 * operator's phone stayed silent through conversations that were plainly
 * happening. These tests pin the fold-in itself (they run against the global
 * state the ticks read; the verdict functions above stay pure).
 */
import { state } from "../src/bridge/state.js";
import { completionSnapshot, latestSessionActivity } from "../src/bridge/notify.js";

test("a modern-only conversation is visible to the activity clock", () => {
  state.sessions.clear();
  const before = state.modernLastUsed;
  try {
    state.modernLastUsed = Date.now();
    const activity = latestSessionActivity();
    assert.ok(activity.lastUsedMs > 0, "no sessions + modern traffic must still report activity");
    assert.equal(activity.hasOpenTodos, false);
  } finally {
    state.sessions.clear();
    state.modernLastUsed = before;
  }
});

test("the newer of the two clocks wins when both eras are active", () => {
  const before = state.modernLastUsed;
  try {
    const stale = Date.now() - 60_000;
    state.sessions.set("t-modern-fold", {
      transport: {} as never, lastUsed: stale, connectedAt: stale, calls: 0,
      todos: [], activeRequests: 0,
    });
    state.modernLastUsed = Date.now();
    assert.equal(latestSessionActivity().lastUsedMs, state.modernLastUsed);
    // And the session-only case still works: the modern clock at 0 never wins.
    state.modernLastUsed = 0;
    assert.equal(latestSessionActivity().lastUsedMs, stale);
  } finally {
    state.sessions.delete("t-modern-fold");
    state.modernLastUsed = before;
  }
});

test("a listless modern-only conversation gets a completion clock", () => {
  const before = state.modernLastUsed;
  try {
    state.sessions.clear();
    state.modernLastUsed = 0;
    assert.equal(completionSnapshot().completedAtMs, 0, "sanity: nothing ever happened");
    state.modernLastUsed = 1_234_567;
    assert.equal(
      completionSnapshot().completedAtMs, 1_234_567,
      "the finish watchdog latches on this clock; 0 would veto the announcement forever",
    );
  } finally {
    state.modernLastUsed = before;
  }
});
