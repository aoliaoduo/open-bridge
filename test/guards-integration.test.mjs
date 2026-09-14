/**
 * Guards integration test: boots the real `open-bridge serve` process and drives
 * the optional bearer-token gate, the operator credential surface and the
 * concurrency view over real HTTP — no VS Code, no stubs.
 *
 * Ported from the VS Code extension's guards suite (`test/guards-integration
 * .test.mjs`, 18 checks). The standalone app never carried this coverage over,
 * so the one thing standing between a public URL and this machine had only unit
 * tests here while the extension proved every state transition end to end. Auth
 * is switched on for part of the run, hence its own file: the other integration
 * suites all assume the gate is off.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
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
  home = mkdtempSync(path.join(tmpdir(), "ob-guards-"));
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
  const stillListening = await new Promise(resolve => {
    const probe = http.request({ host: "127.0.0.1", port, path: "/healthz/", timeout: 300 }, () => resolve(false));
    probe.on("error", () => resolve(false));
    probe.on("timeout", () => { probe.destroy(); resolve(false); });
    probe.end();
  }).catch(() => false);
  assert.equal(stillListening, false, "serve must be gone after the suite");
  removeTempDir(home);
});

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
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });
const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });
const bearer = secret => ({ authorization: `Bearer ${secret}` });

/** Full MCP handshake; returns the response plus the assigned session id. */
async function openSession(extraHeaders = {}) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "guards-test", version: "1" },
  })), jsonHeaders(extraHeaders));
  const sessionId = res.headers["mcp-session-id"];
  if (sessionId) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": sessionId, ...extraHeaders }));
  }
  return { res, sessionId };
}

async function callTool(sessionId, name, args, extraHeaders = {}) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify(rpc("tools/call", { name, arguments: args })),
    jsonHeaders({ "mcp-session-id": sessionId, ...extraHeaders }));
  const payload = res.status === 200 ? lastSsePayload(res.body) : null;
  const text = payload?.result?.content?.[0]?.text ?? "";
  return { status: res.status, payload, text };
}

/** One console action, the way the console page issues it. */
async function action(payload) {
  const res = await rawRequest("POST", "/api/settings/action", JSON.stringify(payload),
    { "content-type": "application/json", "x-open-bridge-console": routeToken });
  return { status: res.status, body: JSON.parse(res.body) };
}

let issued;
let second;

test("auth stays off by default: /mcp answers with no credentials", async () => {
  const { res } = await openSession();
  assert.equal(res.status, 200, "an unauthenticated initialize must succeed while the gate is off");
  assert.equal(lastSsePayload(res.body)?.result?.serverInfo?.name, "open-bridge");
});

test("enabling auth with no token is refused (self-lockout guard)", async () => {
  const on = await action({ command: "setAuthEnabled", enabled: true });
  assert.equal(on.status, 400, "the gate must not be switched on while no token exists");
  assert.equal(on.body.ok, false);
  assert.match(String(on.body.error), /令牌/, "the refusal explains what to do first");
  const { res } = await openSession();
  assert.equal(res.status, 200, "the gate is still off — nobody was locked out");
});

test("a minted token turns the gate on and blocks anonymous calls", async () => {
  const minted = await action({ command: "createToken", label: "guards", ttlSeconds: 0 });
  assert.equal(minted.status, 200);
  issued = minted.body.secret;
  assert.ok(issued?.secret && issued.secret.length >= 20, "a secret is returned exactly once");
  assert.equal(issued.kind, "minted");
  assert.equal(minted.body.copyText, issued.secret, "the console copies the secret it was handed");

  const on = await action({ command: "setAuthEnabled", enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.ok, true);

  const anonymous = await openSession();
  assert.equal(anonymous.res.status, 401, "no credential -> 401");
  assert.match(String(anonymous.res.headers["www-authenticate"]), /Bearer/);
  assert.equal(anonymous.sessionId, undefined, "no session may be minted for an anonymous caller");
});

test("the wrong secret is rejected and the right one is accepted", async () => {
  const wrong = await openSession({ authorization: "Bearer ob_definitely-not-the-token" });
  assert.equal(wrong.res.status, 401);

  const right = await openSession(bearer(issued.secret));
  assert.equal(right.res.status, 200);
  assert.ok(right.sessionId, "an authenticated session id is issued");
});

test("the ?token= query parameter works for clients that cannot set headers", async () => {
  const res = await rawRequest("POST", `/mcp/${routeToken}?token=${encodeURIComponent(issued.secret)}`,
    JSON.stringify(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "q", version: "1" } })),
    jsonHeaders());
  assert.equal(res.status, 200);
});

test("the tunnel readiness probe stays reachable without a token", async () => {
  const res = await rawRequest("GET", `/healthz/${routeToken}`, null, {});
  assert.equal(res.status, 200, "healthz must not require auth or the tunnel probe could never pass");
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test("repeated failures from one client are rate limited with Retry-After", async () => {
  const attacker = { "x-forwarded-for": "203.0.113.99" };
  let lockout = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await openSession({ ...attacker, authorization: "Bearer ob_wrong-again" });
    if (res.res.status === 429) { lockout = res.res; break; }
    assert.equal(res.res.status, 401, `attempt ${attempt} should be a plain rejection`);
  }
  assert.ok(lockout, "the limiter must eventually lock the client out");
  assert.match(String(lockout.headers["retry-after"]), /^\d+$/);
});

test("the lockout is per client, so it cannot lock the operator out", async () => {
  const operator = await openSession({ ...bearer(issued.secret), "x-forwarded-for": "198.51.100.5" });
  assert.equal(operator.res.status, 200, "a different client identity is unaffected by another's lockout");
});

test("get_auth_status reports the token id and never the secret; get_lock_status stays readable", async () => {
  const { res, sessionId } = await openSession(bearer(issued.secret));
  assert.equal(res.status, 200);

  const auth = await callTool(sessionId, "get_auth_status", {}, bearer(issued.secret));
  assert.equal(auth.payload?.result?.isError, undefined, "an authorized read must not be an error");
  assert.match(auth.text, new RegExp(issued.id), "the token id is reported");
  assert.equal(auth.text.includes(issued.secret), false, "the secret must never be readable");
  const parsed = JSON.parse(auth.text);
  assert.equal(parsed.enabled, true);
  assert.ok(Array.isArray(parsed.tokens) && parsed.tokens.length === 1);

  const locks = await callTool(sessionId, "get_lock_status", {}, bearer(issued.secret));
  assert.equal(locks.status, 200);
  const lockTable = JSON.parse(locks.text);
  assert.equal(lockTable.enabled, true, "concurrency admission is on by default");
  assert.deepEqual(lockTable.held, []);
  assert.deepEqual(lockTable.waiting, []);
});

test("get_config exposes the guard settings", async () => {
  const { sessionId } = await openSession(bearer(issued.secret));
  const config = await callTool(sessionId, "get_config", {}, bearer(issued.secret));
  const parsed = JSON.parse(config.text);
  assert.equal(parsed["auth.enabled"], true);
  assert.equal(parsed["auth.tokenTtlSeconds"], 0, "the configured default lifetime is readable");
});

test("purging drops revoked rows and leaves the live one alone", async () => {
  const minted = await action({ command: "createToken", label: "doomed", ttlSeconds: 3600 });
  second = minted.body.secret;
  assert.ok(second?.id);
  const revoked = await action({ command: "revokeToken", id: second.id });
  assert.equal(revoked.body.ok, true);

  const purged = await action({ command: "purgeTokens" });
  assert.equal(purged.body.ok, true);
  const rows = purged.body.state.tokens.map(row => row.id);
  assert.equal(rows.includes(second.id), false, "the revoked row is gone");
  assert.equal(rows.includes(issued.id), true, "the live token survives a purge");
});

test("delete refuses an unknown id instead of guessing", async () => {
  const gone = await action({ command: "deleteToken", id: "not-a-real-id" });
  assert.equal(gone.body.ok, false);
  assert.ok(String(gone.body.error ?? "").length > 0, "the refusal carries a reason");
});

test("revoking every token re-closes the gate", async () => {
  const revoked = await action({ command: "revokeAll" });
  assert.equal(revoked.body.ok, true);
  const anonymous = await openSession();
  assert.equal(anonymous.res.status, 401, "with no usable token the gate fails closed");
});

test("minting a replacement restores access", async () => {
  const minted = await action({ command: "createToken", label: "replacement", ttlSeconds: 0 });
  const fresh = minted.body.secret;
  const { res, sessionId } = await openSession(bearer(fresh.secret));
  assert.equal(res.status, 200);
  const status = await callTool(sessionId, "get_auth_status", {}, bearer(fresh.secret));
  assert.match(status.text, new RegExp(fresh.id));
  assert.equal(serveExit, null, `serve died during the guards suite:\n${serveOutput.slice(-600)}`);
});

const CLI_BIN = path.join(ROOT, "bin", "open-bridge.js");

/** One CLI invocation against the same data dir the running instance uses. */
function cliToken(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_BIN, "token", ...args, "--home", home], {
      cwd: ROOT,
      env: { ...process.env, OPEN_BRIDGE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { out += d; });
    proc.on("error", reject);
    proc.on("close", code => resolve({ code, out }));
  });
}

/**
 * Cross-process credential visibility (ported from the throwaway
 * `scripts/auth-cache-check.mjs` probe). The store used to be read into a
 * module-level snapshot, so while the gate was on a token minted by the CLI was
 * a 401 until the instance restarted, and a token revoked by the CLI kept
 * working just as long. Every read now hits the file, and every write merges
 * under the shared lock.
 */
test("a token minted or revoked by another process (the CLI) is honoured at once", async () => {
  const anon = await openSession();
  assert.equal(anon.res.status, 401, "the gate must be on for this test to mean anything");

  const created = await cliToken(["create", "--label", "cross-process"]);
  assert.equal(created.code, 0, created.out);
  const secret = /ob_[A-Za-z0-9_-]{20,}/.exec(created.out)?.[0];
  assert.ok(secret, `the CLI printed no secret:\n${created.out}`);

  const foreign = await openSession(bearer(secret));
  assert.equal(foreign.res.status, 200, "a CLI-minted token must work without restarting the instance");

  const listed = await cliToken(["list"]);
  const id = new RegExp("^\\s+([0-9a-f]{8})\\s+cross-process\\b", "m").exec(listed.out)?.[1];
  assert.ok(id, `the CLI list did not show the new token:\n${listed.out}`);
  const revoked = await cliToken(["revoke", id]);
  assert.equal(revoked.code, 0, revoked.out);

  const reopened = await openSession(bearer(secret));
  assert.equal(reopened.res.status, 401, "a CLI-revoked token must stop working at once");

  assert.equal(serveExit, null, `serve died during the cross-process test:\n${serveOutput.slice(-600)}`);
});
