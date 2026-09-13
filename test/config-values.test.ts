import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfigValue } from "../src/bridge/config-values.js";

const ok = (key: string, value: unknown): unknown => {
  const checked = validateConfigValue(key, value);
  assert.equal(checked.ok, true, `${key}=${JSON.stringify(value)} should validate`);
  return checked.ok ? checked.value : undefined;
};

const err = (key: string, value: unknown): string => {
  const checked = validateConfigValue(key, value);
  assert.equal(checked.ok, false, `${key}=${JSON.stringify(value)} should be refused`);
  return checked.ok ? "" : checked.error;
};

test("unknown keys and missing values are refused by name", () => {
  assert.match(err("notASetting", 1), /Unsupported Open Bridge setting: notASetting/);
  assert.match(err("", 1), /Unsupported Open Bridge setting/);
  assert.match(err("port", undefined), /value is required/);
});

test("enums accept their members, trimmed; nothing else", () => {
  assert.equal(ok("tunnelProvider", "ngrok"), "ngrok");
  assert.equal(ok("toolProfile", " core "), "core");
  assert.match(err("toolProfile", "everything"), /must be 'full' or 'core'/);
  assert.match(err("tunnelProvider", 42), /must be 'none' or 'ngrok'/);
});

test("plain strings are trimmed, non-empty, and capped", () => {
  assert.equal(ok("shellPath", "  /bin/bash  "), "/bin/bash");
  assert.match(err("shellPath", 42), /must be a non-empty string/);
  assert.match(err("ngrokExecutable", "   "), /must be a non-empty string/);
  assert.equal((ok("shellPath", "x".repeat(500)) as string).length, 500);
  assert.match(err("shellPath", "x".repeat(501)), /at most 500 characters/);
});

test("shellArgs trims and drops empties, then enforces the cap by refusal", () => {
  assert.deepEqual(ok("shellArgs", [" -NoLogo ", "", "-ExecutionPolicy Bypass"]), ["-NoLogo", "-ExecutionPolicy Bypass"]);
  assert.deepEqual(ok("shellArgs", []), []);
  assert.match(err("shellArgs", "not-an-array"), /must be an array of strings/);
  assert.match(err("shellArgs", ["ok", 42]), /must be an array of strings/);
  assert.match(err("shellArgs", new Array(51).fill("x")), /at most 50 items/);
  assert.match(err("shellArgs", ["x".repeat(501)]), /at most 500 characters/);
});

test("booleans are strict: garbage is refused, never stored as false", () => {
  for (const key of ["unrestrictedFileAccess", "autoReconnect", "ngrokUseHttpProxy", "concurrency.enabled", "oauth.enabled"]) {
    assert.equal(ok(key, true), true);
    assert.equal(ok(key, false), false);
    assert.match(err(key, "yes"), new RegExp(`${key} must be a boolean`), `${key}: "yes" refused`);
    assert.match(err(key, 1), /must be a boolean/);
    assert.match(err(key, ""), /must be a boolean/);
    assert.match(err(key, null), /must be a boolean/);
  }
});

test("redirect hosts are trimmed, lowercased, and capped", () => {
  assert.deepEqual(ok("oauth.allowedRedirectHosts", ["Example.COM ", "a.dev"]), ["example.com", "a.dev"]);
  assert.deepEqual(ok("oauth.allowedRedirectHosts", []), []);
  assert.match(err("oauth.allowedRedirectHosts", ["ok", "  "]), /non-empty host strings/);
  assert.match(err("oauth.allowedRedirectHosts", "x.dev"), /non-empty host strings/);
  assert.match(err("oauth.allowedRedirectHosts", new Array(51).fill("x.dev")), /at most 50 hosts/);
  assert.match(err("oauth.allowedRedirectHosts", [`${"x".repeat(250)}.dev`]), /at most 253 characters/);
});

test("auth.enabled is a strict boolean; the token gate lives with the caller", () => {
  assert.equal(ok("auth.enabled", true), true);
  assert.equal(err("auth.enabled", "yes"), "auth.enabled must be a boolean.");
});

test("restart/timeout knobs are non-negative integers", () => {
  for (const key of ["auth.tokenTtlSeconds", "concurrency.holdTimeoutMs", "concurrency.waitTimeoutMs"]) {
    assert.equal(ok(key, 0), 0);
    assert.equal(ok(key, 300000), 300000);
    assert.match(err(key, -1), /non-negative integer/);
    assert.match(err(key, 1.5), /non-negative integer/);
    assert.match(err(key, "300"), /non-negative integer/);
  }
});

test("allowedDirectories must be absolute; relative and empty refused", () => {
  assert.deepEqual(ok("allowedDirectories", ["C:\\tools", "C:/x", "/tmp/x", "\\\\srv\\share", "\\rooted"]), [
    "C:\\tools",
    "C:/x",
    "/tmp/x",
    "\\\\srv\\share",
    "\\rooted",
  ]);
  assert.deepEqual(ok("allowedDirectories", ["  /tmp/x  "]), ["/tmp/x"]);
  assert.deepEqual(ok("allowedDirectories", []), []);
  assert.match(err("allowedDirectories", ["relative/path"]), /absolute path strings/);
  assert.match(err("allowedDirectories", ["C:drive-relative"]), /absolute path strings/);
  assert.match(err("allowedDirectories", [""]), /absolute path strings/);
  assert.match(err("allowedDirectories", ["/ok", 42]), /absolute path strings/);
  assert.match(err("allowedDirectories", new Array(51).fill("/x")), /at most 50 entries/);
});

test("port keeps 0 as the auto-port sentinel", () => {
  assert.equal(ok("port", 0), 0);
  assert.equal(ok("port", 65535), 65535);
  assert.match(err("port", 65536), /between 0 and 65535/);
  assert.match(err("port", -1), /between 0 and 65535/);
  assert.match(err("port", 8080.5), /between 0 and 65535/);
  assert.match(err("port", "8080"), /between 0 and 65535/);
  assert.match(err("port", true), /between 0 and 65535/);
});

test("publicHealthTimeoutMs and logMaxBytes ranges", () => {
  assert.equal(ok("publicHealthTimeoutMs", 3000), 3000);
  assert.equal(ok("publicHealthTimeoutMs", 120000), 120000);
  assert.match(err("publicHealthTimeoutMs", 2999), /between 3000 and 120000/);
  assert.match(err("publicHealthTimeoutMs", 120001), /between 3000 and 120000/);
  assert.equal(ok("logMaxBytes", 0), 0);
  assert.equal(ok("logMaxBytes", 1024 * 1024 * 1024), 1024 * 1024 * 1024);
  assert.match(err("logMaxBytes", -1), /between 0 and 1073741824/);
  assert.match(err("logMaxBytes", 1024 * 1024 * 1024 + 1), /between 0 and 1073741824/);
});
