import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareServiceLog,
  sanitizeServiceLogName,
  serviceLogFilePath,
  SERVICE_LOG_MAX_BYTES,
} from "../src/bridge/runtime/service-log.js";

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

test("a service log whose rotation fails keeps its bytes", async () => {
  // Sparse file, instantly at the cap; .1 as a directory defeats the rename.
  const dir = await mkdtemp(path.join(tmpdir(), "ob-svclog-"));
  try {
    const file = path.join(dir, "api.log");
    await writeFile(file, "");
    await truncate(file, SERVICE_LOG_MAX_BYTES);
    await mkdir(`${file}.1`, { recursive: true });

    await prepareServiceLog(file);

    assert.equal((await stat(file)).size, SERVICE_LOG_MAX_BYTES, "the un-rotated history is still on disk");
    assert.ok((await stat(`${file}.1`)).isDirectory(), "the rename really was impossible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
