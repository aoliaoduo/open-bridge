/**
 * API integration test: boots a real `open-bridge serve` process on an
 * ephemeral port, exercises the loopback/mutation gates and the console,
 * then stops it through the shutdown endpoint. Runs against the BUILT dist
 * (npm run build:core first) — same pattern as the extension repo's
 * endpoint-integration test ran against the built extension.
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
  home = mkdtempSync(path.join(tmpdir(), "ob-api-test-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", d => { bootLog += d; });
  child.stderr.on("data", d => { bootLog += d; });
  child.on("exit", code => {
    if (!port) throw new Error(`serve exited early (${code}):\n${bootLog}`);
  });
  const runtime = await waitForRuntime();
  port = runtime.port;
  // The route token is written during start(); give it a moment if absent.
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

test("shutdown endpoint stops the process", async () => {
  const res = await fetch(`${base()}/api/shutdown`, {
    method: "POST",
    headers: { "x-open-bridge-console": routeToken },
  });
  assert.equal(res.status, 200);
  const code = await new Promise(resolve => child.on("exit", resolve));
  assert.equal(code, 0);
  port = 0;
});
