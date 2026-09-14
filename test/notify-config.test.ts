/**
 * Bark device-key grammar + server origin allowlist — the config surface the
 * operator touches. Pure; the wire path is integration-tested elsewhere.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalBarkOrigin, maskBarkKey, parseBarkKeyInput, validateConfigValue } from "../src/bridge/config-values.js";

const KEY = "aaaaaaaaaaaaaaaaaaaaaa"; // obviously fake: a real Bark key must never appear in a repo

test("bare key passes; surrounding whitespace is hygiene, not a rewrite", () => {
  assert.equal(parseBarkKeyInput(KEY), KEY);
  assert.equal(parseBarkKeyInput("  ".concat(KEY, "\n")), KEY);
});

test("a pasted Bark URL parses to its key (the canonical stored value)", () => {
  assert.equal(parseBarkKeyInput("https://api.day.app/".concat(KEY, "/")), KEY);
  assert.equal(parseBarkKeyInput("https://api.day.app/".concat(KEY, "/x/y?sound=z")), KEY);
  assert.equal(parseBarkKeyInput("api.day.app/".concat(KEY)), KEY);
});

test("empty means clear; malformed input is refused, never smuggled", () => {
  assert.equal(parseBarkKeyInput(""), "");
  assert.equal(parseBarkKeyInput("https://api.day.app/"), null);
  assert.equal(parseBarkKeyInput("https://api.day.app/a b c d"), null);
  assert.equal(parseBarkKeyInput("https://[oops"), null);
  assert.equal(parseBarkKeyInput("密钥"), null);
  assert.equal(parseBarkKeyInput("a;rm -rf /"), null);
  assert.equal(parseBarkKeyInput("abc"), null); // shorter than the floor
});

test("maskBarkKey shows a shape, never a recoverable prefix", () => {
  const masked = maskBarkKey(KEY);
  assert.ok(masked.startsWith("aaaa"));
  assert.ok(masked.endsWith("aa"));
  assert.ok(!masked.includes(KEY.slice(4, -2)));
  assert.equal(maskBarkKey("short123"), "••••••••");
  assert.equal(maskBarkKey(""), "");
});

test("canonicalBarkOrigin: https origin kept whole, host case folded", () => {
  assert.equal(canonicalBarkOrigin("https://API.Day.App:443/"), "https://api.day.app");
  assert.equal(canonicalBarkOrigin("https://bark.example.com:8443"), "https://bark.example.com:8443");
});

test("loopback http is the dev exception; other http is refused", () => {
  assert.equal(canonicalBarkOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(canonicalBarkOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.throws(() => canonicalBarkOrigin("http://192.168.1.5:8080"), /loopback/);
  assert.throws(() => canonicalBarkOrigin("http://api.day.app"), /loopback/);
});

test("an origin is an origin: no credentials, query, fragment or path", () => {
  assert.throws(() => canonicalBarkOrigin("https://user:pass@api.day.app"), /credentials/);
  assert.throws(() => canonicalBarkOrigin("https://api.day.app?x=1"), /without a query/);
  assert.throws(() => canonicalBarkOrigin("https://api.day.app#frag"), /fragment/);
  assert.throws(() => canonicalBarkOrigin("https://api.day.app/push"), /path/);
});

test("notify.mode is a closed vocabulary (shared validator)", () => {
  assert.equal(validateConfigValue("notify.mode", "dnd").value, "dnd");
  assert.equal(validateConfigValue("notify.mode", " frequent ").value, "frequent");
  assert.equal(validateConfigValue("notify.mode", "quiet").ok, false);
});

test("notify.idleMinutes: integer with a ceiling; 0 stays off, not default", () => {
  assert.equal(validateConfigValue("notify.idleMinutes", 0).value, 0);
  assert.equal(validateConfigValue("notify.idleMinutes", 1440).ok, true);
  assert.equal(validateConfigValue("notify.idleMinutes", 1441).ok, false);
  assert.equal(validateConfigValue("notify.idleMinutes", "10").ok, false);
});

test("notify.serverUrl: canonical on write; '' clears to the official default", () => {
  assert.equal(validateConfigValue("notify.serverUrl", "https://bark.mine.example/").value, "https://bark.mine.example");
  // Clearing is legal and mirrors the read side: "" stored, official origin used.
  assert.equal(validateConfigValue("notify.serverUrl", "").value, "");
  assert.equal(validateConfigValue("notify.serverUrl", "   ").value, "");
  assert.equal(validateConfigValue("notify.serverUrl", 42).ok, false, "non-string is a type error, not a clear");
  assert.equal(validateConfigValue("notify.serverUrl", "not a url").ok, false);
});
