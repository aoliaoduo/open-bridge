/**
 * Multi-instance integration test: two Bridges, two directories, one data dir.
 *
 * This encodes the standalone app's core promise — "cd A && open-bridge serve"
 * serves A, "cd B && open-bridge serve" serves B — which the app could not
 * actually keep before: runtime records lived in a single shared runtime.json,
 * so the second serve overwrote the first record and then refused to start at
 * all. The record is per-root now, and every bare command resolves the instance
 * belonging to the directory it was typed in.
 *
 * Boots two real processes and drives them over HTTP plus the real CLI.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const run = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CLI = path.join(ROOT, "bin", "open-bridge.js");

let home;
let dirA;
let dirB;
const instances = {};

function suffixFor(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

function runtimeFileFor(root) {
  return path.join(home, `runtime-${suffixFor(root)}.json`);
}

function routeTokenFor(root) {
  const secrets = JSON.parse(readFileSync(path.join(home, "secrets.json"), "utf8"));
  return secrets[`openBridge.routeToken.${suffixFor(root)}`];
}

async function waitFor(predicate, what, timeoutMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await Promise.resolve(predicate()).catch(() => undefined);
    if (value) return value;
    await delay(250);
  }
  throw new Error(`${what} never happened`);
}

function getJson(port, pathname, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: pathname,
        agent: false,
        headers: token ? { "x-open-bridge-console": token } : {},
        signal: AbortSignal.timeout(6_000),
      },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function boot(label, dir) {
  const child = spawn(process.execPath, [CLI, "serve", "--no-tunnel", "--port", "0", "--root", dir, "--home", home], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  instances[label] = { child, output: () => output, dir, pid: undefined, port: undefined };
}

async function statusFor(label) {
  const info = instances[label];
  const runtime = JSON.parse(readFileSync(runtimeFileFor(info.dir), "utf8"));
  const res = await getJson(runtime.port, "/api/status", routeTokenFor(info.dir));
  return { runtime, status: JSON.parse(res.body).status, http: res.status };
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-multi-home-"));
  dirA = mkdtempSync(path.join(tmpdir(), "ob-multi-A-"));
  dirB = mkdtempSync(path.join(tmpdir(), "ob-multi-B-"));
  boot("A", dirA);
  boot("B", dirB);
  await waitFor(() => existsSync(runtimeFileFor(dirA)) && existsSync(runtimeFileFor(dirB)), "both runtime records");
});

after(async () => {
  for (const { child } of Object.values(instances)) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
  await delay(600);
  rmSync(home, { recursive: true, force: true });
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("two directories run two Bridges against one shared data dir", async () => {
  const a = await statusFor("A");
  const b = await statusFor("B");
  assert.equal(a.http, 200, `instance A must be serving:\n${instances.A.output().slice(-500)}`);
  assert.equal(b.http, 200, `instance B must be serving:\n${instances.B.output().slice(-500)}`);
  assert.notEqual(a.runtime.port, b.runtime.port, "each instance binds its own port");
  assert.notEqual(a.runtime.pid, b.runtime.pid);
  assert.equal(a.runtime.root, path.resolve(dirA));
  assert.equal(b.runtime.root, path.resolve(dirB));
});

test("each instance reports the directory it was started in", async () => {
  const a = await statusFor("A");
  const b = await statusFor("B");
  assert.equal(path.resolve(String(a.status.workspace_root)), path.resolve(dirA));
  assert.equal(path.resolve(String(b.status.workspace_root)), path.resolve(dirB));
  assert.notEqual(a.status.mcp_url, b.status.mcp_url, "the route tokens differ per workspace");
});

test("each instance gets a route token of its own, and both survive", async () => {
  const both = await waitFor(() => {
    const a = routeTokenFor(dirA);
    const b = routeTokenFor(dirB);
    return a && b ? { a, b } : undefined;
  }, "both route tokens", 15_000);
  assert.notEqual(both.a, both.b, "the two instances must not share a route token");
});

test("`open-bridge status` answers for the directory it is typed in", async () => {
  const fromA = await run(process.execPath, [CLI, "status", "--home", home], { cwd: dirA });
  assert.match(fromA.stdout, /状态: running/);
  assert.ok(fromA.stdout.includes(path.resolve(dirA)), `status in A must name A:\n${fromA.stdout}`);
  assert.equal(fromA.stdout.includes(path.resolve(dirB)), false, "and must not name B");

  const fromB = await run(process.execPath, [CLI, "status", "--home", home], { cwd: dirB });
  assert.ok(fromB.stdout.includes(path.resolve(dirB)), `status in B must name B:\n${fromB.stdout}`);
});

test("`open-bridge instances` lists both, and marks the current directory", async () => {
  const listed = await run(process.execPath, [CLI, "instances", "--home", home], { cwd: dirA });
  assert.match(listed.stdout, /2 个实例/);
  assert.ok(listed.stdout.includes(path.resolve(dirA)), "A is listed");
  assert.ok(listed.stdout.includes(path.resolve(dirB)), "B is listed");
  const marked = listed.stdout.split("\n").filter(line => line.includes("← 当前目录"));
  assert.equal(marked.length, 1, `exactly one instance is the current directory:\n${listed.stdout}`);
  assert.ok(marked[0].includes(path.resolve(dirA)));
});

test("`open-bridge stop` in A stops A only", async () => {
  // Read both ports BEFORE stopping: a stopped instance removes its own record.
  const aBefore = await statusFor("A");
  const bBefore = await statusFor("B");
  const stopped = await run(process.execPath, [CLI, "stop", "--home", home], { cwd: dirA });
  assert.match(stopped.stdout, /已发送停止指令/);

  const aGone = await waitFor(async () => {
    try { await getJson(aBefore.runtime.port, "/healthz/none"); return false; }
    catch { return true; }
  }, "A's listener to close");
  assert.ok(aGone, "A is gone");
  assert.equal(existsSync(runtimeFileFor(dirA)), false, "A's runtime record is cleaned up with it");

  const stillThere = await getJson(bBefore.runtime.port, "/api/status", routeTokenFor(dirB));
  assert.equal(stillThere.status, 200, "B keeps serving — stopping one directory must not touch the other");
  const bStatus = JSON.parse(stillThere.body).status;
  assert.equal(path.resolve(String(bStatus.workspace_root)), path.resolve(dirB));
});

test("a second serve in the same directory is refused with a clear message", async () => {
  const again = await run(process.execPath, [CLI, "serve", "--no-tunnel", "--port", "0", "--root", dirB, "--home", home], { cwd: dirB })
    .then(() => ({ code: 0, stderr: "" }))
    .catch(error => ({ code: error.code, stderr: String(error.stderr ?? "") }));
  assert.notEqual(again.code, 0, "the duplicate must fail, not silently double-bind");
  assert.match(again.stderr + (again.stdout ?? ""), /该目录已有实例在运行/, `expected the per-directory refusal, got: ${again.stderr}`);
});

test("the startup lock dies with its instance, and a stale one is reclaimed", async () => {
  const lockFor = root => path.join(home, `serve-${suffixFor(root)}.lock`);
  // A was stopped by the previous test: its graceful shutdown takes the lock
  // along with the runtime record.
  assert.equal(existsSync(lockFor(dirA)), false, "no lock survives a graceful stop");

  // A lock left by an abruptly killed instance (a dead pid, which is the normal
  // case on Windows) must not refuse the next serve in that directory.
  writeFileSync(lockFor(dirA), JSON.stringify({ pid: 999_999_999, root: dirA }));
  rmSync(runtimeFileFor(dirA), { force: true });
  boot("A2", dirA);
  const a2 = instances.A2;

  const runtime = await waitFor(() => {
    try { return JSON.parse(readFileSync(runtimeFileFor(dirA), "utf8")); } catch { return false; }
  }, "the reclaiming serve to publish its record");
  assert.equal(runtime.pid, a2.child.pid, "the serve that reclaimed the lock is the one that bound");
  assert.equal(JSON.parse(readFileSync(lockFor(dirA), "utf8")).pid, a2.child.pid,
    "the stale claim was replaced by the live one");

  const stopped = await run(process.execPath, [CLI, "stop", "--home", home], { cwd: dirA });
  assert.match(stopped.stdout, /已发送停止指令/);
  await waitFor(() => !existsSync(lockFor(dirA)), "the lock to disappear with its instance");
  assert.equal(existsSync(runtimeFileFor(dirA)), false, "and the runtime record with it");
});
