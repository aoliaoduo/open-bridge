/**
 * The argument contract, end to end: when a caller drops an argument the schema
 * marks required — or supplies one the tool cannot honour — the tool must NAME
 * it, never coerce it and carry on.
 *
 * `String(undefined)` is the literal text "undefined" and `?? ""` is a silent
 * no-op, so an unguarded handler answers success while having done the wrong
 * thing. The turn-42 audit fixed this for paths (`Missing "path"` — see
 * file-op-guards-integration.test.mjs). The turn-49 audit found the same shape
 * still living in four more places, each proved here against a live instance:
 *
 *  ① `interact_with_process` wrote `undefined\n` to the child's stdin and
 *     reported success. The child below is a three-line stdin echo, so "what did
 *     the process actually see" is answered by the process itself rather than by
 *     re-reading the handler.
 *  ② every process tool looked the id up as `String(args.command_id)`, so a
 *     dropped id came back as `Unknown command id: "undefined"` — a
 *     misdiagnosis that sends the caller hunting for a stale id it never had.
 *  ③ `report_progress` recorded an empty progress entry, pushed an empty logging
 *     notification, and reported success.
 *  ④ `connectivity` probed the literal host "undefined" / port NaN and answered
 *     with a generic INVALID_URL / INVALID_PORT that never named the argument.
 *  ⑤ `set_process_policy` ran the two auto-restart knobs through
 *     `Math.max(0, Number(x))`, which for NaN is NaN — not 0 — and wrote it
 *     straight onto a LIVE process. `save_service` already refused that shape;
 *     its sibling did not, so the two entry points disagreed about one rule.
 *  ⑥ `list_directory` ran `depth` through `Math.max(Number(x), 1)`, and
 *     `Math.max(NaN, 1)` is NaN: every `level < NaN` test is false, so a garbage
 *     depth answered with a depth-1 listing and no error at all.
 *
 * Absence is refused; an explicit empty or odd-but-workable value is NOT.
 * `input: ""` is still a bare newline, `message: ""` still carries
 * phase/category, `get_process_snapshot` still treats an omitted `command_id` as
 * "every command", and `depth: 0` still clamps to 1 — refusing those would trade
 * a real bug for a lost capability.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let workspace;
let home;
let child;
let port;
let routeToken;
let sessionId;

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "ob-reqargs-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "ob-reqargs-home-"));
  // The stdin listener is registered BEFORE the ready line, so a caller that
  // sees READY knows the listener is attached — nothing left to guess at.
  // `console.log` rather than `stdout.write("READY\n")`: this string is a JS
  // literal inside a JS literal, and one level of escaping is easy to get wrong.
  writeFileSync(
    path.join(workspace, "echo-stdin.mjs"),
    'process.stdin.on("data", d => process.stdout.write("GOT:" + d));\nconsole.log("READY");\n',
    "utf8",
  );
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", workspace, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, workspace);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, workspace); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(workspace);
  removeTempDir(home);
});

/** Start the stdin echo and return its command id, once it is really ready. */
async function startEcho() {
  // ready_pattern instead of a fixed sleep. `node --test` runs the integration
  // files in parallel and each one boots its own instance, so under load the
  // 900 ms guess at "node has cold-started and attached its stdin listener"
  // intermittently lost the race and the first test in this file failed. READY
  // is printed only after that listener is registered, so waiting for it waits
  // for exactly what these tests depend on — and no longer.
  const started = asObject(await callTool("start_process", {
    command: "node echo-stdin.mjs",
    ready_pattern: "READY",
    ready_timeout_ms: 30_000,
  }));
  assert.ok(started.command_id, `start_process returned a command id: ${JSON.stringify(started).slice(0, 200)}`);
  assert.notEqual(started.ready, false,
    `the echo process came up ready: status=${started.status} out=${String(started.output).slice(0, 300)} err=${String(started.stderr).slice(0, 300)}`);
  return started.command_id;
}

// --- ① interact_with_process: input ---------------------------------------

test("an omitted `input` is refused, and the process never sees \"undefined\"", async () => {
  const commandId = await startEcho();

  const refused = await callTool("interact_with_process", { command_id: commandId, wait_ms: 300 });
  assert.equal(refused.isError, true, "omitting the required input must fail");
  assert.match(refused.text, /Missing "input"/, "the refusal names the argument");

  const seen = await callTool("read_process_output", { command_id: commandId });
  assert.equal(seen.isError, false, "the process is still readable after the refusal");
  assert.doesNotMatch(seen.text, /undefined/, "nothing was written to the process");

  const echoed = asObject(await callTool("interact_with_process", {
    command_id: commandId, input: "hello", wait_ms: 400,
  }));
  assert.match(String(echoed.output ?? ""), /GOT:hello/, "the very next call still reaches the process");

  await callTool("process_control", { action: "terminate", command_id: commandId });
});

test("an empty `input` is still a real input: the guard rejects absence, not blank text", async () => {
  const commandId = await startEcho();

  const sent = asObject(await callTool("interact_with_process", {
    command_id: commandId, input: "", wait_ms: 400,
  }));
  assert.equal(sent.status, "running", "the process is untouched by a blank input");
  assert.match(String(sent.output ?? ""), /GOT:/, "a blank input is a bare newline, as before");

  await callTool("process_control", { action: "terminate", command_id: commandId });
});

// --- ② every process tool: command_id -------------------------------------

test("an omitted `command_id` is named, not reported as an unknown id", async () => {
  const cases = [
    ["read_process_output", {}],
    ["interact_with_process", { input: "x" }],
    ["set_process_policy", { auto_restart: false }],
    ["process_control", { action: "terminate" }],
    ["process_control", { action: "restart" }],
  ];
  for (const [tool, args] of cases) {
    const res = await callTool(tool, args);
    assert.equal(res.isError, true, `${tool} without command_id must fail`);
    assert.match(res.text, /Missing "command_id"/, `${tool} names the argument it was not given`);
    assert.doesNotMatch(res.text, /Unknown command id/,
      `${tool} must not misdiagnose a missing argument as a stale id`);
  }
});

test("a present-but-unknown `command_id` still says so, and still lists the live ones", async () => {
  const commandId = await startEcho();

  const res = await callTool("read_process_output", { command_id: "deadbeefdeadbeef" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Unknown command id: "deadbeefdeadbeef"/, "a real lookup miss is still a lookup miss");
  assert.match(res.text, /Active command ids:/, "the recovery hint survived the refactor");
  assert.match(res.text, new RegExp(commandId), "and it names the id that actually is live");

  await callTool("process_control", { action: "terminate", command_id: commandId });
});

test("`get_process_snapshot` keeps command_id optional: omitted still means every command", async () => {
  const commandId = await startEcho();

  const all = await callTool("get_process_snapshot", {});
  assert.equal(all.isError, false, `omitting command_id must still list everything: ${all.text}`);
  assert.match(all.text, new RegExp(commandId), "the live command is in the list");

  const one = await callTool("get_process_snapshot", { command_id: commandId });
  assert.equal(one.isError, false, `naming one command still works: ${one.text}`);
  assert.match(one.text, new RegExp(commandId));

  await callTool("process_control", { action: "terminate", command_id: commandId });
});

// --- ③ service: action-specific name --------------------------------------

test("single-service actions name a missing service name instead of inventing an unknown one", async () => {
  for (const action of ["start", "stop", "restart", "delete"]) {
    const missing = await callTool("service", { action });
    assert.equal(missing.isError, true, `service ${action} without name must fail`);
    assert.match(missing.text, /Missing "name"/, `service ${action} names its missing argument`);
    assert.doesNotMatch(missing.text, /Unknown service/, `service ${action} is not misdiagnosed as a lookup failure`);
  }
});

// --- ④ report_progress: message -------------------------------------------

test("`report_progress` refuses a dropped message but still accepts an empty one", async () => {
  const missing = await callTool("report_progress", { phase: "running", category: "test" });
  assert.equal(missing.isError, true, "a dropped message must not become a silent no-op");
  assert.match(missing.text, /Missing "message"/, "the refusal names the argument");

  const blank = await callTool("report_progress", { message: "", phase: "verifying", category: "test" });
  assert.equal(blank.isError, false,
    `an explicit empty message is still a report — phase/category carry it: ${blank.text}`);

  const normal = await callTool("report_progress", { message: "still here", phase: "verifying" });
  assert.equal(normal.isError, false, `the ordinary call is untouched: ${normal.text}`);

  // persistProgress enqueues a serialized write and returns immediately (see
  // enqueueTodoWrite), so get_todos reads the store before the queue drains.
  // Poll rather than assume synchronous visibility, and rather than make
  // report_progress await disk I/O on a transient progress path.
  let lastMessage = "";
  for (let i = 0; i < 40 && lastMessage !== "still here"; i += 1) {
    const readBack = asObject(await callTool("get_todos", {}));
    lastMessage = String(readBack.last_progress?.message ?? "");
    if (lastMessage !== "still here") await delay(100);
  }
  assert.equal(lastMessage, "still here",
    "the last real report is the one that stuck — the refused call wrote nothing over it");
});

// --- ④ connectivity: url / port -------------------------------------------

test("`connectivity` names the argument it was not given, and still probes when given one", async () => {
  const noUrl = await callTool("connectivity", { target: "http" });
  assert.equal(noUrl.isError, true);
  assert.match(noUrl.text, /Missing "url"/, "http without a url names the argument");

  const noPort = await callTool("connectivity", { target: "port" });
  assert.equal(noPort.isError, true);
  assert.match(noPort.text, /Missing "port"/, "port without a port names the argument");

  const live = asObject(await callTool("connectivity", { target: "port", host: "127.0.0.1", port }));
  assert.equal(live.open, true, "the bridge's own port is open, so the probe path still works");

  const outOfRange = await callTool("connectivity", { target: "port", port: 999999 });
  assert.equal(outOfRange.isError, true, "an out-of-range port is still rejected");
  assert.match(outOfRange.text, /integer between 1 and 65535/,
    "by normalizePort's own message — the absence guard did not swallow it");
});

// --- ⑤ a value the tool cannot honour ------------------------------------

test("`list_directory` refuses a garbage depth instead of silently listing one level", async () => {
  // `Math.max(Number("abc"), 1)` is NaN, and every `level < NaN` test is false,
  // so a garbage depth used to answer with a depth-1 listing and no error at all.
  mkdirSync(path.join(workspace, "sub", "deeper"), { recursive: true });
  writeFileSync(path.join(workspace, "sub", "deeper", "leaf.txt"), "x", "utf8");

  const garbage = await callTool("list_directory", { path: ".", depth: "abc" });
  assert.equal(garbage.isError, true, "a non-numeric depth must fail, not degrade");
  assert.match(garbage.text, /depth must be a number/, "the refusal names the argument");

  const objectDepth = await callTool("list_directory", { path: ".", depth: {} });
  assert.equal(objectDepth.isError, true, "an object depth must fail too");

  const shallow = await callTool("list_directory", { path: ".", depth: 1 });
  assert.equal(shallow.isError, false, `depth 1 still works: ${shallow.text}`);
  assert.doesNotMatch(shallow.text, /leaf\.txt/, "depth 1 does not reach the nested file");

  const deep = await callTool("list_directory", { path: ".", depth: 3 });
  assert.equal(deep.isError, false, `depth 3 still works: ${deep.text}`);
  assert.match(deep.text, /leaf\.txt/, "and depth 3 does reach it");

  // Capability preserved on purpose: a numeric string still coerces, and 0 or a
  // negative still clamps to 1 exactly as before. Only non-finite input is
  // refused, so no call that used to work changes behaviour.
  const quoted = await callTool("list_directory", { path: ".", depth: "3" });
  assert.equal(quoted.isError, false, `a quoted depth still coerces: ${quoted.text}`);
  assert.match(quoted.text, /leaf\.txt/);

  const zero = await callTool("list_directory", { path: ".", depth: 0 });
  assert.equal(zero.isError, false, "depth 0 still clamps to 1 rather than erroring");
});

// --- ⑥ a garbage restart knob never reaches a live process ----------------

test("`set_process_policy` refuses a garbage restart knob instead of writing NaN onto a live process", async () => {
  const commandId = await startEcho();

  // `Math.max(0, Number("abc"))` is NaN, not 0: it used to land on the running
  // command, where `restartCount < NaN` is always false (auto-restart quietly
  // disabled) and `setTimeout(NaN)` fires at ~0 ms (one crash becomes a loop).
  for (const [key, value] of [["max_restarts", "abc"], ["restart_delay_ms", "5s"], ["max_restarts", -1], ["restart_delay_ms", 2.5]]) {
    const res = await callTool("set_process_policy", { command_id: commandId, [key]: value });
    assert.equal(res.isError, true, `${key}=${String(value)} must be refused`);
    assert.match(res.text, new RegExp(`${key} must be a non-negative integer`), `${key} names itself`);
  }

  const snap = asObject(await callTool("get_process_snapshot", { command_id: commandId }));
  assert.equal(snap.max_restarts, 3, "a refused write did not half-apply: the default survived");
  assert.equal(snap.restart_delay_ms, 1000, "and so did the delay");
  assert.ok(Number.isFinite(snap.max_restarts) && Number.isFinite(snap.restart_delay_ms),
    "neither knob is NaN on the live process");

  const ok = asObject(await callTool("set_process_policy", { command_id: commandId, max_restarts: 7, restart_delay_ms: 250 }));
  assert.equal(ok.max_restarts, 7, "a valid knob still applies");
  assert.equal(ok.restart_delay_ms, 250, "and so does a valid delay");

  const quoted = asObject(await callTool("set_process_policy", { command_id: commandId, max_restarts: "9" }));
  assert.equal(quoted.max_restarts, 9, "a quoted integer still coerces, as it always did");

  await callTool("process_control", { action: "terminate", command_id: commandId });
});

test("`save_service` validates the same two knobs through the same validator, and persists the value it accepted", async () => {
  const command = 'node -e "setInterval(() => {}, 1000)"';

  for (const [key, value] of [["max_restarts", "abc"], ["restart_delay_ms", "5s"], ["max_restarts", -1]]) {
    const bad = await callTool("save_service", { name: "knob-check", command, [key]: value });
    assert.equal(bad.isError, true, `save_service must refuse ${key}=${String(value)}`);
    assert.match(bad.text, new RegExp(`${key} must be a non-negative integer`));
  }

  const defsAfterRefusal = asItems(await callTool("service_status", { detail: "definitions" }));
  assert.equal(defsAfterRefusal.some(s => s.name === "knob-check"), false,
    "a refused save persisted nothing");

  const good = await callTool("save_service", { name: "knob-check", command, max_restarts: 7, restart_delay_ms: 250 });
  assert.equal(good.isError, false, `a valid definition still saves: ${good.text}`);

  const defs = asItems(await callTool("service_status", { detail: "definitions" }));
  const saved = defs.find(s => s.name === "knob-check");
  assert.ok(saved, `the saved definition is listed: ${JSON.stringify(defs).slice(0, 300)}`);
  assert.equal(saved.max_restarts, 7, "it kept the validated value rather than re-coercing it");
  assert.equal(saved.restart_delay_ms, 250, "and the same for the delay");

  await callTool("service", { action: "delete", name: "knob-check" });
});

// --- harness ---------------------------------------------------------------

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
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "required-args", version: "1" } },
  }), jsonHeaders());
  const session = res.headers["mcp-session-id"];
  if (session) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": session }));
  }
  return { sessionId: session, body: res.body };
}

async function callToolPayload(name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 200, `tools/call ${name} answered`);
  const payload = lastSsePayload(res.body);
  assert.ok(payload?.result, `tools/call ${name} returned a result`);
  return payload;
}

/** One tool call, flattened to what these assertions care about. */
async function callTool(name, args) {
  const payload = await callToolPayload(name, args);
  const result = payload.result;
  const text = result.content?.[0]?.text ?? JSON.stringify(result);
  return { isError: result.isError === true, text };
}

/** The tool's payload as an array, whether it answered with one or with {items}. */
function asItems(res) {
  const parsed = asObject(res);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed.items) ? parsed.items : [];
}

/** The tool's own JSON payload, or `{}` when it answered with prose. */
function asObject({ text }) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
