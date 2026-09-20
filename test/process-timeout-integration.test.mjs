/**
 * Foreground `run_command` timeout, end to end.
 *
 * This branch had two independent signals claiming it might not exist.
 * TypeScript narrows `let timedOut = false` to the literal `false` and does not
 * track the assignment inside the `setTimeout` callback, so `if (timedOut && …)`
 * type-checked as dead code (`@typescript-eslint/no-unnecessary-condition`:
 * "value is always falsy"). And no test ever fired the timer — every
 * `timeout_ms` in the suite was 20–30 s, far above any command's runtime.
 *
 * It is not dead, and it is the answer an agent gets every time it starts a dev
 * server in the foreground. What `run_command`'s own description promises:
 * "on timeout it keeps running: status \"running\" + command_id (stop:
 * force_terminate)". Each half of that is pinned below.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import {mkdtempSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let workspace;
let home;
let child;
let port;
let routeToken;
let sessionId;

/** Shared by the first two tests: the timeout answer, then proof it survived. */
let slowCommandId;

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "ob-timeout-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "ob-timeout-home-"));
  // Prints once immediately, once after 5 s, then exits 0.
  writeFileSync(
    path.join(workspace, "slow.mjs"),
    'console.log("first");\nsetTimeout(() => { console.log("second"); }, 5000);\n',
    "utf8",
  );
  // Never exits: the force_terminate case.
  writeFileSync(path.join(workspace, "forever.mjs"), 'setInterval(() => {}, 1000);\n', "utf8");
  // Short, but long enough that a timer firing at ~0 ms would beat it.
  writeFileSync(
    path.join(workspace, "quick.mjs"),
    'setTimeout(() => { console.log("done"); }, 300);\n',
    "utf8",
  );
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
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(workspace);
  removeTempDir(home);
});

test("a command that outlives timeout_ms returns as still running instead of blocking", async () => {
  const startedAt = Date.now();
  const res = asObject(await callTool("run_command", { command: "node slow.mjs", timeout_ms: 2000 }));
  const elapsed = Date.now() - startedAt;

  // The command runs 5 s. Returning in well under that is the whole point: the
  // caller is not held hostage by a foreground wait. The margin is deliberately
  // wide — the integration files run in parallel, each with its own instance,
  // so node's cold start here is not a fixed cost.
  assert.ok(elapsed < 4000, `the call returned after ${elapsed} ms, not after the command's 5000 ms`);

  assert.equal(res.timed_out, true, "the answer says it timed out");
  assert.equal(res.status, "running", "and that the command is still running");
  assert.equal(res.ready, false, "it never became ready");
  assert.equal(res.exit_code, undefined, "no exit code is invented for a live process");
  assert.ok(typeof res.command_id === "string" && res.command_id.length > 0,
    `a command_id comes back for polling: ${JSON.stringify(res).slice(0, 200)}`);
  assert.match(res.message ?? "", /left alive under supervision/,
    "the message tells the caller the process was not killed");
  // 2000 ms is comfortably past node's cold start, so the first line is there.
  assert.match(res.output ?? "", /first/, "output produced before the timeout is still returned");
  assert.doesNotMatch(res.output ?? "", /second/, "and output that has not happened yet is not");

  slowCommandId = res.command_id;
});

test("the process really was left alive: it finishes on its own and the id still works", async () => {
  assert.ok(slowCommandId, "the previous test returned a command id");

  // If the timeout had killed it, this would report a terminated process and
  // "second" would never appear.
  const waited = asObject(await callTool("wait_process", { command_id: slowCommandId, timeout_ms: 10_000 }));
  assert.equal(waited.status, "completed", `the same command ran to completion: ${JSON.stringify(waited).slice(0, 300)}`);
  assert.equal(waited.exit_code, 0, "and exited cleanly");
  assert.match(waited.output ?? "", /second/, "the work after the timeout actually happened");

  const snap = asObject(await callTool("get_process_snapshot", { command_id: slowCommandId }));
  assert.equal(snap.exit_code, 0, "the snapshot agrees");
});

test("force_terminate is a real way out of a command that never exits", async () => {
  const started = asObject(await callTool("run_command", { command: "node forever.mjs", timeout_ms: 2000 }));
  assert.equal(started.timed_out, true, "an endless command times out too");
  assert.equal(started.status, "running");

  // `force_terminate` is the legacy alias the timeout message names; it routes
  // to process_control{action:"terminate"}.
  const killed = await callTool("force_terminate", { command_id: started.command_id });
  assert.equal(killed.isError, false, `the alias still works: ${killed.text.slice(0, 300)}`);

  const snap = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(snap.shell_alive, false, `the shell is gone: ${JSON.stringify(snap).slice(0, 400)}`);
  assert.equal(snap.termination_reason, "terminated", "and the snapshot says why");
});

test("terminate kills a shell tree whose children outlive the shell itself", {
  skip: process.platform !== "win32"
    ? "the atomic tree-kill path is win32-only (taskkill /T); POSIX tree-kill would need process groups"
    : false,
}, async () => {
  // Every loop iteration leaves a `sleep 30` background child that outlives any
  // single kill. The old enumerate-then-kill-each path (PowerShell full process
  // table scan, 1-4 s cold, then sequential taskkills, root LAST) burned the
  // 5 s close budget before the kills landed — and gave the loop a window to
  // respawn in between — so an orphan held the stdio pipes, 'close' never
  // fired, and terminate honestly REFUSED a tree one atomic `taskkill /T /F`
  // handles. Empirically this exact shape refused at ~6 s; pinned live first.
  const started = asObject(await callTool("run_command", {
    command: "while true; do sleep 30 & sleep 1; done",
    background: true,
  }));
  assert.equal(started.status, "running");
  await delay(3500); // let the loop leave a couple of long-lived children behind

  const alive = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(alive.status, "running", "precondition: the bash loop is still running (Git Bash present)");

  const startedAt = Date.now();
  const killed = asObject(await callTool("process_control", { action: "terminate", command_id: started.command_id }));
  const elapsed = Date.now() - startedAt;
  assert.equal(killed.terminated, true,
    `the whole tree terminates inside the budget: ${JSON.stringify(killed).slice(0, 400)}`);
  assert.ok(elapsed < 20_000, `and it took ${elapsed} ms, not minutes`);

  const snap = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(snap.shell_alive, false, "the shell is gone");
});

test("a background command distinguishes no readiness check from a ready process", async () => {
  const started = asObject(await callTool("run_command", { command: "node forever.mjs", background: true }));
  assert.equal(started.status, "running", "background work returns immediately under supervision");
  assert.equal(started.ready, true, "the compatibility ready value is preserved when no pattern was requested");
  assert.equal(started.ready_checked, false, "callers can now distinguish no check from observed readiness");
  assert.ok(typeof started.command_id === "string" && started.command_id.length > 0);
  await callTool("process_control", { action: "terminate", command_id: started.command_id });
});

test("a garbage timeout_ms falls back to the default instead of firing at ~0 ms", async () => {
  // `Number("abc")` is NaN and `setTimeout(cb, NaN)` fires immediately, which
  // used to report a 300 ms command as "still running". The guard in
  // process-tools.ts exists for exactly this; nothing pinned it until now.
  const res = asObject(await callTool("run_command", { command: "node quick.mjs", timeout_ms: "abc" }));
  assert.equal(res.timed_out, false, `a non-numeric timeout must not fire at once: ${JSON.stringify(res).slice(0, 300)}`);
  assert.equal(res.status, "completed", "the command was waited for normally");
  assert.equal(res.exit_code, 0);
  assert.match(res.output ?? "", /done/, "and it really ran to completion");

  const zero = asObject(await callTool("run_command", { command: "node quick.mjs", timeout_ms: -5 }));
  assert.equal(zero.timed_out, false, "a negative timeout falls back too, rather than firing at once");
  assert.match(zero.output ?? "", /done/);
});

// --- harness ---------------------------------------------------------------

function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(20_000) },
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
const jsonHeaders = extra => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});

async function openSession() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: rpcId++, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "process-timeout", version: "1" } },
  }), jsonHeaders());
  const session = res.headers["mcp-session-id"];
  if (session) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": session }));
  }
  return { sessionId: session, body: res.body };
}

/** One tool call, flattened to what these assertions care about. */
async function callTool(name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 200, `tools/call ${name} answered`);
  const payload = lastSsePayload(res.body);
  assert.ok(payload?.result, `tools/call ${name} returned a result`);
  const result = payload.result;
  const text = result.content?.[0]?.text ?? JSON.stringify(result);
  return { isError: result.isError === true, text };
}

/** The tool's own JSON payload, or `{}` when it answered with prose. */
function asObject({ text }) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

test("start_process refuses timeout_ms and names the knob that does apply", async () => {
  // start_process has no timeout_ms. Passing one used to be accepted and then
  // ignored: the caller believed it had widened the wait while the ready loop
  // kept its own 10 s default -- which is how a slow vite/next first build gets
  // reported as "not ready". An argument that silently does nothing is worse
  // than a rejection, and this repo rejects unknown discriminator values for
  // exactly that reason.
  const refused = await callTool("start_process", {
    command: "node forever.mjs",
    ready_pattern: "this never appears",
    timeout_ms: 4000,
  });
  assert.equal(refused.isError, true, "the argument is refused, not ignored");
  assert.match(refused.text, /timeout_ms/, "the refusal says which argument it is about");
  assert.match(refused.text, /ready_timeout_ms/,
    "and names the argument that actually controls the wait");
});

test("ready_timeout_ms is the wait, and a process that misses it is reported, not killed", async () => {
  const startedAt = Date.now();
  const res = asObject(await callTool("start_process", {
    command: "node forever.mjs",
    ready_pattern: "this never appears",
    ready_timeout_ms: 1500,
  }));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1200, `the wait honoured ready_timeout_ms (${elapsed} ms)`);
  assert.ok(elapsed < 8000, `and did not fall back to the 10 s default (${elapsed} ms)`);
  assert.equal(res.ready, false, "the pattern never matched");
  assert.equal(res.ready_checked, true, "the result distinguishes an attempted readiness check from an omitted one");
  assert.equal(res.status, "running", "the process is left running for the caller to poll");
  assert.ok(typeof res.command_id === "string" && res.command_id.length > 0,
    "a command_id comes back either way");
  // An endless process is not a nice thing to leave behind on the machine.
  await callTool("process_control", { action: "terminate", command_id: res.command_id });
});
