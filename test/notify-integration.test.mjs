/**
 * Notifications end to end: real serve process, a fake Bark server on
 * loopback (the probe's default scope admits it — the same path a stored
 * https api.day.app origin takes), a real MCP session, and the console's own
 * settings action. Pins the facts that only the wired-up system can show:
 * the set_todos bell actually fires, the mode gate actually gates, the
 * key is stored canonical, masked everywhere it is read, and never logged.
 */
import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {routeTokenFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const KEY = "iNTdevicEkey1234567890ab";

let home;
let child;
let port;
let routeToken;
let bark;
let barkPort;
/** Every GET the fake Bark received: { url, hit } in arrival order. */
const pushes = [];

before(async () => {
  await new Promise(resolve => {
    bark = http.createServer((req, res) => {
      pushes.push({ url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 200, message: "Successfully pushed" }));
    });
    bark.listen(0, "127.0.0.1", () => { barkPort = bark.address().port; resolve(); });
  });
  home = mkdtempSync(path.join(tmpdir(), "ob-notify-"));
  // Pre-seed what the instance must know BEFORE the first session: server +
  // switch. The KEY deliberately arrives through the console action below —
  // that path is part of what this suite proves.
  writeFileSync(path.join(home, "config.json"), JSON.stringify({
    "notify.serverUrl": `http://127.0.0.1:${barkPort}`,
  }));
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
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  bark?.close();
  await delay(300);
  removeTempDir(home);
});

const base = () => `http://127.0.0.1:${port}`;
async function consoleAction(body) {
  const res = await fetch(`${base()}/api/settings/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(15_000) },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}
function lastSsePayload(body) {
  let payload;
  for (const line of body.split(/\r?\n/)) if (line.startsWith("data: ")) payload = JSON.parse(line.slice(6));
  return payload;
}
let rpcId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });
const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

async function openSession(clientName) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName ?? "notify-test", version: "1" },
  })), jsonHeaders());
  const sessionId = res.headers["mcp-session-id"];
  let instructions = "";
  try { instructions = lastSsePayload(res.body)?.result?.instructions ?? ""; } catch { /* legacy res */ }
  if (sessionId) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": sessionId }));
  }
  return { sessionId, instructions };
}
async function callTool(sessionId, name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify(rpc("tools/call", { name, arguments: args })),
    jsonHeaders({ "mcp-session-id": sessionId }));
  const payload = res.status === 200 ? lastSsePayload(res.body) : null;
  return { text: payload?.result?.content?.[0]?.text ?? "", isError: payload?.result?.isError === true };
}
const toolJson = text => { try { return JSON.parse(text); } catch { return null; } };
/** Wait until `attempts` real GETs landed (async fire-and-forget pushes). */
async function waitForPushes(count, timeoutMs = 6_000) {
  const started = Date.now();
  while (pushes.length < count && Date.now() - started < timeoutMs) await delay(50);
  return pushes.length >= count;
}

let sessionId;

test("console: the pasted URL form stores the bare key; the view shows only a mask", async () => {
  const bad = await consoleAction({ command: "saveNotifyKey", key: "https://api.day.app/  " });
  assert.equal(bad.body.ok, false, "a URL with no usable key segment is refused, not cleared");
  const saved = await consoleAction({ command: "saveNotifyKey", key: `https://api.day.app/${KEY}/` });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.state.notify.configured, true);
  assert.ok(!JSON.stringify(saved.body).includes(KEY), "the action response carries only a mask");
  const stored = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(stored["notify.barkKey"], KEY, "canonical parsing happens ONCE on write");
});

test("MCP: get_config answers with the masked key — reading it back is not a credential", async () => {
  sessionId = (await openSession("notify-main")).sessionId;
  const read = toolJson((await callTool(sessionId, "get_config", {})).text);
  assert.equal(typeof read["notify.barkKey"], "string");
  assert.ok(!read["notify.barkKey"].includes(KEY), "no recoverable key through get_config");
});

test("MCP guard: notify refuses a dropped event by name", async () => {
  const r = await callTool(sessionId, "notify", { message: "done?" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Missing "event"/);
});

test("frequent mode: a todo completion is announced by the server, not by the AI's memory", async () => {
  const pushesBefore = pushes.length;
  const stored = toolJson((await callTool(sessionId, "set_todos", { todos: [
    { id: "1", title: "实现通知后端", status: "completed" },
    { id: "2", title: "写前端卡片", status: "pending" },
  ] })).text);
  assert.ok(Array.isArray(stored), "set_todos still returns the list");
  assert.ok(await waitForPushes(pushesBefore + 1), "the completion push reached the Bark channel");
  const hit = decodeURIComponent(pushes[pushesBefore].url);
  assert.ok(hit.includes(`/${KEY}/`), "the device key is the first path segment");
  assert.ok(hit.includes("实现通知后端"), "the push names the item that flipped");
  assert.ok(hit.includes("group=open-bridge"));
});

test("manual notify delivers in frequent mode; an identical repeat dedupes", async () => {
  const pushesBefore = pushes.length;
  const one = toolJson((await callTool(sessionId, "notify", {
    event: "progress", title: "覆盖测试", message: "唯一的运行消息 42",
  })).text);
  assert.equal(one.delivered, true);
  assert.ok(await waitForPushes(pushesBefore + 1));
  assert.equal(decodeURIComponent(pushes[pushesBefore].url).includes("唯一的运行消息 42"), true);
  const two = toolJson((await callTool(sessionId, "notify", {
    event: "progress", title: "覆盖测试", message: "唯一的运行消息 42",
  })).text);
  assert.equal(two.delivered, false);
  assert.equal(two.reason, "duplicate");
});

test("the task switch gates progress (manual and automatic) but never attention/waiting", async () => {
  const switched = toolJson((await callTool(sessionId, "set_config_value", {
    key: "notify.onTaskDone", value: false,
  })).text);
  assert.equal(switched.value, false);
  const progressCall = await callTool(sessionId, "notify", { event: "progress", message: "安静点" });
  const progRes = toolJson(progressCall.text);
  assert.equal(progRes.delivered, false);
  assert.equal(progRes.reason, "switch_off");
  // `waiting` surviving every switch is pinned in test/notify.test.ts against
  // eventSuppressed directly. It is NOT re-sent here on purpose: the 6-per-60s
  // budget is shared by every test in this file, and spending a real push on
  // something already proven pure would starve the later budget test.
  // The automatic bell is suppressed by the same rule: mark item 2 done and
  // confirm no new GET arrives within the suppression window.
  const pushesBefore = pushes.length;
  await callTool(sessionId, "set_todos", { todos: [
    { id: "1", title: "实现通知后端", status: "completed" },
    { id: "2", title: "写前端卡片", status: "completed" },
  ] });
  await delay(600);
  assert.equal(pushes.length, pushesBefore, "dnd is not bypassed by the todo hook");
  const done = toolJson((await callTool(sessionId, "notify", {
    event: "finished", message: "这一轮结束了，回电脑看看",
  })).text);
  assert.equal(done.delivered, true);
  assert.ok(await waitForPushes(pushesBefore + 1));
});

test("a session opened under the live config is taught the switches it must obey", async () => {
  const opened = await openSession("notify-readme");
  assert.match(opened.instructions, /Phone notifications \(Bark\)/);
  // The waiting duty is unconditional, so it must be in the text whatever the
  // switches are set to at connect time.
  assert.match(opened.instructions, /event:"waiting"/);
  assert.match(opened.instructions, /suppressed/);
});

test("the console test button rings through a closed switch, and refuses when the channel is off", async () => {
  const test1 = await consoleAction({ command: "testNotify" });
  assert.equal(test1.body.ok, true, "an operator press IS the attention; no switch may mute it");
  const off = await consoleAction({ command: "setConfig", key: "notify.enabled", value: false });
  assert.equal(off.body.ok, true);
  const test2 = await consoleAction({ command: "testNotify" });
  assert.equal(test2.body.ok, false);
  await consoleAction({ command: "setConfig", key: "notify.enabled", value: true });
  const back = await consoleAction({ command: "testNotify" });
  assert.equal(back.body.ok, true, "the off switch really blocks, and back on delivers");
});

test("writes echo masks; a refused paste names the field; no log ever holds the key", async () => {
  const bogus = await callTool(sessionId, "set_config_value", {
    key: "notify.barkKey", value: "https://api.day.app/",
  });
  assert.equal(bogus.isError, true, "a URL with no key segment cannot clear-by-typo");
  assert.match(bogus.text, /notify\.barkKey/);
  const echo = toolJson((await callTool(sessionId, "set_config_value", {
    key: "notify.barkKey", value: "  " + KEY + " ",
  })).text);
  assert.ok(echo, "the valid write succeeded");
  assert.ok(!JSON.stringify(echo).includes(KEY), "the write echo is masked like every other read");
  await delay(300);
  for (const file of ["audit.log", path.join("logs", "bridge.log")]) {
    let text = "";
    try { text = readFileSync(path.join(home, file), "utf8"); } catch { /* absent */ }
    assert.ok(!text.includes(KEY), `${file} must never hold the device key in clear`);
  }
});

test("the audit line reports what actually happened, including the silences", async () => {
  // The old line was hardcoded `record("notify", "progress", ...)` and written
  // BEFORE the send, so a delivered `finished` event read as
  // "[notify] progress: push finished" and a failed one still claimed a push.
  // Worse, every gated path returned silently, which made "why didn't my phone
  // ring?" undebuggable. Both halves are pinned here.
  const readLog = () => {
    try { return readFileSync(path.join(home, "logs", "bridge.log"), "utf8"); } catch { return ""; }
  };

  // Deliveries earlier in this file already wrote their lines; assert on those
  // rather than sending another. The 6-per-60s budget is shared by every test
  // here, and spending one to re-prove a delivery would starve the budget test.
  const sentLines = readLog().split("\n").filter(l => l.includes("[notify]"));
  assert.ok(
    sentLines.some(l => l.includes("completed:") && l.includes("sent ")),
    `a delivered push logs as completed/sent, got: ${sentLines.slice(-6).join(" | ")}`,
  );
  assert.ok(
    !sentLines.some(l => /progress: push (finished|attention|waiting)/.test(l)),
    "the old miscategorised wording is gone",
  );

  // A suppressed push must leave a trace naming the reason. This one costs no
  // budget by construction: it never reaches the wire.
  await callTool(sessionId, "set_config_value", { key: "notify.onFinish", value: false });
  const beforeGated = readLog().length;
  const gated = toolJson((await callTool(sessionId, "notify", {
    event: "finished", message: "这条会被开关挡住",
  })).text);
  assert.equal(gated.delivered, false);
  assert.equal(gated.reason, "switch_off");
  await delay(400);
  const gatedLines = readLog().slice(beforeGated).split("\n").filter(l => l.includes("[notify]"));
  assert.ok(
    gatedLines.some(l => l.includes("not sent (switch_off)")),
    `a gated push says so in the log, got: ${gatedLines.join(" | ")}`,
  );
  await callTool(sessionId, "set_config_value", { key: "notify.onFinish", value: true });
});

test("the operator's settings decide presentation; caller knobs do nothing", async () => {
  // This used to assert the opposite: the AI passed sound/level/badge and they
  // appeared on the push verbatim. That was the bug. Those knobs were merged
  // OVER the operator's per-event settings, so a model could answer
  // level:"critical" and pierce a silent mode the operator had chosen, or
  // call:1 and start a ring they had switched off -- decisions made blind,
  // since the model cannot read the settings page.
  //
  // The knobs are gone from the tool schema. This pins the end-to-end result:
  // config supplies the level, and leftover knobs from an old prompt or a
  // stale client change nothing.
  await callTool(sessionId, "set_config_value", { key: "notify.levelAttention", value: "timeSensitive" });

  const knobsBefore = pushes.length;
  const sent = toolJson((await callTool(sessionId, "notify", {
    event: "attention", title: "灵活通知", message: "等级来自设置",
    // Not in the schema any more. Sending them must be harmless, not obeyed.
    sound: "minuet", level: "critical", badge: 2, call: 1,
  })).text);
  assert.equal(sent.delivered, true, `attention passes every switch (reason: ${sent.reason})`);
  assert.ok(await waitForPushes(knobsBefore + 1));

  const query = new URL(`https://bark.test${pushes[knobsBefore].url}`).searchParams;
  assert.equal(query.get("level"), "timeSensitive", "the operator's level, not the caller's");
  assert.equal(query.get("call"), null, "a caller cannot start a ring");
  assert.equal(query.get("sound"), null, "no caller-chosen ringtone");
  assert.equal(query.get("badge"), null, "no caller-chosen badge");
  assert.equal(query.get("group"), "open-bridge");

  // That the level tracks the setting rather than being a constant is covered
  // in test/notify-knobs.test.ts, against withEventDefaults directly. Proving it a
  // second time here would cost a second real push, and this suite also tests
  // the per-minute budget -- a `rate_limited` in an unrelated case is a
  // confusing way to fail.
});


test("the per-minute budget bounds a runaway loop", async () => {
  await callTool(sessionId, "set_config_value", { key: "notify.onTaskDone", value: true });
  const results = [];
  for (let i = 0; i < 12; i += 1) {
    const r = toolJson((await callTool(sessionId, "notify", {
      event: "attention", message: `限流测试-${i}`,
    })).text);
    results.push(r.delivered ? "sent" : r.reason);
  }
  const sent = results.filter(r => r === "sent").length;
  assert.ok(sent <= 6 && sent < 12, `the loop was bounded by the window (sent ${sent}/12)`);
  assert.ok(results.includes("rate_limited"), "and the budget visibly answered the rest");
});
