import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBarkOrigin, maskBarkKey, parseBarkKeyInput, validateConfigValue } from "../src/bridge/config/config-values.js";

const KEY = "aaaaaaaaaaaaaaaaaaaaaa";

test("a Bark key can be pasted bare or as a Bark URL and is masked on read", () => {
  assert.equal(parseBarkKeyInput(`  ${KEY}\n`), KEY);
  assert.equal(parseBarkKeyInput(`https://api.day.app/${KEY}/anything?sound=x`), KEY);
  assert.equal(parseBarkKeyInput(""), "");
  assert.equal(parseBarkKeyInput("https://api.day.app/a b c"), null);
  const masked = maskBarkKey(KEY);
  assert.ok(masked.startsWith("aaaa") && masked.endsWith("aa"));
  assert.ok(!masked.includes(KEY.slice(4, -2)));
});

test("a Bark origin remains an http(s) origin with loopback-only plain http", () => {
  assert.equal(canonicalBarkOrigin("https://API.Day.App:443/"), "https://api.day.app");
  assert.equal(canonicalBarkOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => canonicalBarkOrigin("http://bark.example.com"), /loopback/);
  assert.throws(() => canonicalBarkOrigin("https://user:pass@api.day.app"), /credentials/);
  assert.equal(validateConfigValue("notify.serverUrl", "https://bark.mine.example/").value, "https://bark.mine.example");
});

test("the settings surface only retains the channel switch and server URL", () => {
  assert.equal(validateConfigValue("notify.enabled", true).value, true);
  assert.equal(validateConfigValue("notify.enabled", "yes").ok, false);
  for (const removed of [
    "notify.mode", "notify.onTaskDone", "notify.onFinish", "notify.idleMinutes",
    "notify.levelWaiting", "notify.levelFinished", "notify.callWaiting", "notify.callFinished",
  ]) {
    assert.equal(validateConfigValue(removed, true).ok, false, `${removed} must not be writable`);
  }
});
