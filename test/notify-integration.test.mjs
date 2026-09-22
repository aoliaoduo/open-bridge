import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { removeTempDir } from "./tmpdir.mjs";
import {
  createRpcId, jsonHeaders, makeOpenSession, makeRawRequest, startBridge,
} from "./lib/bridge-runtime.mjs";

const KEY = "iNTdevicEkey1234567890ab";
let home, child, port, routeToken, bark, barkPort;
const pushes = [];

before(async () => {
  await new Promise(resolve => {
    bark = http.createServer((req, res) => {
      pushes.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, message: "Successfully pushed" }));
    });
    bark.listen(0, "127.0.0.1", () => { barkPort = bark.address().port; resolve(); });
  });
  home = mkdtempSync(path.join(tmpdir(), "ob-notify-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({
    "notify.serverUrl": `http://127.0.0.1:${barkPort}`,
  }));
  ({ child, port, routeToken } = await startBridge({ root: home, home }));
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  bark?.close();
  await delay(200);
  removeTempDir(home);
});

const base = () => `http://127.0.0.1:${port}`;
async function consoleAction(body) {
  const res = await fetch(`${base()}/api/settings/action`, {
    method: "POST", headers: { "content-type": "application/json", "x-open-bridge-console": routeToken }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const request = makeRawRequest(() => port, 15_000);
const rpcId = createRpcId();
const rpc = (method, params = {}) => ({ jsonrpc: "2.0", id: rpcId(), method, params });
function payload(body) {
  for (const line of body.split(/\r?\n/)) if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  return undefined;
}
const openSessionBase = makeOpenSession({ request, routeToken: () => routeToken, clientName: "notify-test", nextId: rpcId });
async function openSession() {
  const opened = await openSessionBase();
  return { sessionId: opened.sessionId, instructions: payload(opened.body)?.result?.instructions ?? "" };
}
async function tool(sessionId, name, args) {
  const res = await request("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("tools/call", { name, arguments: args })), jsonHeaders({ "mcp-session-id": sessionId }));
  const result = payload(res.body)?.result;
  const text = result?.content?.[0]?.text ?? "null";
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { isError: result?.isError === true, json };
}
async function waitForPushes(count) {
  const until = Date.now() + 4_000;
  while (pushes.length < count && Date.now() < until) await delay(30);
  return pushes.length >= count;
}

let sessionId;
test("console keeps the device key write-only and MCP instructions state the two-event contract", async () => {
  const saved = await consoleAction({ command: "saveNotifyKey", key: `https://api.day.app/${KEY}/` });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.state.notify.configured, true);
  assert.ok(!JSON.stringify(saved.body).includes(KEY));
  assert.equal(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))["notify.barkKey"], KEY);

  const opened = await openSession();
  sessionId = opened.sessionId;
  assert.match(opened.instructions, /event:"waiting"/);
  assert.match(opened.instructions, /event:"finished"/);
  assert.match(opened.instructions, /immediately before, or in the same turn/);
  assert.match(opened.instructions, /never re-sends/);
});

test("only waiting and finished reach Bark, with fixed call=1 delivery", async () => {
  const rejected = await tool(sessionId, "notify", { event: "progress", message: "noise" });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.json), /Unknown event/);

  const pushesBefore = pushes.length;
  const sent = await tool(sessionId, "notify", { event: "waiting", title: "Need choice", message: "Pick one" });
  assert.equal(sent.json.delivered, true);
  assert.ok(await waitForPushes(pushesBefore + 1));
  const query = new URL(`http://bark.test${pushes[pushesBefore]}`).searchParams;
  assert.equal(query.get("group"), "open-bridge");
  assert.equal(query.get("level"), "timeSensitive");
  assert.equal(query.get("call"), "1");
  for (const removed of ["sound", "volume", "badge", "url", "icon"]) assert.equal(query.get(removed), null);
});

test("an episode gets one alert only; ordinary work opens the next episode", async () => {
  const pushesBefore = pushes.length;
  const duplicate = await tool(sessionId, "notify", { event: "finished", message: "Do not send again" });
  assert.equal(duplicate.json.delivered, false);
  assert.equal(duplicate.json.reason, "duplicate");
  await delay(300);
  assert.equal(pushes.length, pushesBefore, "no server repeat or second event push");

  await tool(sessionId, "get_todos", {});
  const next = await tool(sessionId, "notify", { event: "finished", message: "This next round ended" });
  assert.equal(next.json.delivered, true);
  assert.ok(await waitForPushes(pushesBefore + 1));
});

test("todo writes and progress create no automatic phone notification", async () => {
  const pushesBefore = pushes.length;
  const todos = await tool(sessionId, "set_todos", { todos: [{ id: "1", title: "A completed task", status: "completed" }] });
  assert.equal(todos.isError, false);
  await delay(500);
  assert.equal(pushes.length, pushesBefore, "completed todo is not a notification event");
  await tool(sessionId, "report_progress", { message: "still working", phase: "running" });
  await delay(300);
  assert.equal(pushes.length, pushesBefore, "progress is not a notification event");
});

test("the console test is a manual bypass, while disabled Bark still refuses it", async () => {
  const pushesBefore = pushes.length;
  assert.equal((await consoleAction({ command: "testNotify" })).body.ok, true);
  assert.ok(await waitForPushes(pushesBefore + 1));
  assert.equal((await consoleAction({ command: "setConfig", key: "notify.enabled", value: false })).body.ok, true);
  assert.equal((await consoleAction({ command: "testNotify" })).body.ok, false);
});
