/**
 * The local sound channel's guards.
 *
 * The player itself is not exercised here — spawning PowerShell in a unit test
 * would be slow, platform-bound and would actually make a noise on whoever's
 * machine runs CI. What IS testable, and what would actually bite, is the
 * validation: a path that cannot work must be refused when it is saved, not
 * discovered as silence at the moment something needed announcing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateConfigValue } from "../src/bridge/config-values.js";
import { normalizeSettingsMessage } from "../src/bridge/settings-model.js";

const ok = (key: string, value: unknown): unknown => {
  const result = validateConfigValue(key, value);
  assert.ok(result.ok, `${key} rejected ${JSON.stringify(value)}: ${result.ok ? "" : result.error}`);
  return result.value;
};
const err = (key: string, value: unknown): string => {
  const result = validateConfigValue(key, value);
  assert.ok(!result.ok, `${key} accepted ${JSON.stringify(value)}`);
  return result.ok ? "" : result.error;
};

const KEYS = ["sound.fileWaiting", "sound.fileFinished"] as const;

test("a sound path must be absolute", () => {
  for (const key of KEYS) {
    assert.equal(ok(key, "C:\\Windows\\Media\\Alarm01.wav"), "C:\\Windows\\Media\\Alarm01.wav");
    assert.equal(ok(key, "/usr/share/sounds/alert.mp3"), "/usr/share/sounds/alert.mp3");
    // Relative paths resolve against whatever the bridge's cwd happens to be,
    // which is not something the operator can reason about from a settings
    // page, so they are refused rather than resolved on their behalf.
    assert.match(err(key, "alert.wav"), /absolute path/);
    assert.match(err(key, "./sounds/alert.wav"), /absolute path/);
  }
});

test("a sound path must look like audio", () => {
  for (const key of KEYS) {
    // A text file would spawn a player that fails silently; refusing at save
    // time is the difference between a message and a mystery.
    assert.match(err(key, "C:\\notes\\todo.txt"), /audio file/);
    assert.match(err(key, "C:\\sounds\\clip"), /audio file/);
    for (const extension of [".wav", ".mp3", ".m4a", ".flac"]) {
      assert.equal(ok(key, `C:\\sounds\\alert${extension}`), `C:\\sounds\\alert${extension}`);
    }
  }
});

test("empty means silent, and stays allowed", () => {
  for (const key of KEYS) {
    // "" is how you turn one event's sound off without clearing the other or
    // disabling the channel, so it must not be swept up by the path rules.
    assert.equal(ok(key, ""), "");
    assert.equal(ok(key, "   "), "");
  }
});

test("the console can actually write every sound setting", () => {
  // Same trap that shipped with notify.call*: declared everywhere except
  // CONFIG_SPEC, so the control rendered and the save was refused.
  assert.ok(normalizeSettingsMessage({ command: "setConfig", key: "sound.enabled", value: true }));
  for (const key of KEYS) {
    assert.ok(
      normalizeSettingsMessage({ command: "setConfig", key, value: "C:\\sounds\\a.wav" }),
      `${key} is rejected by the console gate`,
    );
  }
});

test("the test-play action names a slot, never a path", () => {
  // A path from the page would let the console play any file the bridge can
  // read; the button exists to prove the SAVED setting works.
  const waiting = normalizeSettingsMessage({ command: "testSound", which: "waiting" });
  assert.deepEqual(waiting, { command: "testSound", which: "waiting" });
  const finished = normalizeSettingsMessage({ command: "testSound", which: "finished" });
  assert.deepEqual(finished, { command: "testSound", which: "finished" });
  // Anything else falls back to the blocking slot rather than being honoured.
  const junk = normalizeSettingsMessage({ command: "testSound", which: "C:\\music\\anything.mp3" });
  assert.deepEqual(junk, { command: "testSound", which: "waiting" });
});

/**
 * Explorer's "Copy as path" wraps the result in double quotes, and that is
 * the single most likely way this field gets filled in. Refusing the
 * clipboard's own format for "not being absolute" would be a baffling
 * rejection, so the quotes come off.
 */
test("a quoted path is accepted and unwrapped", () => {
  for (const key of KEYS) {
    assert.equal(
      ok(key, '"C:\\Users\\me\\Music\\track.flac"'),
      "C:\\Users\\me\\Music\\track.flac",
      "Explorer's copied form must work",
    );
    // Unquoted stays exactly as it was.
    assert.equal(ok(key, "C:\\Users\\me\\Music\\track.flac"), "C:\\Users\\me\\Music\\track.flac");
    // Spaces in the name are normal for music files and must survive both ways.
    assert.equal(ok(key, '"C:\\Music\\晚巧 - 踏浪.flac"'), "C:\\Music\\晚巧 - 踏浪.flac");
    assert.equal(ok(key, "C:\\Music\\晚巧 - 踏浪.flac"), "C:\\Music\\晚巧 - 踏浪.flac");
    // A lone quote is part of the filename, not a wrapper, and is left alone.
    assert.match(err(key, '"C:\\Music\\track.flac'), /absolute path/);
  }
});

test("the console can stop a sound that is already playing", () => {
  // The bug this exists for: a four-minute track auditioned with no way to
  // cut it short, and a second press stacking another copy on top. A start
  // button without a stop button is only half a control.
  assert.deepEqual(
    normalizeSettingsMessage({ command: "stopSound" }),
    { command: "stopSound" },
  );
});

/**
 * Pressing 发送测试 under 手机（Bark） opened a music player on the desktop.
 *
 * The test push travels as an `attention` event, and every attention event
 * makes a local noise — so a button whose entire purpose is "does the phone
 * channel work" was exercising the other channel too. Worse than noisy: the
 * operator cannot tell which channel the result belongs to.
 *
 * Asserted on the wiring rather than by spawning a player: the guard is that
 * the handler passes silentLocally, and that pushNotification honours it.
 */
test("the Bark test button asks for a silent-locally push", () => {
  const handler = readFileSync(
    path.join(process.cwd(), "src/server/settings-handler.ts"),
    "utf8",
  );
  const testNotify = handler.slice(handler.indexOf('case "testNotify"'));
  const body = testNotify.slice(0, testNotify.indexOf("\n    }"));
  assert.match(
    body,
    /silentLocally:\s*true/,
    "the phone test must not also play the desktop sound",
  );
});

test("pushNotification honours silentLocally before anything else", () => {
  const notify = readFileSync(path.join(process.cwd(), "src/bridge/notify.ts"), "utf8");
  // The sound is deliberately ahead of every Bark gate so a key-less machine
  // still chimes; the opt-out therefore has to wrap it there, not later.
  const guard = /if \(!options\.silentLocally\) \{[^}]*playAlertSound/s;
  assert.match(notify, guard, "the local sound must sit behind the silentLocally check");
});
