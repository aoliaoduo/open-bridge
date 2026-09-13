/**
 * Restart, end to end: the console's 重启 must produce a NEW process, and the
 * page must be able to come back on its own.
 *
 * The whole point is what no unit test can show — that the handover really
 * happens across processes. So this file boots a real instance, asks it to
 * restart over real HTTP, watches the old pid exit, waits for the successor's
 * own runtime record, and then talks to the successor: same root, same data
 * directory, a different pid. It ends with the successor stopped, so the suite
 * leaves no process behind.
 *
 * `--port 0` on purpose: the successor replays the same argv, so it picks its own
 * free port too, and the test proves it re-registered itself (the record is how
 * the CLI — and therefore the operator — finds it again).
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRuntimeFor, routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let workspace;
let child;
let firstPid;
let firstPort;
let routeToken;
let successorPid;

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "ob-restart-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "ob-restart-home-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", workspace, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, workspace);
  firstPort = runtime.port;
  firstPid = runtime.pid;
  routeToken = routeTokenFor(home, workspace);
  assert.ok(routeToken, "route token was persisted");
});

after(async () => {
  if (successorPid) {
    try { process.kill(successorPid); } catch { /* already gone */ }
  }
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a restart hands over to a new process that registers itself", async () => {
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));

  const res = await fetch(`http://127.0.0.1:${firstPort}/api/settings/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify({ command: "restart" }),
  });
  const body = await res.json();
  // The reply is sent BEFORE the listener goes down, so it must arrive intact.
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.info, /重启/);

  // The old process exits on its own: the honest proof that this is a new
  // process and not a listener rebind.
  const code = await Promise.race([exited, delay(30_000).then(() => "timeout")]);
  assert.equal(code, 0, "the instance exits cleanly after the handover");

  // The successor published its own record — a different pid, same root.
  let successor;
  for (let i = 0; i < 60; i += 1) {
    successor = readRuntimeFor(home, workspace);
    if (successor && successor.pid !== firstPid) break;
    successor = undefined;
    await delay(250);
  }
  assert.ok(successor, "the successor registered itself in the runtime record");
  successorPid = successor.pid;
  assert.notEqual(successorPid, firstPid, "the successor is a different process");

  // And it really serves: the same console/API surface on the new port.
  let status;
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = await fetch(`http://127.0.0.1:${successor.port}/api/status`);
      if (probe.ok) { status = (await probe.json()).status; break; }
    } catch { /* still booting */ }
    await delay(250);
  }
  assert.ok(status, "the successor answers /api/status");
  assert.equal(status.state, "running");
  assert.equal(path.resolve(status.workspace_root), path.resolve(workspace),
    "the successor kept the workspace of the process it replaced");
});

test("the successor stops through its own shutdown route", async () => {
  assert.ok(successorPid, "the previous test left a live successor");
  const successor = readRuntimeFor(home, workspace);
  const res = await fetch(`http://127.0.0.1:${successor.port}/api/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
  });
  assert.equal(res.status, 200, "shutdown answers before the process exits");

  let alive = true;
  for (let i = 0; i < 60 && alive; i += 1) {
    try { process.kill(successorPid, 0); } catch { alive = false; break; }
    await delay(250);
  }
  assert.equal(alive, false, "the successor really exited");
  successorPid = undefined;
});
