/**
 * After a Bridge restart, a 2025-era client that still holds its mcp-session-id
 * must be served — not 404'd. The ticket is what survives the process; a
 * never-issued id still expires.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRpcId, jsonHeaders, makeRawRequest, readRuntimeFor,
  spawnServe, stopServe, waitForRouteToken, waitForRuntime,
} from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

let home;
let child;
let port;
let routeToken;

function startBridge() {
  return spawnServe({ root: home, home });
}

async function bindChild(proc) {
  child = proc;
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  routeToken = await waitForRouteToken(home, home);
  assert.ok(routeToken, "route token was persisted");
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-session-resume-"));
  await bindChild(startBridge());
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
});

const rawRequest = makeRawRequest(() => port, 15_000);
const rpcId = createRpcId();

test("a session id minted before restart still serves tools/call", async () => {
  const init = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId(),
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "resume-test", version: "1" } },
  }), jsonHeaders());
  assert.equal(init.status, 200, init.body);
  const sessionId = init.headers["mcp-session-id"];
  assert.ok(sessionId);

  await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    jsonHeaders({ "mcp-session-id": sessionId }));

  const stateRaw = readFileSync(path.join(home, "state.json"), "utf8");
  assert.match(stateRaw, new RegExp(sessionId), `ticket should be on disk before restart: ${stateRaw.slice(0, 500)}`);

  const oldPort = port;
  if (child && !child.killed) child.kill("SIGTERM");
  child = startBridge();
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 20_000) {
    const info = readRuntimeFor(home, home);
    if (info && info.port > 0 && info.port !== oldPort) {
      port = info.port;
      ready = true;
      break;
    }
    await delay(250);
  }
  assert.ok(ready, "restarted Bridge published a new runtime port");

  const served = await rawRequest(
    "POST",
    `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name: "bridge_status", arguments: {} } }),
    jsonHeaders({ "mcp-session-id": sessionId }),
  );
  assert.equal(served.status, 200, `restarted Bridge should resume the session, got ${served.status} ${served.body.slice(0, 400)}`);
});
