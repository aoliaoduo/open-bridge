/**
 * Crash guards integration test: requests that used to end the process, over raw
 * sockets, plus the /console path containment that protects the app's own files.
 *
 * Ported from the throwaway `scripts/crash-check.mjs` probe. What it documents
 * is a killer rather than a wrong answer: `new URL(req.url)` threw out of an
 * async request listener for an absolute-form target with an out-of-range port
 * (Node's HTTP parser accepts the target, WHATWG URL refuses it), and
 * `decodeURIComponent` threw on `%zz`. Both escaped the handler, reached the top
 * of the process and exited it — every MCP session, background service and shell
 * session went with it. Now the answer is a 400 and the listener stays up, with
 * a process-level `unhandledRejection` net behind the handler.
 *
 * The containment half is the same class of bug caught before it happens:
 * `path.relative` on the resolved target, not a prefix compare, so
 * `dist/ui-extra` is not "inside" `dist/ui` and `..%2f` cannot climb out.
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import net from "node:net";
import {mkdtempSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnServe, stopServe, waitForRuntime } from "./lib/bridge-runtime.mjs";

let home;
let child;
let port;
let serveExit = null;
let serveOutput = "";

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-crashguards-"));
  child = spawnServe({ root: home, home });
  child.stdout.on("data", d => { serveOutput += d; });
  child.stderr.on("data", d => { serveOutput += d; });
  child.on("exit", (code, signal) => { serveExit = { code, signal }; });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
});

/** Raw bytes at the socket, so no client-side URL validation can reject it first. */
function rawBytes(payload) {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    let out = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", chunk => { out += chunk; });
    socket.on("error", err => resolve(`[socket error: ${err.code ?? err.message}]`));
    socket.on("close", () => resolve(out));
    setTimeout(() => { socket.destroy(); resolve(out || "[timeout]"); }, 3_000);
  });
}

const statusLine = text => text.split("\r\n", 1)[0].trim() || "[no response]";

function get(reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "GET", path: reqPath, agent: false,
      headers: { host: `127.0.0.1:${port}` }, signal: AbortSignal.timeout(8_000),
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The listener still answers and the process is still the one we started. */
async function isUp() {
  if (serveExit !== null) return false;
  try {
    return (await get("/api/status")).status === 200;
  } catch {
    return false;
  }
}

const died = () => `serve died: ${JSON.stringify(serveExit)}\n${serveOutput.slice(-600)}`;

test("an absolute-form target with an out-of-range port answers 400 instead of killing the process", async () => {
  const raw = await rawBytes(
    `GET http://127.0.0.1:99999/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
  );
  assert.match(statusLine(raw), /^HTTP\/1\.1 400 /, raw.slice(0, 120));
  assert.equal(await isUp(), true, died());
});

test("percent-escapes decodeURIComponent rejects answer 400 instead of killing the process", async () => {
  for (const target of ["/console/%zz", "/console/%E0%A4%A", "/console/%"]) {
    const raw = await rawBytes(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 400 /, `${target}: ${raw.slice(0, 120)}`);
    assert.equal(await isUp(), true, `${target} took the process down\n${serveOutput.slice(-600)}`);
  }
});

test("/console refuses to serve anything outside its own directory", async () => {
  const escapes = [
    "/console/../package.json",
    "/console/%2e%2e/package.json",
    "/console/..%2fpackage.json",
    "/console/..%5cpackage.json",
    "/console/%2e%2e%5cpackage.json",
    "/console/..%2f..%2fpackage.json",
    "/console/assets/../../../package.json",
  ];
  for (const target of escapes) {
    const res = await get(target);
    assert.notEqual(res.status, 200, `${target} was served`);
    assert.equal(res.body.includes('"name": "open-bridge"'), false, `${target} leaked package.json`);
  }
  assert.equal(await isUp(), true, died());
});

test("the console page itself still serves after those requests", async () => {
  const res = await get("/console/");
  assert.equal(res.status, 200);
  assert.match(res.body, /<html/i);
});
