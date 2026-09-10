import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeServiceLogName, serviceLogFilePath, SERVICE_LOG_MAX_BYTES } from "../src/bridge/service-log.js";

test("sanitize keeps [a-zA-Z0-9_-] and maps everything else to _", () => {
  assert.equal(sanitizeServiceLogName("api server"), "api_server");
  assert.equal(sanitizeServiceLogName("web/api:1"), "web_api_1");
  assert.equal(sanitizeServiceLogName("ok-Name_2"), "ok-Name_2");
});

test("explicit log_file override wins and is resolved by the resolver", () => {
  const p = serviceLogFilePath(
    { name: "web api", logFile: "logs/my log.txt" },
    { storageDir: "/gs", workspaceHash: "abc123456789", resolvePath: input => `C:/ws/${input}` },
  );
  assert.equal(p, "C:/ws/logs/my log.txt");
});

test("default path is <storage>/service-logs/<wsHash8>/<sanitized>.log", () => {
  const p = serviceLogFilePath(
    { name: "web api" },
    { storageDir: "/gs", workspaceHash: "abcdef0123456789", resolvePath: input => input },
  );
  assert.equal(p.replace(/\\/g, "/"), "/gs/service-logs/abcdef01/web_api.log");
});

test("SERVICE_LOG_MAX_BYTES is 5 MiB", () => {
  assert.equal(SERVICE_LOG_MAX_BYTES, 5 * 1024 * 1024);
});
