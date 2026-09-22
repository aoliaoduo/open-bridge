/**
 * Instance-record helpers shared by the integration suites.
 *
 * Runtime records are per workspace root (`runtime-<suffix>.json`), because the
 * app supports one Bridge per directory sharing a single data dir. A suite also
 * has to keep working against the pre-multi-instance layout, so the legacy
 * single `runtime.json` is consulted for its own root only — the same rule the
 * CLI applies.
 *
 * The rest of this module is the HTTP/process harness the integration suites
 * used to copy into every file: the repo root, the raw-request plumbing, the
 * legacy MCP handshake and tools/call helpers, and the spawn/teardown pair.
 * Everything here is parameterized on the differences the suites actually
 * have (request timeout, extra spawn flags/cwd/env, header extras); anything
 * more exotic stays in the suite that needs it.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const suffixFor = root => createHash("sha256").update(root).digest("hex").slice(0, 24);

export const runtimeFileFor = (home, root) => path.join(home, `runtime-${suffixFor(root)}.json`);

/** The record for one root: its own file first, then a legacy file naming it. */
export function readRuntimeFor(home, root) {
  for (const file of [runtimeFileFor(home, root), path.join(home, "runtime.json")]) {
    try {
      const info = JSON.parse(readFileSync(file, "utf8"));
      if (typeof info.port === "number" && info.root && path.resolve(info.root) === path.resolve(root)) return info;
    } catch { /* absent, half-written, or another root's record */ }
  }
  return undefined;
}

/** Waits for a root's listener to be published, then reports its record. */
export async function waitForRuntime(home, root, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = readRuntimeFor(home, root);
    if (info && info.port > 0) return info;
    await delay(250);
  }
  throw new Error(`no runtime record for ${root} in ${home} — serve failed to start`);
}

export function routeTokenFor(home, root) {
  const secrets = JSON.parse(readFileSync(path.join(home, "secrets.json"), "utf8"));
  return secrets[`openBridge.routeToken.${suffixFor(root)}`];
}

// ---------------------------------------------------------------- suite harness

/** Repo root — one level above test/, where this module lives in lib/. */
export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** The CLI entry the suites spawn. */
export const CLI_BIN = path.join(ROOT, "bin", "open-bridge.js");

/** Headers for a JSON-RPC POST against /mcp: JSON body, SSE-capable accept. */
export const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

/**
 * One suite's JSON-RPC id counter: the first call yields 1, exactly like the
 * copied `let rpcId = 1; … id: rpcId++` did.
 */
export const createRpcId = (first = 1) => {
  let next = first;
  return () => next++;
};

export function lastSsePayload(body) {
  let payload;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) payload = JSON.parse(line.slice(6));
  }
  return payload;
}

/**
 * The suites' raw HTTP helper, bound to an instance. `port` is a getter read
 * per request (a restart may move the listener), and `timeoutMs` is each
 * suite's own budget — 8 s, 15 s and 20 s across the files, kept as-is.
 */
export const makeRawRequest = (port, timeoutMs = 15_000) =>
  (method, reqPath, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: port(), method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(timeoutMs) },
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

/**
 * Polls for the route token the way every before() did: up to 40 reads,
 * backing off 250 ms only while the secrets file cannot be read yet.
 */
export async function waitForRouteToken(home, root) {
  let token;
  for (let i = 0; i < 40 && !token; i += 1) {
    try { token = routeTokenFor(home, root); } catch { await delay(250); }
  }
  return token;
}

/**
 * `open-bridge serve` with the suite-standard flags: an ephemeral port, no
 * tunnel unless asked, and the piped stdio every suite uses. `cwd`/`env` are
 * only set when given (the tunnel fixtures pass both).
 */
export function spawnServe({ root, home, port = "0", tunnel = false, cwd, env, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  return spawn(process.execPath, [
    CLI_BIN,
    "serve",
    ...(tunnel ? [] : ["--no-tunnel"]),
    "--port", port,
    "--root", root,
    "--home", home,
  ], {
    stdio,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  });
}

/**
 * One suite instance: spawn serve, wait for the runtime record and the route
 * token, and fail the way the copied code did if the token never lands.
 * Returns { child, port, routeToken }; teardown stays in the suite's after()
 * via stopServe() + removeTempDir().
 */
export async function startBridge({ root, home, ...spawnOptions } = {}) {
  const child = spawnServe({ root, home, ...spawnOptions });
  const runtime = await waitForRuntime(home, root);
  const routeToken = await waitForRouteToken(home, root);
  assert.ok(routeToken, "route token was persisted");
  return { child, port: runtime.port, routeToken };
}

/** The standard teardown: SIGTERM while alive, then the settle delay. */
export async function stopServe(child) {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
}

/**
 * Binds the legacy MCP handshake to one suite: initialize with the 2025-06-18
 * protocol, then the initialized notification when a session id was minted.
 * `routeToken` is a getter (a rotation may replace it mid-suite), `nextId` the
 * suite's JSON-RPC counter. Returns async (extraHeaders) => { res, sessionId, body }.
 */
export function makeOpenSession({ request, routeToken, clientName, nextId }) {
  return async function openSession(extraHeaders = {}) {
    const res = await request("POST", `/mcp/${routeToken()}`, JSON.stringify({
      jsonrpc: "2.0", id: nextId(), method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } },
    }), jsonHeaders(extraHeaders));
    const sessionId = res.headers["mcp-session-id"];
    if (sessionId) {
      await request("POST", `/mcp/${routeToken()}`,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        jsonHeaders({ "mcp-session-id": sessionId, ...extraHeaders }));
    }
    return { res, sessionId, body: res.body };
  };
}

/**
 * Binds the legacy tools/call helpers to one suite: callToolPayload asserts
 * the transport answered and a result came back, and callTool flattens the
 * payload to what those assertions read — the tool's own first text block
 * rather than the serialized envelope, so the error arrives the way a client
 * sees it (no escaped quotes in the way).
 */
export function makeToolCaller({ request, routeToken, nextId, getSessionId }) {
  const callToolPayload = async (name, args) => {
    const res = await request("POST", `/mcp/${routeToken()}`,
      JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name, arguments: args } }),
      jsonHeaders({ "mcp-session-id": getSessionId() }));
    assert.equal(res.status, 200, `tools/call ${name} answered`);
    const payload = lastSsePayload(res.body);
    assert.ok(payload?.result, `tools/call ${name} returned a result`);
    return payload;
  };

  const callTool = async (name, args) => {
    const payload = await callToolPayload(name, args);
    const result = payload.result;
    const text = result.content?.[0]?.text ?? JSON.stringify(result);
    return { isError: result.isError === true, text };
  };

  return { callToolPayload, callTool };
}
