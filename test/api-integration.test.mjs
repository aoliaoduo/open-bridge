/**
 * API integration test: boots a real `open-bridge serve` process on an
 * ephemeral port, exercises the loopback/mutation gates and the console,
 * then stops it through the shutdown endpoint. Runs against the BUILT dist
 * (npm run build:core first) — same pattern as the extension repo's
 * endpoint-integration test ran against the built extension.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {readRuntimeFor, routeTokenFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let child;
let port;
let routeToken;
/** Set when the serve process exits, so a test that talks to a dead instance
 * says so instead of reporting a bare ECONNREFUSED. */
let serveExit = null;
let serveOutput = "";

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-api-test-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { serveOutput += d; });
  child.stderr.on("data", d => { serveOutput += d; });
  child.on("exit", (code, signal) => {
    serveExit = { code, signal };
    if (!port) throw new Error(`serve exited early (${code}):\n${serveOutput}`);
  });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  // The route token is written during start(); give it a moment if absent.
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

const base = () => `http://127.0.0.1:${port}`;

/** fetch() drops a custom Host header (forbidden header); http.request sends it. */
function requestWithHost(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, headers: { Host: hostHeader } },
      res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("healthz answers on the route token path", async () => {
  const res = await fetch(`${base()}/healthz/${routeToken}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("api status is loopback-readable without a token", async () => {
  // No header on purpose: reads are loopback-gated only. This name used to lie —
  // the request carried the console token, so a regression that made reads
  // token-gated (breaking `open-bridge status`/`url`) went unnoticed.
  const res = await fetch(`${base()}/api/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status.state, "running");
  assert.ok(body.status.tool_count >= 40);
});

test("console page loads without a token (it is where the token is delivered)", async () => {
  // Regression: /console/ demanded the console token, but the token is injected
  // into this very page — a deadlock that made the web console unopenable.
  const res = await fetch(`${base()}/console/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("open-bridge-console-token"), "token meta is injected into the console html");
  assert.ok(!html.includes("window.__OPEN_BRIDGE_TOKEN__"), "token is not exposed as an inline script");
});

test("non-loopback Host is refused at the bridge layer", async () => {
  const status = await requestWithHost("/api/status", `evil.example.com:${port}`);
  assert.equal(status, 403);
});

test("mutations require the console token header", async () => {
  const missing = await fetch(`${base()}/api/bridge/rotate`, { method: "POST" });
  assert.equal(missing.status, 403);
  const wrong = await fetch(`${base()}/api/bridge/rotate`, {
    method: "POST",
    headers: { "x-open-bridge-console": "deadbeef" },
  });
  assert.equal(wrong.status, 403);
});

test("settings action with the console token works", async () => {
  const res = await fetch(`${base()}/api/settings/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-open-bridge-console": routeToken,
    },
    body: JSON.stringify({ command: "createToken", label: "integration", ttlSeconds: 0 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.secret.secret.startsWith("ob_"), "minted secret is returned once");
  assert.equal(body.state.usableCount, 1);
});

test("the panel endpoints answer for the console pages", async () => {
  // 会话 / 工具 / 体检 read these three routes. The shapes asserted here are the
  // ones ui/src/api.ts parses, so a rename on the server shows up as a failure
  // instead of a blank page.
  const sessions = await fetch(`${base()}/api/sessions`);
  assert.equal(sessions.status, 200);
  const sessionBody = await sessions.json();
  assert.ok(Array.isArray(sessionBody.sessions), "sessions is a list");
  assert.deepEqual(Object.keys(sessionBody.locks).sort(), ["held", "waiting"]);

  const tools = await fetch(`${base()}/api/tools`);
  assert.equal(tools.status, 200);
  const toolBody = await tools.json();
  assert.equal(toolBody.tools.length, toolBody.count, "count matches the catalog it returns");
  assert.ok(toolBody.count >= 40, `catalog has ${toolBody.count} tools`);
  assert.ok(toolBody.tools.some(tool => tool.name === "read_files" && tool.core === true), "core tools are flagged");
  assert.ok(!toolBody.tools.some(tool => tool.name === "get_diagnostics"), "editor-only tools stay hidden");

  const health = await fetch(`${base()}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.health.exposure, "local", "no tunnel in this suite");
  const names = healthBody.health.checks.map(check => check.name);
  for (const name of ["instance", "workspace", "tools", "tunnel", "exposure"]) {
    assert.ok(names.includes(name), `health reports ${name}`);
  }
  // The public leg is only probed when there is a published URL: with no tunnel
  // it must be skipped rather than reported as a failure.
  assert.ok(!names.includes("public"), "no public check without a tunnel");
});

test("closing an unknown session reports 404 instead of silently succeeding", async () => {
  const res = await fetch(`${base()}/api/sessions/close`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify({ id: "deadbeef" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("console page is served with the token injected; ngrok Host is refused", async () => {
  const res = await fetch(`${base()}/console/`, { headers: { "x-open-bridge-console": routeToken } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("open-bridge-console-token"), "token meta injected into console html");
  assert.ok(!html.includes("window.__OPEN_BRIDGE_TOKEN__"), "token is not exposed as inline script");
  const refusedStatus = await requestWithHost("/console/", "x.ngrok-free.dev");
  assert.equal(refusedStatus, 403);
});

test("cli status/url reach the running instance and exit cleanly", async () => {
  const runCli = (args) => new Promise(resolve => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, "bin", "open-bridge.js"), ...args, "--home", home],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("exit", code => resolve({ code, out, err }));
  });

  // A non-zero exit here also catches the Windows libuv assertion that used to
  // fire when process.exit() raced undici's closing keep-alive sockets.
  const status = await runCli(["status"]);
  assert.equal(status.code, 0, `status exited ${status.code}: ${status.err}`);
  assert.match(status.out, /状态: running/);
  assert.ok(!/Assertion failed/.test(status.err), `no libuv assertion: ${status.err}`);

  const url = await runCli(["url"]);
  assert.equal(url.code, 0, `url exited ${url.code}: ${url.err}`);
  assert.match(url.out.trim(), /\/mcp\//);
});

/**
 * A request that fails to reach the instance reports why it is gone — the
 * process state, the runtime file it published, and the tail of its own log.
 * Without this a listener that dies mid-suite surfaces as a bare ECONNREFUSED,
 * which says nothing about the cause (that happened on CI).
 */
async function probePort(target) {
  // Is anything still accepting on that port? A refused connect right after a
  // test that was answered a moment ago is the whole question.
  const net = await import("node:net");
  return await new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port: target });
    const done = verdict => { try { sock.destroy(); } catch {} resolve(verdict); };
    sock.setTimeout(1000);
    sock.once("connect", () => done("accepts"));
    sock.once("timeout", () => done("timeout"));
    sock.once("error", e => done(`error:${e.code}`));
  });
}

function enrich(error, portState) {
  const details = {
    cause: error?.cause?.code ?? error?.message,
    port,
    serve: serveExit,
    portState,
    serveOutput: serveOutput.slice(-400),
  };
  let log = "";
  try {
    log = readFileSync(path.join(home, "logs", "bridge.log"), "utf8")
      .split(/\r?\n/).filter(Boolean).slice(-8)
      .map(l => l.replace(/\[20[^\]]*\] /, "")).join(" | ");
  } catch { /* no log yet */ }
  let runtime = "";
  try { runtime = JSON.stringify(readRuntimeFor(home, home) ?? null); } catch {}
  return new Error(`${JSON.stringify(details)} runtime.json=${runtime} log=${log}`);
}

/** POST a console action the way the console does. */
async function postAction(body, token = routeToken) {
  try {
    return await fetch(`${base()}/api/settings/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-open-bridge-console": token },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw enrich(error, await probePort(port));
  }
}

test("an idle pooled connection survives past Node's 5 s keep-alive default", async () => {
  // Regression, and the reason a rotation intermittently failed on CI's Windows
  // runner while passing locally: the server inherited Node's 5 s
  // keepAliveTimeout and DESTROYED idle connections on that timer, while the
  // pool that owned the connection considered it reusable (undici keys its
  // keep-alive timer off the `Keep-Alive: timeout=` header, with slack). Reusing
  // that socket raised ECONNRESET on write — measured here as a hard failure
  // with the default timeout and as a clean 200 with the 60 s one.
  const agent = new http.Agent({ keepAlive: true });
  const send = () => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/status", agent }, res => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, keepAlive: res.headers["keep-alive"] }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const first = await send();
    assert.equal(first.status, 200);
    const advertised = Number(/(?:^|;\s*)timeout=(\d+)/.exec(first.keepAlive ?? "")?.[1] ?? "0");
    assert.ok(advertised > 10, `the server advertises a long keep-alive window, got "${first.keepAlive}"`);
    await delay(6_000);
    const reused = await send();
    assert.equal(reused.status, 200, "an idle connection must survive past the 5 s default");
  } finally {
    agent.destroy();
  }
});

test("rotation swaps the token without interrupting the listener", async () => {
  // Regression: a rotation used to flip the token, rebind the listener and
  // reply in between. On a loaded Windows runner the caller's next connect then
  // landed in the gap where nothing was listening (ECONNREFUSED on CI) or its
  // reply was destroyed in flight (ECONNRESET locally) — for a rotation that had
  // in fact succeeded, leaving the console holding a dead token. The listener
  // never needed to move: every route compares state.routeToken per request.
  assert.equal(serveExit, null, `serve died before the rotation (${JSON.stringify(serveExit)}); last output: ${serveOutput.slice(-600)}`);
  const res = await postAction({ command: "rotateEndpoint" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.reloadRequired, true, "the console is told its token went stale");
  const rotated = body.state.mcpUrl.split("/mcp/")[1];
  assert.ok(rotated && rotated !== routeToken, "the response carries the new endpoint");

  // No rebind and no waiting: the very next request goes to the same listener
  // on the same port, where the old token is already dead.
  assert.equal((await postAction({ command: "ready" }, routeToken)).status, 403, "old token is dead");
  routeToken = rotated;
  assert.equal((await postAction({ command: "ready" })).status, 200, "new token works");
  assert.equal(serveExit, null, "the listener survived the rotation, as it must");

  // Deterministic proof that the listener was never restarted — no timing
  // dependence: the whole run logs exactly one start. The old flow tore the
  // listening socket down here (and started it again), which is what put a dead
  // gap between the reply and the caller's next request.
  await delay(500);
  const log = readFileSync(path.join(home, "logs", "bridge.log"), "utf8");
  assert.equal(
    (log.match(/Started:/g) ?? []).length,
    1,
    `the rotation restarted the listener:\n${log}`,
  );
});

test("the onboarding prompt admits when its URL is local-only", async () => {
  // Regression: the console card said "仅本机可访问" while the copied prompt
  // handed over a 127.0.0.1 URL with no caveat — and the prompt is the one thing
  // whose entire purpose is to be pasted into a client that is often NOT this
  // machine. This suite runs with --no-tunnel, so the honest answer here is the
  // loopback one. (The public variant is covered by test/onboarding.test.ts.)
  const served = await (await fetch(`${base()}/api/prompt`)).json();
  assert.match(served.prompt, /127\.0\.0\.1/);
  assert.match(served.prompt, /未开启隧道/);
  assert.match(served.prompt, /只有本机能访问/);

  const res = await postAction({ command: "copyPrompt" });
  assert.equal(res.status, 200);
  const action = await res.json();
  assert.match(action.copyText, /未开启隧道/, "the copied text carries the caveat");
  assert.match(action.info, /只有本机能访问/, "the toast agrees with the text");
});

test("services are listed and driven through the console API", async () => {
  // The console had no service surface at all: a service the agent saved could
  // only be controlled by asking the agent again.
  const list = await fetch(`${base()}/api/services`);
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.services, [], "a fresh data dir has no saved services");

  const svc = payload => fetch(`${base()}/api/services/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify(payload),
  });

  // Mutations keep the console-token gate; reads stay loopback-only.
  assert.equal((await fetch(`${base()}/api/services/action`, { method: "POST" })).status, 403);

  const badAction = await svc({ action: "explode", name: "x" });
  assert.equal(badAction.status, 400);
  const noName = await svc({ action: "start" });
  assert.equal(noName.status, 400);
  const unknown = await svc({ action: "start", name: "nope" });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /Unknown service/);
});

test("the counters can be cleared and the instance can be health-checked", async () => {
  // Both implementations existed (usage-store.resetUsageStats, lifecycle.runHealthCheck)
  // with no way to reach them from the product.
  const cleared = await postAction({ command: "clearStats" });
  assert.equal(cleared.status, 200);
  const clearedBody = await cleared.json();
  assert.equal(clearedBody.ok, true);
  assert.match(clearedBody.info, /清零/);

  const health = await postAction({ command: "healthCheck" });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.match(healthBody.info, /健康检查/);
  assert.equal(healthBody.healthOk, true, "a healthy instance reports ok");
  assert.ok(Array.isArray(healthBody.healthLines) && healthBody.healthLines.length >= 2);
  const lines = healthBody.healthLines.join(" | ");
  assert.match(lines, /本地端点 正常/);
  assert.match(lines, /公网隧道 未开启/);
  assert.match(lines, /Bearer 鉴权 未启用/);
});

test("shutdown endpoint stops the process", async () => {
  assert.equal(serveExit, null, `serve died before shutdown (${JSON.stringify(serveExit)}); last output: ${serveOutput.slice(-600)}`);
  let res;
  try {
    res = await fetch(`${base()}/api/shutdown`, {
      method: "POST",
      headers: { "x-open-bridge-console": routeToken },
    });
  } catch (error) {
    throw enrich(error);
  }
  assert.equal(res.status, 200);
  const code = await new Promise(resolve => child.on("exit", resolve));
  assert.equal(code, 0);
  port = 0;
});
