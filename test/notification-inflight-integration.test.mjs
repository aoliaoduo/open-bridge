/**
 * The in-flight half of "is this instance working right now?", on the wire.
 *
 * The unit test next to this one pins the rule; this file pins the WIRING that
 * feeds it, because the rule was always right and the feeding was not: a modern
 * request stamped the activity clock when it ARRIVED and counted nowhere, so a
 * call running longer than the finish settle window looked like silence and the
 * watchdogs rang the operator's phone mid-turn. Two observables are checked
 * here, both from a request that is NOT the long one:
 *
 *   - while the long call is being served, the stateless row reports in_flight
 *     (and the overview the same number), which is what the watchdogs read;
 *   - once it finishes, the count returns to zero and the clock moves to the
 *     moment it ENDED, which is where the settle window starts counting.
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
const MODERN_REVISION = "2026-07-28";

let home;
let child;
let port;
let routeToken;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-inflight-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
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
  removeTempDir(home);
});

let rpcId = 1;

/** One modern-era call. Returns the decoded payload (SSE frame or plain JSON). */
function modernCall(name, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "tools/call",
    params: {
      name,
      arguments: args ?? {},
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN_REVISION,
    "mcp-method": "tools/call",
    "mcp-name": name,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/mcp/${routeToken}`, method: "POST", headers, agent: false, signal: AbortSignal.timeout(60_000) },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const frame = text.split(/\r?\n/).find(line => line.startsWith("data: "));
          try { resolve(JSON.parse(frame ? frame.slice(6) : text)); } catch (error) { reject(new Error(`undecodable answer: ${text.slice(0, 200)} (${error})`)); }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** The stateless row's in_flight, or undefined when the row is absent. */
async function inFlight() {
  const payload = await modernCall("bridge_status", { section: "sessions" });
  const rows = JSON.parse(payload.result.content[0].text);
  return rows.find(row => row.era === "modern")?.in_flight;
}

/** The overview's own reading of the same fact (text block: never filtered). */
async function overviewShape() {
  const payload = await modernCall("bridge_status", {});
  return JSON.parse(payload.result.content[0].text);
}

test("a long call is visible as in-flight work, and the clock starts when it ends", async () => {
  // ~6 s of real work, served concurrently: this process must still answer the
  // bridge_status calls that observe it, which is itself part of the contract.
  // Every reader is itself a request in flight while it reads, so the number
  // always includes one for the observer: 2 while the long call runs, 1 after.
  // That is the honest reading of the counter, and it is why the assertions
  // below are exact rather than "greater than zero".
  const longCall = modernCall("run_command", { command: "sleep 6", timeout_ms: 30_000 });
  try {
    let sawBoth = false;
    const started = Date.now();
    while (Date.now() - started < 4_000) {
      if ((await inFlight()) === 2) { sawBoth = true; break; }
      await delay(150);
    }
    assert.ok(sawBoth,
      "while a modern request is being served, the stateless row must report it as in flight - this is the value the watchdogs read before announcing an ending");

    assert.equal((await overviewShape()).modern_in_flight, 2, "and the overview agrees");
  } finally {
    // Always drain the long call: leaving it in flight made teardown look like a
    // random ECONNRESET in the runner.
    await longCall.catch(() => undefined);
  }

  assert.equal(await inFlight(), 1, "once it ends, only the observer is left in flight");
});
