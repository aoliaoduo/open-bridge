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
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {readRuntimeFor, routeTokenFor, spawnServe} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

/** `tailscale status --json`: a machine name that will not resolve. */
const FAKE_STATUS = `
process.stdout.write(JSON.stringify({ Self: { DNSName: "fixture-machine.tail9999.ts.net.", Online: true } }));
`;

/**
 * The stand-in `funnel` subcommand, stateful the way the real daemon is.
 *
 * `--bg <port>` writes the mount (one mount per port: the daemon replaces what
 * was there), `funnel status --json` reads it back, `off` clears it, and every
 * call lands in the caller's log file. That state is what the follow/claim
 * behaviour is actually about, so a fixture that only counted calls could not
 * tell "this instance refused to steal a live mount" from "this instance never
 * looked".
 *
 * The mount's backend is the instance's OWN loopback port, which is also what
 * makes the liveness question real: while that instance runs, the port answers
 * and the mount belongs to a live peer; after it is killed, the port is dead and
 * the mount is a leftover to be claimed.
 */
const FAKE_FUNNEL = `
const fs = require("node:fs");
const statePath = process.env.OB_FAKE_TAILSCALE_STATE;
const log = process.env.OB_FAKE_TAILSCALE_LOG;
const args = process.argv.slice(2);
if (log) { try { fs.appendFileSync(log, args.join(" ") + "\\n"); } catch {} }
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
const writeState = value => { try { fs.writeFileSync(statePath, JSON.stringify(value)); } catch {} };
const host = "fixture-machine.tail9999.ts.net:443";
if (args.includes("status")) { process.stdout.write(JSON.stringify(readState())); process.exit(0); }
if (args.includes("off")) { writeState({}); process.exit(0); }
const port = Number(args[args.length - 1]);
writeState({
  TCP: { "443": { HTTPS: true } },
  Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:" + port } } } },
  AllowFunnel: { [host]: true },
});
process.exit(0);
`;

/**
 * A flippable stand-in for the public endpoint, preloaded into the serve
 * process via NODE_OPTIONS (the same trick the ngrok suite uses for its edge).
 * The fixture hostname does not resolve, so the health checks that decide
 * ownership would otherwise always fail; the flag file lets a test say when
 * the public endpoint is up. Absent by default, so every pre-existing scenario
 * (health check fails, instance stays local) runs exactly as before.
 */
const HEALTHZ_INTERCEPT = `
const FLAG = process.env.OB_FAKE_HEALTHZ_FLAG;
const FIXTURE_HOST = "fixture-machine.tail9999.ts.net";
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let url;
  try { url = new URL(typeof input === "string" ? input : input.url); } catch {}
  // DNSName keeps a trailing dot ("…ts.net."), and URL.hostname preserves it.
  if (url && url.hostname.replace(/\\.$/, "") === FIXTURE_HOST && url.pathname.startsWith("/healthz/")) {
    let up = false;
    try { up = require("node:fs").readFileSync(FLAG, "utf8").trim() === "up"; } catch {}
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: up ? 200 : 503,
      headers: { "content-type": "application/json" },
    }));
  }
  return realFetch(input, init);
};
`;

let home;
let fixture;
let counterFile;
let stateFile;
let healthFlag;
let child;
let port;
let serveLog = "";
/** The second instance: the one that must follow a live mount instead of taking it. */
let secondRoot;
let secondLog;
let secondChild;
let secondPort;
let secondServeLog = "";

const base = () => `http://127.0.0.1:${port}`;
const base2 = () => `http://127.0.0.1:${secondPort}`;

const logLines = file => {
  try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
};
const funnelCalls = () => logLines(counterFile).filter(line => line.includes("--bg")).length;
const spawns = () => logLines(counterFile).length;
const callsOf = (file, needle) => logLines(file).filter(line => line.includes(needle)).length;

/** The mount the stand-in daemon currently holds (the real `funnel status` answer). */
const fakeMount = () => {
  try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; }
};
const fakeMountPort = () => {
  const web = fakeMount().Web ?? {};
  const entry = Object.values(web)[0];
  const proxy = entry && Object.values(entry.Handlers ?? {})[0]?.Proxy;
  return proxy ? Number(new URL(proxy).port) : undefined;
};
const writeFakeMount = proxyPort => {
  const host = "fixture-machine.tail9999.ts.net:443";
  writeFileSync(stateFile, JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [host]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}` } } } },
    AllowFunnel: { [host]: true },
  }));
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

/** Same, for checks that must await something. */
async function untilAsync(check, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await delay(200);
  }
  return check();
}

async function waitForListener(root = fixture, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = readRuntimeFor(home, root);
      if (info.port > 0) {
        if (root === fixture) port = info.port; else secondPort = info.port;
        if ((await fetch(`http://127.0.0.1:${info.port}/api/status`)).status === 200) return true;
      }
    } catch { /* not published yet */ }
    await delay(120);
  }
  return false;
}

/** The status document of instance one, or two. */
async function statusOf(which = 1) {
  const res = await fetch(`${which === 1 ? base() : base2()}/api/status`);
  return (await res.json()).status;
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
  stateFile = path.join(fixture, "funnel-state.json");
  healthFlag = path.join(fixture, "healthz-flag.txt");
  // An explicit empty serve config: the daemon answers, and nobody holds 443.
  writeFileSync(stateFile, "{}");
  writeFileSync(path.join(fixture, "status"), FAKE_STATUS);
  writeFileSync(path.join(fixture, "funnel"), FAKE_FUNNEL);
  writeFileSync(path.join(fixture, "healthz-intercept.cjs"), HEALTHZ_INTERCEPT);
  writeFileSync(path.join(home, "config.json"), JSON.stringify({
    tunnelProvider: "tailscale",
    // The MSI does not put tailscale on PATH; this is the explicit override a
    // real operator would use, and here it points at the stand-in.
    tailscaleExecutable: process.execPath,
    // Keep the public health check short: the reported domain cannot resolve.
    publicHealthTimeoutMs: 1_500,
  }, null, 2));

  child = spawnServe({
    root: fixture, home, tunnel: true,
    cwd: fixture, // so the stand-in `status` / `funnel` scripts resolve
    env: {
      ...process.env,
      OB_FAKE_TAILSCALE_LOG: counterFile,
      OB_FAKE_TAILSCALE_STATE: stateFile,
      OB_FAKE_HEALTHZ_FLAG: healthFlag,
      NODE_OPTIONS: `--require ${path.join(fixture, "healthz-intercept.cjs")}`,
    },
  });
  child.stdout.on("data", d => { serveLog += d; });
  child.stderr.on("data", d => { serveLog += d; });

  const listening = await waitForListener();
  assert.ok(listening, `the listener never answered; serve output:\n${serveLog}`);
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  if (secondChild && !secondChild.killed) secondChild.kill("SIGTERM");
  await delay(300);
  removeTempDir(home);
  removeTempDir(fixture);
  removeTempDir(secondRoot);
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

test("a live mount on 443 is followed, never stolen", async () => {
  // Instance one is up and the daemon's mount points at its answering port: that
  // is the live holder the second instance has to respect. `funnel --bg` replaces
  // the daemon's mount, so spawning would be a hijack — and the hijacker's own
  // teardown would then switch off the survivor's public access.
  assert.equal(fakeMountPort(), port, "the stand-in daemon holds instance one's mount");

  secondRoot = mkdtempSync(path.join(tmpdir(), "ob-tailscale-second-"));
  secondLog = path.join(fixture, "calls-second.log");
  writeFileSync(secondLog, "");
  secondChild = spawnServe({
    root: secondRoot, home, tunnel: true,
    cwd: fixture, // same stand-in CLI, its own call log
    env: { ...process.env, OB_FAKE_TAILSCALE_LOG: secondLog, OB_FAKE_TAILSCALE_STATE: stateFile },
  });
  secondChild.stdout.on("data", d => { secondServeLog += d; });
  secondChild.stderr.on("data", d => { secondServeLog += d; });
  assert.ok(await waitForListener(secondRoot), `the second instance never listened; output:\n${secondServeLog}`);

  // It asked who holds 443 ...
  assert.ok(await until(() => callsOf(secondLog, "status") >= 1),
    `the second instance never asked who holds 443; calls:\n${logLines(secondLog).join("\n")}`);
  // ... and it left the live mount alone for longer than a claim would take.
  await delay(6_000);
  assert.equal(callsOf(secondLog, "--bg"), 0,
    `the second instance stole a live mount:\n${logLines(secondLog).join("\n")}`);
  assert.equal((await statusOf(2)).tunnel_role, "blocked",
    "and it says so instead of pretending to own a tunnel");
  assert.equal(fakeMountPort(), port, "the live holder still owns 443");
  assert.equal((await statusOf(2)).public_url ?? null, null,
    "the fixture hostname resolves nowhere, so nothing public may be advertised");
});

test("when the holder's mount goes stale, the follower claims 443", async () => {
  // The holder died without running `funnel off` (Windows has no SIGTERM handler
  // to run one): the mount is still in the daemon, the port behind it is not.
  // That is a release, and the only thing that can notice is the watch — the
  // config will never disappear on its own.
  writeFakeMount(1); // nothing serves port 1: connecting to it is refused
  const attemptsBefore = callsOf(secondLog, "--bg");
  // 60 s, not 45: the watch's own cadence is 10 s (healthy) then 4 s (unhealthy)
  // and a loaded CI runner pays a fetch timeout per round on top of it.
  assert.ok(await until(() => callsOf(secondLog, "--bg") > attemptsBefore, 60_000),
    `the follower never claimed the released mount; calls:\n${logLines(secondLog).join("\n")}`);
  assert.equal(fakeMountPort(), secondPort, "the claim is what put its own backend on 443");
});

test("stopping does not switch off a mount that belongs to someone else", async () => {
  // One mount per port, and `funnel off` takes down whatever is on it: an
  // instance that removes a foreign mount on its way out cuts the public access
  // of an instance that is still running — the failure this check exists for.
  writeFakeMount(port); // instance one's live mount, not this instance's
  const offBefore = callsOf(secondLog, "off");
  const res = await fetch(`${base2()}/api/settings/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeTokenFor(home, secondRoot) },
    body: JSON.stringify({ command: "setConfig", key: "tunnelProvider", value: "none" }),
  });
  assert.equal(res.status, 200, await res.text());
  await delay(1_500);
  assert.equal(callsOf(secondLog, "off"), offBefore,
    `a foreign mount was switched off:\n${logLines(secondLog).join("\n")}`);
  assert.equal(fakeMountPort(), port, "the peer's mount is exactly where it was");
});

test("an owner whose mount vanished watches the domain and re-mounts the funnel", async () => {
  // The owner-success path used to arm nothing: the funnel is daemon-side
  // state and the launcher child exits by design, so when the mount vanished
  // LATER (another instance won the port, `funnel off`, a serve reset), the
  // instance kept role "owner" and a dead public URL forever — and Start
  // answered "already running" because the retry branch only fires for role
  // "none". Followers always had a watch; the owner needs one too.
  //
  // The previous test leaves the provider on "none" and an instance may still
  // be settling the teardown that change triggered. Each switch re-arms a new
  // generation, so cycle none->tailscale and only accept ownership from a
  // settled cycle; the first cycle absorbs any straggler from test six.
  writeFileSync(healthFlag, "up");
  let owned = false;
  for (let cycle = 0; cycle < 2 && !owned; cycle += 1) {
    await postJson("/api/settings/action", { command: "setConfig", key: "tunnelProvider", value: "none" });
    await delay(1_500);
    const back = await postJson("/api/settings/action", { command: "setConfig", key: "tunnelProvider", value: "tailscale" });
    assert.equal(back.status, 200, await back.text());
    owned = await untilAsync(
      async () => fakeMountPort() === port && (await publicUrl()) !== null,
      45_000,
    );
  }
  assert.ok(owned,
    `the instance never took ownership; calls:\n${logLines(counterFile).join("\n")}`);
  // Count from ownership: the provider switches themselves already spent
  // several --bg calls.
  const bgAtOwner = funnelCalls();

  // The mount vanishes: the daemon now shows a dead backend on 443 and the
  // public endpoint stops answering. The watch's two-consecutive-free rule
  // must claim the endpoint back (a fresh `--bg` with our own port), and the
  // claim's own health check must see a healthy origin again — flip the flag
  // up the moment the re-mount is observed (the health check polls every
  // 750 ms, the observation every 200 ms, so the flip lands in between).
  writeFakeMount(1);
  writeFileSync(healthFlag, "down");
  const remounted = await until(() => {
    if (funnelCalls() > bgAtOwner && fakeMountPort() === port) {
      writeFileSync(healthFlag, "up");
      return true;
    }
    return false;
  }, 60_000);
  assert.ok(remounted,
    `the owner never re-mounted the vanished funnel; calls:\n${logLines(counterFile).join("\n")}`);
  assert.equal(fakeMountPort(), port, "the re-mount is the instance's own backend");
  assert.ok(await untilAsync(async () => (await publicUrl()) !== null, 10_000),
    "the re-mounted funnel is advertised again");

  // Leave the suite as the previous test found it: no tunnel wanted, and the
  // flippable endpoint down.
  writeFileSync(healthFlag, "down");
  await postJson("/api/settings/action", { command: "setConfig", key: "tunnelProvider", value: "none" });
});
