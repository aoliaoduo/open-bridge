/**
 * Self-stop guard, end to end: the command an agent is most likely to type into
 * the very instance that serves it — `open-bridge stop` — must be refused, while
 * a human running the same command outside that instance must still be able to
 * stop it (here: with `--force`, which is also the documented way out).
 *
 * The whole point is what a unit test cannot show: the guard fires on the *real*
 * inheritance path (serve → spawn → shell → CLI) and the refused command really
 * does leave the instance answering, while the forced one really does take it
 * down. So this file owns its instance and ends with that instance dead.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CLI = path.join(ROOT, "bin", "open-bridge.js");

let home;
let child;
let port;
let routeToken;
let sessionId;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-stop-guard-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(home, { recursive: true, force: true });
});

/** The Git-Bash spelling of a Windows path, for the `cd` in the command. */
function bashPath(value) {
  return value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

/** Exactly what a client would type through the bridge: the CLI, from the workspace. */
function stopCommand(extra = "") {
  return `cd "${bashPath(home)}" && "${bashPath(process.execPath)}" "${bashPath(CLI)}"`
    + ` stop --home '${home}'${extra ? ` ${extra}` : ""}`;
}

/** Is the instance still serving its MCP endpoint? The channel itself, not a ping. */
async function mcpAnswers() {
  try {
    const res = await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/list", params: {} }),
      jsonHeaders({ "mcp-session-id": sessionId }));
    return res.status === 200;
  } catch {
    return false;
  }
}

test("a stop typed from inside the instance is refused, and the instance lives on", async () => {
  const text = await callToolText("run_command", { command: stopCommand(), timeout_ms: 30_000 });
  assert.match(text, /拒绝停止 pid \d+/, "the CLI must refuse, not shut the instance down");
  assert.doesNotMatch(text, /已发送停止指令/, "no shutdown request may reach the instance");
  for (let i = 0; i < 3 && !(await mcpAnswers()); i += 1) await delay(200);
  assert.ok(await mcpAnswers(), "the refused stop left the MCP endpoint serving");
  const again = await callToolText("run_command", { command: "echo still-here", timeout_ms: 20_000 });
  assert.match(again, /still-here/, "and its tools keep working");
});

test("--force still stops it: the way out is real, not decorative", async () => {
  const text = await callToolText("run_command", { command: stopCommand("--force"), timeout_ms: 30_000 });
  assert.match(text, /已发送停止指令|已停止/, "the forced stop went through");
  const runtimeRecords = () => readdirSync(home).filter(name => name.startsWith("runtime-"));
  for (let i = 0; i < 40 && await mcpAnswers(); i += 1) await delay(250);
  assert.equal(await mcpAnswers(), false, "the forced stop took the instance down");
  // Teardown is asynchronous: the listener closes first, the runtime record is
  // removed as the last step of the same shutdown.
  for (let i = 0; i < 40 && runtimeRecords().length > 0; i += 1) await delay(250);
  assert.deepEqual(runtimeRecords(), [], "and the runtime record went with it");
});

// ---------------------------------------------------------------- MCP plumbing
function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(8_000) },
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

function lastSsePayload(body) {
  let payload;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) payload = JSON.parse(line.slice(6));
  }
  return payload;
}

let rpcId = 1;
const jsonHeaders = extra => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});

async function openSession() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: rpcId++, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stop-guard", version: "1" } },
  }), jsonHeaders());
  const session = res.headers["mcp-session-id"];
  if (session) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": session }));
  }
  return { sessionId: session, body: res.body };
}

/** The whole tool result as text: run_command answers with structured fields. */
async function callToolText(name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 200, `tools/call ${name} answered`);
  return JSON.stringify(lastSsePayload(res.body) ?? res.body);
}
