/**
 * The refusal a legacy client gets when it arrives without a usable session.
 *
 * Why this deserves its own suite: this is the exact wall an agent hits when an
 * old client meets a restarted (or idle-reaped) Bridge, and the transport's own
 * answer — `400 -32000 "Bad Request: Server not initialized"` — reads as "the
 * server is broken" for both the "you never handshook" and the "your session is
 * gone" cases. Both are one extra `initialize` away from working, so the
 * distinction is the whole value: the two answers must be different on the wire,
 * and neither may cost the caller a guess.
 *
 * The modern era must be untouched by any of this: it has no sessions at all,
 * and its requests are answered by the other handler.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {mkdtempSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {
  createRpcId, jsonHeaders, makeRawRequest, startBridge, stopServe,
} from "./lib/bridge-runtime.mjs";

const MODERN_REVISION = "2026-07-28";

let home;
let child;
let port;
let routeToken;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-legacy-session-"));
  ({ child, port, routeToken } = await startBridge({ root: home, home }));
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
});

const rawRequest = makeRawRequest(() => port, 15_000);
const rpcId = createRpcId();
const call = sessionId => rawRequest(
  "POST",
  `/mcp/${routeToken}`,
  JSON.stringify({ jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name: "bridge_status", arguments: {} } }),
  jsonHeaders(sessionId ? { "mcp-session-id": sessionId } : {}),
);

/** Error responses are plain JSON in both eras; success may be one SSE frame. */
function decode(body) {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  return JSON.parse(body);
}

test("no session id: the caller is told to handshake, not that the server is broken", async () => {
  const res = await call(undefined);
  assert.equal(res.status, 400, res.body);
  const payload = decode(res.body);
  assert.equal(payload.error.code, -32000, "the code this case has always carried");
  assert.equal(payload.error.data?.reason, "initialize-required");
  assert.match(payload.error.message, /initialize/);
  assert.match(payload.error.data.hint, /mcp-session-id/,
    "the hint names the header the next request must carry");
});

test("an unknown session id is answered as expired, and sounds like it", async () => {
  const res = await call("0000000000000000000000000000dead");
  assert.equal(res.status, 404, "the specification's status for a session id nobody knows");
  const payload = decode(res.body);
  assert.equal(payload.error.code, -32001);
  assert.equal(payload.error.data?.reason, "session-expired");
  assert.match(payload.error.data.hint, /initialize/,
    "the way out is the same handshake, said out loud");
});

test("the handshake itself is untouched: the id it mints still serves calls", async () => {
  const init = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId(),
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-guidance-test", version: "1" } },
  }), jsonHeaders());
  assert.equal(init.status, 200);
  const sessionId = init.headers["mcp-session-id"];
  assert.ok(sessionId, "the legacy handshake still mints a session id");

  await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    jsonHeaders({ "mcp-session-id": sessionId }));

  const served = await call(sessionId);
  assert.equal(served.status, 200, "a real session is served normally");
});

test("a handshake that carries a dead id still succeeds, so reconnecting needs no special case", async () => {
  // The tolerance is deliberate (see session-guidance): a client that reconnects
  // after a restart sends its old id with `initialize`, and the useful answer is
  // a fresh session rather than a refusal.
  const init = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId(),
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "session-guidance-test", version: "1" } },
  }), jsonHeaders({ "mcp-session-id": "1".repeat(32) }));
  assert.equal(init.status, 200);
  assert.ok(init.headers["mcp-session-id"], "and it hands back a usable session id");
});

test("the modern era is not intercepted by any of this", async () => {
  const res = await rawRequest(
    "POST",
    `/mcp/${routeToken}`,
    JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId(),
      method: "tools/call",
      params: {
        name: "bridge_status",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    jsonHeaders({
      "mcp-protocol-version": MODERN_REVISION,
      "mcp-method": "tools/call",
      "mcp-name": "bridge_status",
    }),
  );
  assert.equal(res.status, 200, "a stateless request needs no session and gets none of the guidance");
  assert.equal(res.headers["mcp-session-id"], undefined, "and it still mints nothing");
});
