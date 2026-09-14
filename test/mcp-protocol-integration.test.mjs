/**
 * MCP protocol integration test: boots the real `open-bridge serve` process and
 * checks the transport-level contracts a client depends on — session identity,
 * body limits, CORS, usage accounting and result shapes.
 *
 * Ported from the VS Code extension's `endpoint-integration.test.mjs` (29
 * checks), which the standalone app never carried over: its integration suite
 * covered the app-shell surface (console, settings, services, rotation) but not
 * the protocol guarantees the MCP endpoint makes to a client. Those are exactly
 * the guarantees an external evaluator probes — and the ones a regression would
 * silently break for every client at once.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {routeTokenFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let child;
let port;
let routeToken;
let serveExit = null;
let serveOutput = "";

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-protocol-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { serveOutput += d; });
  child.stderr.on("data", d => { serveOutput += d; });
  child.on("exit", (code, signal) => { serveExit = { code, signal }; });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(home, { recursive: true, force: true });
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

function lastSsePayload(body) {
  let payload;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) payload = JSON.parse(line.slice(6));
  }
  return payload;
}

let rpcId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });
const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

async function openSession() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "protocol-test", version: "1" },
  })), jsonHeaders());
  const sessionId = res.headers["mcp-session-id"];
  if (sessionId) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": sessionId }));
  }
  return { res, sessionId };
}

async function mcpCall(sessionId, method, params) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc(method, params)),
    jsonHeaders({ "mcp-session-id": sessionId }));
  return { status: res.status, payload: res.status === 200 ? lastSsePayload(res.body) : null, body: res.body };
}

async function callTool(sessionId, name, args) {
  const { status, payload } = await mcpCall(sessionId, "tools/call", { name, arguments: args });
  return { status, payload, text: payload?.result?.content?.[0]?.text ?? "" };
}

async function usage() {
  const res = await rawRequest("GET", "/api/usage", null, {});
  assert.equal(res.status, 200);
  return JSON.parse(res.body).usage;
}

test("a failed call records WHY it failed, not just how long it took", async () => {
  // The audit line is the only trace a failure leaves: the console's activity
  // pane, `activity_log` search and the audit file all read it. It used to say
  // "Failed in 1 ms." and nothing else — the reason was in hand on the very
  // next line, on its way back to the caller, and simply not written down.
  // Debugging from the log alone meant reproducing the call to learn anything.
  const { sessionId } = await openSession();
  const failed = await callTool(sessionId, "set_todos", { todos: "not a list" });
  assert.match(failed.text, /todos must be an array/, "the caller is told what is wrong");

  await delay(300);
  const audit = readFileSync(path.join(home, "audit.log"), "utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  const entry = audit.findLast(row => row.tool === "set_todos" && row.status === "error");
  assert.ok(entry, "the failure reached the audit log");
  assert.match(entry.message, /todos must be an array/,
    "and the log carries the same reason the caller got");
  // The duration is still there — it is just no longer the ONLY thing there.
  assert.match(entry.message, /^Failed in \d+ ms: /);
});

test("a rejected write says which field is wrong, and which tool reads", async () => {
  const { sessionId } = await openSession();

  // set_todos is write-only, so the commonest way to get an array error is
  // reaching for it to READ the list. Naming get_todos costs one clause.
  const notAList = await callTool(sessionId, "set_todos", { todos: "not a list" });
  assert.match(notAList.text, /use get_todos to read/, "the read tool is named, not just the bad parameter");

  // Naming the offending field beats listing all three and leaving the caller
  // to diff their payload against the list.
  const badStatus = await callTool(sessionId, "set_todos", {
    todos: [{ id: "1", title: "x", status: "doing" }],
  });
  assert.match(badStatus.text, /status must be pending, in_progress or completed/);
  assert.match(badStatus.text, /"doing"/, "the rejected value is quoted back");

  const noTitle = await callTool(sessionId, "set_todos", { todos: [{ id: "1", status: "pending" }] });
  assert.match(noTitle.text, /missing title/);
});

test("tools/list advertises the catalog and get_bridge_status agrees on the count", async () => {
  const { res, sessionId } = await openSession();
  assert.equal(res.status, 200);
  const listed = await mcpCall(sessionId, "tools/list", {});
  const tools = listed.payload?.result?.tools ?? [];
  assert.ok(tools.length >= 36, `expected the full catalog, got ${tools.length}`);
  assert.ok(tools.every(tool => tool.name && tool.inputSchema), "every tool carries a schema");
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length, "no duplicate tool names");

  const status = await callTool(sessionId, "get_bridge_status", {});
  const reported = JSON.parse(status.text).tool_count;
  assert.equal(reported, tools.length, "the status count must match what tools/list advertises");
});

test("outputSchema tools answer with structuredContent in the declared shape", async () => {
  const { sessionId } = await openSession();
  const services = await callTool(sessionId, "list_services", {});
  const structured = services.payload?.result?.structuredContent;
  assert.ok(structured && typeof structured === "object", "structuredContent is present");
  assert.ok(Array.isArray(structured.items), "list_services declares { items: [...] } and must answer it");

  const status = await callTool(sessionId, "get_bridge_status", {});
  const shape = status.payload?.result?.structuredContent;
  assert.equal(typeof shape?.state, "string", "get_bridge_status declares a state field");
  assert.equal(typeof shape?.tool_count, "number");
});

test("a forged session id is refused and the server keeps serving", async () => {
  const forged = await mcpCall("0000000000000000000000000000dead", "tools/call", { name: "get_bridge_status", arguments: {} });
  assert.ok(forged.status === 404 || forged.status === 400, `a forged session must be refused, got ${forged.status}`);
  assert.equal(serveExit, null, "the server survived a forged session");

  const { sessionId } = await openSession();
  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200, "and still serves real sessions");
});

test("a malformed JSON body is answered with a parse error and the server keeps serving", async () => {
  const { sessionId } = await openSession();
  const broken = await rawRequest("POST", `/mcp/${routeToken}`, '{"jsonrpc": "2.0", "id": 1, "method": ',
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(broken.status, 400, "a truncated body is the caller's error, not a session kill");
  assert.equal(JSON.parse(broken.body).error?.code, -32700, "the JSON-RPC parse error code is reported");

  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200, "the same session still works afterwards");
});

test("an oversized body is rejected before it is buffered", async () => {
  const { sessionId } = await openSession();
  const oversized = `{"pad":"${"x".repeat(8 * 1024 * 1024 + 1024)}"}`;
  const res = await rawRequest("POST", `/mcp/${routeToken}`, oversized, jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 400);
  assert.match(res.body, /exceeds/i, "the refusal names the size limit");
  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200);
});

test("CORS preflight is answered 204 and responses expose the session header", async () => {
  const preflight = await rawRequest("OPTIONS", `/mcp/${routeToken}`, null, {
    origin: "https://example.test",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, mcp-session-id",
  });
  assert.equal(preflight.status, 204, "browser-hosted MCP clients need a preflight answer");
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);

  const { res } = await openSession();
  assert.equal(res.headers["access-control-expose-headers"], "mcp-session-id");
});

test("usage counters stay consistent, and batch sub-calls are not double counted", async () => {
  const { sessionId } = await openSession();
  const baseline = await usage();

  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.payload?.result?.isError, undefined);

  const unknown = await callTool(sessionId, "definitely_no_such_tool", {});
  assert.equal(unknown.payload?.result?.isError, true, "an unknown tool is a tool-level error");

  const batched = await mcpCall(sessionId, "tools/call", {
    name: "batch",
    arguments: { calls: [
      { tool: "get_bridge_status", arguments: {} },
      { tool: "list_services", arguments: {} },
    ] },
  });
  assert.equal(batched.status, 200);

  const totals = await usage();
  assert.equal(totals.calls, totals.successes + totals.failures, "every call is exactly one outcome");
  assert.equal(totals.calls - baseline.calls, 3, "batch counts once, not once per sub-call");
  assert.equal(totals.by_tool.definitely_no_such_tool, undefined, "unknown tools stay out of by_tool");
});

test("a command that cannot run reports a real failure, never a phantom success", async () => {
  const { sessionId } = await openSession();
  const missingCwd = await callTool(sessionId, "run_command", {
    command: "echo should-not-run",
    cwd: path.join(home, "definitely", "missing", "directory"),
  });
  const result = missingCwd.payload?.result;
  const text = missingCwd.text;
  const failed = result?.isError === true
    || /ENOENT|no such file|not found|cannot find/i.test(text)
    || (JSON.parse(text || "{}").exit_code ?? 0) !== 0;
  assert.ok(failed, `a spawn that cannot start must not look like success: ${text.slice(0, 300)}`);

  const alive = await callTool(sessionId, "run_command", { command: "echo still-here" });
  assert.match(alive.text, /still-here/, "the server keeps serving after a failed spawn");
  assert.equal(serveExit, null, `serve died during the protocol suite:\n${serveOutput.slice(-600)}`);
});

test("the session table reports the handshake time and a cumulative call count", async () => {
  // The 会话 page's 「首次连接」 and 「调用数」 columns: both are per-session facts
  // only the server knows, so the wire shape is pinned here rather than in a probe.
  const { sessionId } = await openSession();
  assert.ok(sessionId, "the handshake assigned a session id");

  const rowFor = async () => {
    const res = await rawRequest("GET", "/api/sessions", null, {});
    assert.equal(res.status, 200);
    const row = JSON.parse(res.body).sessions.find(candidate => candidate.id === sessionId);
    assert.ok(row, "the session is listed");
    return row;
  };

  const fresh = await rowFor();
  assert.equal(fresh.calls, 0, "a session that has only handshaken has made no calls");
  assert.match(fresh.connected_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.ok(Date.parse(fresh.connected_at) <= Date.now(), "the handshake is in the past");
  assert.ok(fresh.idle_ms >= 0);

  await callTool(sessionId, "get_bridge_status", {});
  await callTool(sessionId, "list_services", {});
  const counted = await rowFor();
  assert.equal(counted.calls, 2, "each served call is counted once, on its own session");
  assert.equal(counted.connected_at, fresh.connected_at, "the handshake time does not move");

  const listed = JSON.parse((await callTool(sessionId, "list_sessions", {})).text);
  const row = listed.find(entry => entry.session_id === sessionId);
  assert.ok(row, "list_sessions knows this session");
  assert.equal(row.calls, 3, "the tool counts its own call too");
  assert.match(row.connected_at, /^\d{4}-\d\d-\d\dT/);
});

test("closing a session needs an unambiguous id; an ambiguous prefix closes nothing", async () => {
  // Session ids are random, so the collision is produced rather than assumed:
  // handshake until two ids share a first character, then ask the API to close
  // by that one character. The old route took the first startsWith hit in
  // insertion order — which may not be the session the operator meant.
  const ids = [];
  let pair = null;
  for (let attempt = 0; attempt < 40 && !pair; attempt += 1) {
    const { sessionId } = await openSession();
    if (!sessionId) continue;
    pair = ids.find(id => id[0] === sessionId[0]) ?? null;
    ids.push(sessionId);
    if (pair) pair = [pair, sessionId];
  }
  assert.ok(pair, `no two of ${ids.length} sessions shared a first character`);

  const close = async id => {
    const res = await rawRequest("POST", "/api/sessions/close", JSON.stringify({ id }),
      { "content-type": "application/json", "x-open-bridge-console": routeToken });
    return { status: res.status, body: res.body };
  };

  const ambiguous = await close(pair[0][0]);
  assert.equal(ambiguous.status, 400, ambiguous.body);
  assert.match(ambiguous.body, /前缀不唯一|prefix/);

  const listed = JSON.parse((await rawRequest("GET", "/api/sessions", null, {})).body).sessions.map(row => row.id);
  assert.ok(listed.includes(pair[0]) && listed.includes(pair[1]), "neither session was touched");

  const exact = await close(pair[0]);
  assert.equal(exact.status, 200, exact.body);
  assert.equal(JSON.parse(exact.body).closed, pair[0], "the exact id closes exactly the session asked for");
  const remaining = JSON.parse((await rawRequest("GET", "/api/sessions", null, {})).body).sessions.map(row => row.id);
  assert.equal(remaining.includes(pair[0]), false, "the intended session is gone");
  assert.ok(remaining.includes(pair[1]), "the other one is still connected");
});
