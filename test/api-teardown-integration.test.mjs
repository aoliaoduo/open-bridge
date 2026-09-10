/**
 * Teardown-order integration test.
 *
 * Both surfaces that end the process — the console's Stop action and
 * /api/shutdown — must deliver their response BEFORE the listener goes away.
 * The response travels over the very socket that stopping closes, so writing it
 * afterwards reaches the caller as ECONNRESET with no body: the console's Stop
 * button reported a failure for a stop that had in fact succeeded, and left the
 * operator with no explanation of what just happened.
 *
 * Lives in its own file because it consumes the process: the main integration
 * suite still needs a live instance for its own /api/shutdown test.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let child;
let port;
let routeToken;

async function waitForRuntime(timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const file = path.join(home, "runtime.json");
    if (existsSync(file)) {
      try {
        const info = JSON.parse(readFileSync(file, "utf8"));
        if (info.port > 0) return info;
      } catch { /* partial write */ }
    }
    await delay(250);
  }
  throw new Error("runtime.json never appeared — serve failed to start");
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-teardown-test-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime();
  port = runtime.port;
  const suffix = createHash("sha256").update(home).digest("hex").slice(0, 24);
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try {
      routeToken = JSON.parse(readFileSync(path.join(home, "secrets.json"), "utf8"))[
        `openBridge.routeToken.${suffix}`
      ];
    } catch { /* not written yet */ }
    if (!routeToken) await delay(250);
  }
  assert.ok(routeToken, "route token was persisted");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(home, { recursive: true, force: true });
});

test("the console's stop action answers before the listener goes away", async () => {
  const exit = new Promise(resolve => child.on("exit", resolve));

  const res = await fetch(`http://127.0.0.1:${port}/api/settings/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify({ command: "stop" }),
  });

  // The assertion that fails on the old ordering: no status line at all.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.state.running, false, "the response describes the outcome, not the stale snapshot");
  assert.equal(body.state.mcpUrl, "", "no endpoint is advertised once stopped");
  assert.match(body.info, /已停止/);

  // Stopping is meant to end the process, not to leave a listener-less zombie.
  const code = await exit;
  assert.equal(code, 0, `serve exited ${code}`);
});
