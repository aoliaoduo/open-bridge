/**
 * After a Bridge restart, a 2025-era client that still holds its mcp-session-id
 * must be served — not 404'd. The ticket is what survives the process; a
 * never-issued id still expires.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRuntimeFor, routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let child;
let port;
let routeToken;

function startBridge() {
  return spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function bindChild(proc) {
  child = proc;
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-session-resume-"));
  await bindChild(startBridge());
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(home);
});

function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(15_000) },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

let rpcId = 1;
const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

test("a session id minted before restart still serves tools/call", async () => {
  const init = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId++,
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
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "bridge_status", arguments: {} } }),
    jsonHeaders({ "mcp-session-id": sessionId }),
  );
  assert.equal(served.status, 200, `restarted Bridge should resume the session, got ${served.status} ${served.body.slice(0, 400)}`);
});
