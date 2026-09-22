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
import {mkdtempSync, readdirSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLI_BIN, createRpcId, jsonHeaders, lastSsePayload, makeOpenSession,
  makeRawRequest, startBridge, stopServe,
} from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

let home;
let child;
let port;
let routeToken;
let sessionId;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-stop-guard-"));
  ({ child, port, routeToken } = await startBridge({ root: home, home }));
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
});

/** The Git-Bash spelling of a Windows path, for the `cd` in the command. */
function bashPath(value) {
  return value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

/** Exactly what a client would type through the bridge: the CLI, from the workspace. */
function stopCommand(extra = "") {
  return `cd "${bashPath(home)}" && "${bashPath(process.execPath)}" "${bashPath(CLI_BIN)}"`
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
  // The CLI's own stdout is not the evidence: the instance it just asked to stop
  // takes its own process tree down with it, and on ubuntu/node 22 that child was
  // killed before it could flush (exit code null, empty output). The outcome is
  // what this test is about.
  const text = await callToolText("run_command", { command: stopCommand("--force"), timeout_ms: 30_000 });
  assert.doesNotMatch(text, /拒绝停止/, "the guard must not fire on --force");
  const runtimeRecords = () => readdirSync(home).filter(name => name.startsWith("runtime-"));
  for (let i = 0; i < 40 && await mcpAnswers(); i += 1) await delay(250);
  assert.equal(await mcpAnswers(), false, "the forced stop took the instance down");
  // Teardown is asynchronous: the listener closes first, the runtime record is
  // removed as the last step of the same shutdown.
  for (let i = 0; i < 40 && runtimeRecords().length > 0; i += 1) await delay(250);
  assert.deepEqual(runtimeRecords(), [], "and the runtime record went with it");
});

// ---------------------------------------------------------------- MCP plumbing
const rawRequest = makeRawRequest(() => port, 8_000);
const rpcId = createRpcId();
const openSession = makeOpenSession({ request: rawRequest, routeToken: () => routeToken, clientName: "stop-guard", nextId: rpcId });

/** The whole tool result as text: run_command answers with structured fields. */
async function callToolText(name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name, arguments: args } }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 200, `tools/call ${name} answered`);
  return JSON.stringify(lastSsePayload(res.body) ?? res.body);
}
