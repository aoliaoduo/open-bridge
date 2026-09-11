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
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
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
let serveExit = null;
let serveOutput = "";

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

function routeTokenFromSecrets(root) {
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const secrets = JSON.parse(readFileSync(path.join(home, "secrets.json"), "utf8"));
  return secrets[`openBridge.routeToken.${suffix}`];
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-protocol-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { serveOutput += d; });
  child.stderr.on("data", d => { serveOutput += d; });
  child.on("exit", (code, signal) => { serveExit = { code, signal }; });
  const runtime = await waitForRuntime();
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFromSecrets(home); } catch { await delay(250); }
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

test("tools/list advertises the catalog and get_bridge_status agrees on the count", async () => {
  const { res, sessionId } = await openSession();
  assert.equal(res.status, 200);
  const listed = await mcpCall(sessionId, "tools/list", {});
  const tools = listed.payload?.result?.tools ?? [];
  assert.ok(tools.length >= 40, `expected the full catalog, got ${tools.length}`);
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
  const before = await usage();

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

  const after = await usage();
  assert.equal(after.calls, after.successes + after.failures, "every call is exactly one outcome");
  assert.equal(after.calls - before.calls, 3, "batch counts once, not once per sub-call");
  assert.equal(after.by_tool.definitely_no_such_tool, undefined, "unknown tools stay out of by_tool");
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
