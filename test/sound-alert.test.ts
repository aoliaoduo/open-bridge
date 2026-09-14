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
