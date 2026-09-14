import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authToggleVerdict,
  normalizeSettingsMessage,
  ttlLabel,
  TTL_CHOICES,
} from "../src/bridge/settings-model.js";

// --- message normalization -------------------------------------------------

test("normalize passes through every command the page can send", () => {
  const simple = ["copyPrompt", "start", "stop", "rotateEndpoint", "purgeTokens", "revokeAll"];
  for (const command of simple) {
    assert.deepEqual(normalizeSettingsMessage({ command }), { command }, command);
  }
});

test("normalize rejects unknown, missing and non-object messages", () => {
  assert.equal(normalizeSettingsMessage(null), null);
  assert.equal(normalizeSettingsMessage("copyPrompt"), null);
  assert.equal(normalizeSettingsMessage({}), null);
  assert.equal(normalizeSettingsMessage({ command: "eval" }), null);
  assert.equal(normalizeSettingsMessage({ command: "copyPrompt;deleteEverything" }), null);
  // The webview-era commands are gone from the allowlist, not just unused:
  // an old client still sending them gets the same null every other unknown
  // command gets, rather than a silently-accepted no-op.
  for (const gone of ["ready", "copyUrl", "copySecret", "dismissSecret"]) {
    assert.equal(normalizeSettingsMessage({ command: gone }), null, `retired: ${gone}`);
  }
});

test("normalize validates id-bearing commands strictly", () => {
  assert.deepEqual(normalizeSettingsMessage({ command: "revokeToken", id: " ab12cd34 " }), { command: "revokeToken", id: "ab12cd34" });
  assert.equal(normalizeSettingsMessage({ command: "deleteToken" }), null, "missing id");
  assert.equal(normalizeSettingsMessage({ command: "deleteToken", id: "" }), null, "empty id");
  assert.equal(normalizeSettingsMessage({ command: "deleteToken", id: 42 }), null, "non-string id");
  assert.equal(normalizeSettingsMessage({ command: "deleteToken", id: "x".repeat(65) }), null, "over-long id");
});

test("normalize allowlists TTL values and trims labels", () => {
  for (const { seconds } of TTL_CHOICES) {
    assert.deepEqual(normalizeSettingsMessage({ command: "setDefaultTtl", seconds }), { command: "setDefaultTtl", seconds });
    assert.deepEqual(
      normalizeSettingsMessage({ command: "createToken", label: " my token ", ttlSeconds: seconds }),
      { command: "createToken", label: "my token", ttlSeconds: seconds },
    );
  }
  assert.equal(normalizeSettingsMessage({ command: "setDefaultTtl", seconds: 1234 }), null, "arbitrary ttl rejected");
  assert.equal(normalizeSettingsMessage({ command: "createToken", label: "x", ttlSeconds: -1 }), null);
  assert.deepEqual(
    normalizeSettingsMessage({ command: "createToken", ttlSeconds: 0 }),
    { command: "createToken", label: "", ttlSeconds: 0 },
    "empty label is allowed — the host mints a dated fallback name",
  );
});

test("normalize accepts the one-step lock command, TTL optional", () => {
  // The console arms the lock from 体检 with no payload at all; the host then
  // falls back to its configured default TTL.
  assert.deepEqual(normalizeSettingsMessage({ command: "armPublicLock" }), { command: "armPublicLock", label: "" });
  assert.deepEqual(
    normalizeSettingsMessage({ command: "armPublicLock", label: " tunnel ", ttlSeconds: 3_600 }),
    { command: "armPublicLock", label: "tunnel", ttlSeconds: 3_600 },
  );
  assert.deepEqual(normalizeSettingsMessage({ command: "armPublicLock", ttlSeconds: null }), { command: "armPublicLock", label: "" });
  assert.equal(normalizeSettingsMessage({ command: "armPublicLock", ttlSeconds: 1_234 }), null, "arbitrary ttl rejected");
});

test("normalize validates the domain and concurrency payloads", () => {
  assert.deepEqual(normalizeSettingsMessage({ command: "saveDomain", domain: " my.ngrok-free.dev " }), { command: "saveDomain", domain: "my.ngrok-free.dev" });
  assert.equal(normalizeSettingsMessage({ command: "saveDomain", domain: "   " }), null);
  // Embedded spaces pass through untouched — rewriting the user's input here
  // would launder "not a domain" into a plausible-looking hostname.
  assert.deepEqual(normalizeSettingsMessage({ command: "saveDomain", domain: "not a domain" }), { command: "saveDomain", domain: "not a domain" });
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConcurrency", enabled: true, holdTimeoutMs: 300000, waitTimeoutMs: 120000 }),
    { command: "setConcurrency", enabled: true, holdTimeoutMs: 300000, waitTimeoutMs: 120000 },
  );
  assert.equal(normalizeSettingsMessage({ command: "setConcurrency", enabled: true, holdTimeoutMs: -5, waitTimeoutMs: 0 }), null);
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConcurrency", holdTimeoutMs: 0, waitTimeoutMs: 0 }),
    { command: "setConcurrency", enabled: false, holdTimeoutMs: 0, waitTimeoutMs: 0 },
    "absent enabled normalizes to false rather than being rejected",
  );
});

test("normalize bounds copyText and setAuthEnabled payloads", () => {
  assert.deepEqual(normalizeSettingsMessage({ command: "copyText", text: "abc123" }), { command: "copyText", text: "abc123" });
  assert.equal(normalizeSettingsMessage({ command: "copyText", text: "" }), null);
  assert.deepEqual(normalizeSettingsMessage({ command: "setAuthEnabled", enabled: true }), { command: "setAuthEnabled", enabled: true });
  assert.deepEqual(normalizeSettingsMessage({ command: "setAuthEnabled", enabled: "yes" }), { command: "setAuthEnabled", enabled: false }, "non-boolean becomes false");
});

test("normalize validates setConfig against the per-key spec", () => {
  // autoStart belonged to the VS Code host (it starts the Bridge on activation).
  // Nothing in the standalone app read it, so the key was removed from every
  // surface rather than kept as a switch that could not cause anything: the
  // generic path must reject it like any other unknown key.
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "autoStart", value: true }), null, "removed key rejected");
  assert.deepEqual(normalizeSettingsMessage({ command: "setConfig", key: "toolProfile", value: " core " }), { command: "setConfig", key: "toolProfile", value: "core" });
  assert.deepEqual(normalizeSettingsMessage({ command: "setConfig", key: "port", value: 8080 }), { command: "setConfig", key: "port", value: 8080 });
  assert.deepEqual(normalizeSettingsMessage({ command: "setConfig", key: "port", value: 0 }), { command: "setConfig", key: "port", value: 0 }, "0 is a valid sentinel (auto port)");
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConfig", key: "shellArgs", value: [" -NoLogo ", "", "-ExecutionPolicy Bypass"] }),
    { command: "setConfig", key: "shellArgs", value: ["-NoLogo", "-ExecutionPolicy Bypass"] },
    "arrays are trimmed and empty lines dropped",
  );
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "notASetting", value: 1 }), null, "unknown key rejected");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "port", value: 70000 }), null, "out-of-range number rejected");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "port", value: 8080.5 }), null, "non-integer rejected");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "port", value: true }), null, "boolean must not coerce into a number");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "port", value: "8080" }), null, "numeric string must not coerce into a number");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "toolProfile", value: "everything" }), null, "unknown enum value rejected");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "shellPath", value: 42 }), null, "wrong type rejected");
  // Managed flows own these keys: the generic path must never reach them.
  for (const key of ["auth.enabled", "auth.tokenTtlSeconds", "concurrency.enabled", "concurrency.holdTimeoutMs", "ngrokDomain"]) {
    assert.equal(normalizeSettingsMessage({ command: "setConfig", key, value: true }), null, `guarded key rejected: ${key}`);
  }
});

test("setConfig shares the MCP validator: no silent coercion or truncation", () => {
  // The drift this unification fixes: the console used to store `false` for
  // a garbage boolean and keep relative directories / over-cap values.
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "autoReconnect", value: "yes" }), null, "garbage boolean refused, not stored as false");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "unrestrictedFileAccess", value: 1 }), null);
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "allowedDirectories", value: ["relative/path"] }), null, "relative dir refused");
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "allowedDirectories", value: [""] }), null);
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConfig", key: "allowedDirectories", value: [" C:\\tools ", "/tmp/x"] }),
    { command: "setConfig", key: "allowedDirectories", value: ["C:\\tools", "/tmp/x"] },
    "absolute entries trimmed, not rejected",
  );
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "shellArgs", value: new Array(51).fill("x") }), null, "over-cap rejected, not truncated");
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConfig", key: "oauth.allowedRedirectHosts", value: ["Example.COM "] }),
    { command: "setConfig", key: "oauth.allowedRedirectHosts", value: ["example.com"] },
    "hosts lowercased like the MCP path",
  );
  assert.deepEqual(
    normalizeSettingsMessage({ command: "setConfig", key: "logMaxBytes", value: 1024 }),
    { command: "setConfig", key: "logMaxBytes", value: 1024 },
  );
  assert.equal(normalizeSettingsMessage({ command: "setConfig", key: "logMaxBytes", value: -1 }), null);
});

// --- auth toggle guard -------------------------------------------------------

test("auth toggle refuses to enable with zero usable tokens (fail-closed)", () => {
  const blocked = authToggleVerdict(true, 0);
  assert.equal(blocked.allow, false);
  assert.ok(blocked.reason && blocked.reason.includes("失败关闭"), "explains the fail-closed semantics");
  assert.equal(authToggleVerdict(true, 2).allow, true);
  assert.equal(authToggleVerdict(false, 0).allow, true, "disabling is always allowed");
});

// --- labels ------------------------------------------------------------------

test("ttlLabel covers permanent, known choices and generic fallbacks", () => {
  assert.equal(ttlLabel(0), "永久");
  assert.equal(ttlLabel(3_600), "1 小时");
  assert.equal(ttlLabel(86_400), "24 小时");
  assert.equal(ttlLabel(7 * 86_400), "7 天");
  assert.equal(ttlLabel(30 * 86_400), "30 天");
  assert.equal(ttlLabel(90), "90 秒");
  assert.equal(ttlLabel(5_400), "90 分钟");
  assert.equal(ttlLabel(Number.NaN), "永久");
});

// --- page rendering ----------------------------------------------------------
