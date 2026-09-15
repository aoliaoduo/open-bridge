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
  assert.equal(ok("tunnelProvider", "tailscale"), "tailscale");
  assert.equal(ok("toolProfile", " core "), "core");
  assert.match(err("toolProfile", "everything"), /must be one of/);
  assert.match(err("tunnelProvider", 42), /must be one of/);
});

test("tailscaleDomain trims and lowercases; a blank value clears; garbage is refused", () => {
  assert.equal(ok("tailscaleDomain", "  My-Machine.Tail1234.TS.net  "), "my-machine.tail1234.ts.net");
  assert.equal(ok("tailscaleDomain", ""), "");
  assert.match(err("tailscaleDomain", "host with spaces"), /must be a hostname/);
  assert.match(err("tailscaleDomain", "http://x"), /must be a hostname/);
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

/**
 * setTimeout keeps its delay in a 32-bit signed int. Past 2147483647 Node
 * prints TimeoutOverflowWarning and uses 1ms instead, so a caller asking for
 * an effectively infinite hold (1e18) gets a lock released on the next tick --
 * the precise opposite of the request, surfacing much later as a resource
 * handed to a second caller while the first still holds it.
 *
 * Found by feeding every numeric config key the values a model emits when it
 * guesses: strings, negatives, floats, NaN, Infinity, 1e18. Five of the seven
 * keys already refused all of them; these three took 1e18 and stored it.
 */
test("timeout settings refuse values that overflow the 32-bit timer", () => {
  for (const key of ["concurrency.holdTimeoutMs", "concurrency.waitTimeoutMs", "auth.tokenTtlSeconds"]) {
    assert.equal(ok(key, 2_147_483_647), 2_147_483_647, `${key} accepts the largest usable value`);
    assert.match(err(key, 2_147_483_648), /at most 2147483647/, `${key} refuses one past it`);
    assert.match(err(key, 1e18), /at most 2147483647/, `${key} refuses 1e18`);
    // 0 stays meaningful: it is how these are disabled, and must not be
    // collateral damage of an upper bound.
    assert.equal(ok(key, 0), 0, `${key} still accepts 0 to disable`);
  }
});

/**
 * The per-event Bark styling is the operator's call, so it has to survive a
 * round trip through the config validator — a select that stores a value the
 * server refuses would look like it worked until the next push arrived wrong.
 */
test("per-event notify levels accept Bark's four styles and refuse anything else", () => {
  for (const key of [
    "notify.levelAttention", "notify.levelWaiting", "notify.levelFinished", "notify.levelProgress",
  ]) {
    for (const level of ["active", "timeSensitive", "passive", "critical"]) {
      assert.equal(ok(key, level), level, `${key} accepts ${level}`);
    }
    assert.match(err(key, "loud"), /must be one of/, `${key} refuses an invented level`);
    assert.match(err(key, ""), /must be one of/, `${key} has no empty state — every event has a style`);
  }
});
/**
 * Every console control writes through setConfig, which refuses any key not
 * in CONFIG_SPEC. Adding a setting means touching CONFIG_DEFAULTS, the
 * validator, the state payload AND that list, and missing the last one fails
 * at the worst moment: the switch renders, the operator clicks it, and the
 * page answers with the generic 无法识别的操作. That is exactly what shipped
 * for notify.call* -- the type declared them, the validator accepted them,
 * and the console could not save them.
 */
test("every per-event notify key the console renders is actually writable", () => {
  for (const event of ["Attention", "Waiting", "Finished", "Progress"]) {
    assert.equal(ok(`notify.call${event}`, true), true, `notify.call${event} must be settable`);
    assert.equal(ok(`notify.call${event}`, false), false);
    assert.equal(ok(`notify.level${event}`, "active"), "active");
  }
});
