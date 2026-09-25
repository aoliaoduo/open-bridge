/**
 * A tunnel that cannot come up must not lie about it — and must not hold the
 * instance hostage while it tries.
 *
 * Two properties are asserted here, both of which failed against a real ngrok
 * that refused the domain:
 *
 *  1. the loopback listener is published to the CLI the moment it binds, so
 *     `open-bridge status` finds the instance even though start() has not
 *     resolved yet;
 *  2. `public_url` is never advertised — the https endpoint is published only
 *     after the tunnel answers, and withdrawn when the tunnel process dies.
 *
 * ngrok is stood in for by Node itself: the fixture file is named `http` with no
 * extension, because the spawn is
 * `ngrokExecutable http <port> --url … --log stdout`, so with
 * `ngrokExecutable = process.execPath` Node loads that file as the script (the
 * serve process runs with cwd set to the fixture directory). It sleeps past the
 * listener's bind and then reports the exact text ngrok prints for a domain the
 * account may not serve.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync, existsSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {ROOT, readRuntimeFor, runtimeFileFor, spawnServe, stopServe} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

/** Sleeps past the listener's bind, then fails the way ngrok refuses a domain. */
const FAKE_NGROK = `
const fs = require("node:fs");
const counter = process.env.OB_FAKE_NGROK_COUNTER;
if (counter) { try { fs.appendFileSync(counter, Date.now() + "\\n"); } catch {} }
setTimeout(() => {
  console.error('t=2026-01-01T00:00:00+0000 lvl=eror msg="terminating with error" obj=app err="failed to start tunnel: Only paid plans may create endpoints with custom subdomains. ERR_NGROK_313"');
  console.error("ERROR:  failed to start tunnel: Only paid plans may create endpoints with custom subdomains.");
  console.error("ERROR:  ERR_NGROK_313");
  process.exit(1);
}, 3000);
`;

/**
 * A deterministic stand-in for the public ngrok edge, preloaded into the serve
 * process via NODE_OPTIONS. The tunnel's START-UP pre-check probes
 * `https://<domain>/healthz/<token>` against the real internet with a 2 s
 * timeout; on a loaded CI box that probe sometimes times out, the verdict
 * flips to "unknown", the start takes the blocked+watch path, and the watch's
 * claim then restarts the instance mid-test — a suite that is green alone
 * went red inside the full run through no fault of the properties under test.
 * Intercepting fetch for the fixture domain makes the edge deterministic:
 * up, and the domain is FREE (404 whose body does not say "Not found").
 * Everything else (health checks, watches) gets the same 404 and stays
 * honestly unhealthy, exactly as with a domain ngrok refuses.
 */
const EDGE_INTERCEPT = `
const FIXTURE_HOSTS = new Set(["fixture-check.ngrok-free.dev"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let host = "";
  try { host = new URL(typeof input === "string" ? input : input.url).hostname; } catch {}
  if (FIXTURE_HOSTS.has(host)) {
    return Promise.resolve(new Response("no endpoint here", { status: 404 }));
  }
  return realFetch(input, init);
};
`;

let home;
let fixture;
let counterFile;
let child;
let port;
let serveLog = "";

const base = () => `http://127.0.0.1:${port}`;
const bridgeLog = () => {
  try { return readFileSync(path.join(home, "logs", "bridge.log"), "utf8"); } catch { return ""; }
};
const spawnCount = () => {
  try { return readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
};

/**
 * Waits for the listener, learning the port from runtime.json — the artefact
 * under test. That file must appear the moment the listener binds, which is
 * before start() resolves and prints the banner.
 */
async function waitForListener(timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = readRuntimeFor(home, fixture);
      if (info.port > 0) {
        port = info.port;
        if ((await fetch(`${base()}/api/status`)).status === 200) return true;
      }
    } catch { /* not published yet, or the listener is still binding */ }
    await delay(120);
  }
  return false;
}

/**
 * Polls until a condition holds, up to a generous deadline.
 *
 * The three tunnel tests below used to encode wall-clock budgets (8 s for a log
 * line, "the stand-in must have run by the time we sample"). Node's test runner
 * runs these files in PARALLEL, so on a loaded machine the spawn lands after the
 * budget — and a suite that is green alone went red inside `npm run verify`
 * with "the stand-in ngrok never ran, so nothing was proven". The properties
 * those tests assert are unchanged: they just stop assuming an idle CPU.
 */
async function until(check, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await delay(200);
  }
  return check();
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-tunnel-home-"));
  fixture = mkdtempSync(path.join(tmpdir(), "ob-tunnel-fixture-"));
  counterFile = path.join(fixture, "spawns.log");
  writeFileSync(path.join(fixture, "http"), FAKE_NGROK);
  const interceptFile = path.join(fixture, "edge-intercept.cjs");
  writeFileSync(interceptFile, EDGE_INTERCEPT);
  // A domain the stand-in refuses, and a public-health budget short enough to
  // keep the test quick.
  writeFileSync(path.join(home, "config.json"), JSON.stringify({
    ngrokDomain: "fixture-check.ngrok-free.dev",
    ngrokExecutable: process.execPath,
    publicHealthTimeoutMs: 15_000,
  }, null, 2));

  child = spawnServe({
    root: fixture, home, tunnel: true,
    cwd: fixture, // so the stand-in `http` script resolves
    env: {
      ...process.env,
      OB_FAKE_NGROK_COUNTER: counterFile,
      // The fake edge rides in with the process (see EDGE_INTERCEPT); the
      // stand-in ngrok inherits it harmlessly — it never fetches.
      NODE_OPTIONS: `--require ${interceptFile}`,
    },
  });
  child.stdout.on("data", d => { serveLog += d; });
  child.stderr.on("data", d => { serveLog += d; });

  const listening = await waitForListener();
  assert.ok(listening, `the listener never answered; serve output:\n${serveLog}`);
  assert.equal(serveLog.includes("Web 控制台"), false,
    "runtime.json was published before start() resolved (the banner is printed afterwards)");
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
  removeTempDir(fixture);
});

test("the listener is published to the CLI while the tunnel is still failing", async () => {
  // The tunnel takes seconds to give up (and never resolves when it cannot come
  // up at all), so runtime.json must not wait for start(): it is written the
  // moment the listener binds.
  assert.ok(existsSync(runtimeFileFor(home, fixture)), "the record is written before start() resolves");
  const runtime = readRuntimeFor(home, fixture);
  assert.equal(runtime.port, port);
  assert.equal(runtime.pid > 0, true);

  const status = await new Promise(resolve => {
    const proc = spawn(process.execPath,
      [path.join(ROOT, "bin", "open-bridge.js"), "status", "--home", home],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", d => { out += d; });
    proc.on("exit", code => resolve({ code, out }));
  });
  assert.equal(status.code, 0);
  assert.match(status.out, /状态:\s+running/);
  assert.match(status.out, /未开启隧道/);
});

test("a refused tunnel is reported promptly, not after the health budget", async () => {
  // The classification is the difference between "the operator is told in three
  // seconds" and "the operator waits out a 20 s health check that was never
  // going to pass" — and, before this, "retries forever".
  await until(() => bridgeLog().includes("隧道发布失败"));
  const log = bridgeLog();
  assert.match(log, /隧道发布失败/);
  assert.match(log, /ERR_NGROK_313/, "ngrok's own reason reaches the operator");
});

test("no public URL is ever advertised while the tunnel is down", async () => {
  // Wait for the stand-in to actually be running before sampling: "nothing was
  // advertised" is only evidence once something existed to advertise.
  assert.ok(await until(() => spawnCount() >= 1), "the stand-in ngrok never ran, so nothing was proven");
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    const body = await (await fetch(`${base()}/api/status`)).json();
    samples.push(body.status.public_url ?? null);
    await delay(400);
  }
  assert.deepEqual([...new Set(samples)], [null], `public_url leaked a dead endpoint: ${JSON.stringify(samples)}`);
});

test("the failed chain stops instead of respawning forever", async () => {
  // One attempt, one reconnect (armed by the process exit before the failure was
  // classified), then silence. A configuration error cannot be healed by trying
  // again, so growth beyond that means the loop came back. The countdown starts
  // when the first spawn is visible, so a loaded machine cannot look like a
  // second respawn.
  assert.ok(await until(() => spawnCount() >= 1), "the stand-in ngrok never ran, so nothing was proven");
  await delay(9_000);
  const settled = spawnCount();
  await delay(6_000);
  assert.equal(spawnCount(), settled, `the tunnel kept respawning (${settled} → ${spawnCount()})`);
  assert.ok(settled <= 2, `expected at most one retry, saw ${settled} spawns`);
});
