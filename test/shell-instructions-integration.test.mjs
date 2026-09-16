/**
 * The connect-time shell line, end to end: a real session's instructions name
 * the interpreter behind run_command / start_process / open_shell, and the
 * dialect it coaches agrees with that interpreter. This is the one fact a
 * connecting model cannot infer — and guessing wrong does not error, it
 * mis-guards (`2>nul` under bash writes a file literally named `nul`).
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let workspace;
let child;
let port;
let routeToken;
let instructions = "";

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-shellinst-home-"));
  workspace = mkdtempSync(path.join(tmpdir(), "ob-shellinst-ws-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", workspace, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, workspace);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, workspace); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shell-inst-test", version: "1" } },
  }), { "content-type": "application/json", accept: "application/json, text/event-stream" });
  instructions = lastSsePayload(res.body)?.result?.instructions ?? "";
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(home);
  removeTempDir(workspace);
});

test("the instructions name the interpreter of command text, and coach its dialect", () => {
  const m = instructions.match(/interpreted by `([^`]+)` \(`([^`]+)`\)/);
  assert.ok(m, "the shell line is present in the connect-time instructions");
  const [, file, args] = m;
  assert.ok(args.length > 0, "the invocation shape is shown, not just the path");
  assert.match(instructions, /run_command/);
  const base = path.basename(file);
  if (base !== "powershell.exe" && base !== "pwsh.exe") {
    // By-name invocations are PATH-resolved on purpose (that is how the
    // provider lists them); every other value must be a real existing path.
    assert.ok(existsSync(file), `named interpreter exists on this machine: ${file}`);
  }
  const coachedPowerShell = instructions.includes("PowerShell syntax");
  const namedPowerShell = base.toLowerCase().includes("powershell") || base === "pwsh.exe";
  assert.equal(coachedPowerShell, namedPowerShell,
    `the coached dialect disagrees with the named interpreter: ${file}`);
});

// ---------------------------------------------------------------- MCP plumbing
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
