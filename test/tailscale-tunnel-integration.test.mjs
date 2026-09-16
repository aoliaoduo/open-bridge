/**
 * The Tailscale funnel path, driven end to end with a stand-in CLI.
 *
 * Why this file exists next to `tunnel-integration.test.mjs`: that suite covers
 * the ngrok path, where the tunnel is a child process this Bridge owns and can
 * kill. The funnel is not: `funnel --bg` writes a daemon-side config entry and
 * the child exits immediately, so "is the tunnel up?" has a different answer
 * here — and every place that had learned the ngrok answer had to learn this
 * one too. Two of them had not, and this suite is what says so:
 *
 *  1. `start()` with a tunnel already wanted and not up ("Start" in the console,
 *     and the sentence the failure path prints — 「修复后点 Start 重试」) must
 *     retry a TAILSCALE tunnel as well. It only retried ngrok, and the tailscale
 *     failure path left a dead `--bg` child in `state.tunnel`, so even a
 *     provider-agnostic retry would have found "a tunnel is there" and skipped.
 *     The retry loop is the only recovery a failed tunnel has.
 *  2. A provider switch must rebuild the running tunnel immediately — including
 *     a switch INTO tailscale, whose whole start path is different.
 *
 * The stand-in works the way the ngrok fixture does: the "executable" is Node
 * itself, and the fixture directory holds extensionless files named `status` and
 * `funnel`, so `node status --json` and `node funnel --bg <port>` load the right
 * script (the serve process runs with cwd set to the fixture directory, which
 * the children inherit). Nothing public is contacted: the domain the stand-in
 * reports does not resolve, so the public health check fails fast and the
 * instance stays local — which is itself one of the assertions.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {readRuntimeFor, routeTokenFor} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** `tailscale status --json`: a machine name that will not resolve. */
const FAKE_STATUS = `
process.stdout.write(JSON.stringify({ Self: { DNSName: "fixture-machine.tail9999.ts.net.", Online: true } }));
`;

/**
 * `tailscale funnel --bg <port>` (and the `funnel --https=443 off` teardown):
 * record the call and exit, exactly like the real --bg spawn does.
 */
const FAKE_FUNNEL = `
const fs = require("node:fs");
const log = process.env.OB_FAKE_TAILSCALE_LOG;
if (log) { try { fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n"); } catch {} }
process.exit(0);
`;

let home;
let fixture;
let counterFile;
let child;
let port;
let serveLog = "";

const base = () => `http://127.0.0.1:${port}`;
const funnelCalls = () => {
  try {
    return readFileSync(counterFile, "utf8").trim().split("\n").filter(line => line.includes("--bg")).length;
  } catch { return 0; }
};
const spawns = () => {
  try { return readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
};

/** Polls until a condition holds; the suite must not assume an idle CPU. */
async function until(check, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await delay(200);
  }
  return check();
}

async function waitForListener(timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = readRuntimeFor(home, fixture);
      if (info.port > 0) {
        port = info.port;
        if ((await fetch(`${base()}/api/status`)).status === 200) return true;
      }
    } catch { /* not published yet */ }
    await delay(120);
  }
  return false;
}

/** POST with the console header the mutation gate requires. */
function postJson(pathname, body, headers = {}) {
  return fetch(`${base()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeTokenFor(home, fixture), ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

const publicUrl = async () => (await (await fetch(`${base()}/api/status`)).json()).status.public_url ?? null;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-tailscale-home-"));
  fixture = mkdtempSync(path.join(tmpdir(), "ob-tailscale-fixture-"));
  counterFile = path.join(fixture, "calls.log");
  writeFileSync(path.join(fixture, "status"), FAKE_STATUS);
  writeFileSync(path.join(fixture, "funnel"), FAKE_FUNNEL);
  writeFileSync(path.join(home, "config.json"), JSON.stringify({
    tunnelProvider: "tailscale",
    // The MSI does not put tailscale on PATH; this is the explicit override a
    // real operator would use, and here it points at the stand-in.
    tailscaleExecutable: process.execPath,
    // Keep the public health check short: the reported domain cannot resolve.
    publicHealthTimeoutMs: 1_500,
  }, null, 2));

  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--port", "0", "--root", fixture, "--home", home,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: fixture, // so the stand-in `status` / `funnel` scripts resolve
    env: { ...process.env, OB_FAKE_TAILSCALE_LOG: counterFile },
  });
  child.stdout.on("data", d => { serveLog += d; });
  child.stderr.on("data", d => { serveLog += d; });

  const listening = await waitForListener();
  assert.ok(listening, `the listener never answered; serve output:\n${serveLog}`);
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(home);
  removeTempDir(fixture);
});

test("the funnel is attempted once, and a domain that cannot answer is never advertised", async () => {
  assert.ok(await until(() => funnelCalls() >= 1), `the stand-in funnel never ran; serve output:\n${serveLog}`);
  // The public health check is the only readiness signal the --bg spawn offers,
  // so a domain that does not answer must leave the instance local.
  await until(() => funnelCalls() >= 1);
  await delay(2_500); // let the health budget expire, if it is going to
  assert.equal(await publicUrl(), null, "public_url must stay empty while the hostname answers nothing");
});

test("Start retries a tailscale tunnel that never came up", async () => {
  // The failure path tells the operator 「修复后点 Start 重试」 — which is only
  // true if Start actually retries THIS provider. The ngrok path retried; the
  // tailscale one answered 「already running」 and the tunnel stayed down until a
  // full restart.
  const attemptsBefore = funnelCalls();
  assert.ok(attemptsBefore >= 1, "the first attempt must have happened for a retry to mean anything");

  const res = await postJson("/api/bridge/start");
  assert.equal(res.status, 200, await res.text());

  assert.ok(await until(() => funnelCalls() > attemptsBefore),
    `Start did not retry the tailscale tunnel (attempts stayed at ${attemptsBefore}); serve output:\n${serveLog}`);
});

test("switching the provider rebuilds the running tunnel, both ways", async () => {
  // A switch to `none` must take the tunnel down; a switch back must bring a NEW
  // attempt up — without restarting the instance. This is the promise of the
  // provider-switch fix, and the tailscale direction of it had no test at all.
  const res = await postJson("/api/settings/action", { command: "setConfig", key: "tunnelProvider", value: "none" });
  assert.equal(res.status, 200, await res.text());
  assert.equal(await publicUrl(), null, "no public URL once the tunnel provider is none");

  const attemptsBeforeSwitch = funnelCalls();
  const back = await postJson("/api/settings/action", { command: "setConfig", key: "tunnelProvider", value: "tailscale" });
  assert.equal(back.status, 200, await back.text());
  assert.ok(await until(() => funnelCalls() > attemptsBeforeSwitch),
    `switching back to tailscale did not rebuild the tunnel (attempts stayed at ${attemptsBeforeSwitch})`);

  assert.ok(spawns() >= 2, `the teardown and start calls should both be recorded, saw ${spawns()}`);
});
