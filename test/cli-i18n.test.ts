import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCliLang } from "../src/bridge/cli-i18n.js";

/**
 * The CLI is the first thing a new user runs, so its language choice is pinned
 * here rather than checked by hand on one machine's locale.
 */

test("OPEN_BRIDGE_LANG beats the locale in both directions", () => {
  assert.equal(detectCliLang({ OPEN_BRIDGE_LANG: "zh", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(detectCliLang({ OPEN_BRIDGE_LANG: "en", LANG: "zh_CN.UTF-8" }), "en");
  // A tag we do not recognise is still an explicit request for "not Chinese".
  assert.equal(detectCliLang({ OPEN_BRIDGE_LANG: "de", LANG: "zh_CN.UTF-8" }), "en");
});

test("the POSIX variables are read in their documented precedence", () => {
  assert.equal(detectCliLang({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(detectCliLang({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(detectCliLang({ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(detectCliLang({ LANG: "zh_TW.UTF-8" }), "zh");
});

test("C and POSIX mean no locale, which is English rather than Chinese", () => {
  assert.equal(detectCliLang({ LANG: "C" }), "en");
  assert.equal(detectCliLang({ LC_ALL: "POSIX" }), "en");
});

test("an unrecognised locale gets English, but a bare environment stays 中文", () => {
  // Showing Chinese to someone whose locale we cannot read is the worse error.
  assert.equal(detectCliLang({ LANG: "ja_JP.UTF-8" }), "en");
  assert.equal(detectCliLang({ LANG: "de_DE.UTF-8" }), "en");
  // No locale at all is the normal Windows case, where the console has always
  // been Chinese; an upgrade must not silently switch it.
  assert.equal(detectCliLang({}), "zh");
  assert.equal(detectCliLang({ LANG: "", LC_ALL: "" }), "zh");
});
