/**
 * Teardown-order integration test.
 *
 * Both surfaces that end the process — the console's Stop action and
 * /api/shutdown — must deliver their response BEFORE the listener goes away.
 * The response travels over the very socket that stopping closes, so writing it
 * afterwards reaches the caller as ECONNRESET with no body: the console's Stop
 * button reported a failure for a stop that had in fact succeeded, and left the
 * operator with no explanation of what just happened.
 *
 * Lives in its own file because it consumes the process: the main integration
 * suite still needs a live instance for its own /api/shutdown test.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {mkdtempSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {startBridge, stopServe} from "./lib/bridge-runtime.mjs";

let home;
let child;
let port;
let routeToken;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-teardown-test-"));
  ({ child, port, routeToken } = await startBridge({ root: home, home }));
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
});

test("the console's stop action answers before the listener goes away", async () => {
  const exit = new Promise(resolve => child.on("exit", resolve));

  const res = await fetch(`http://127.0.0.1:${port}/api/settings/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-open-bridge-console": routeToken },
    body: JSON.stringify({ command: "stop" }),
  });

  // The assertion that fails on the old ordering: no status line at all.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.state.running, false, "the response describes the outcome, not the stale snapshot");
  assert.equal(body.state.mcpUrl, "", "no endpoint is advertised once stopped");
  assert.match(body.info, /已停止/);

  // Stopping is meant to end the process, not to leave a listener-less zombie.
  const code = await exit;
  assert.equal(code, 0, `serve exited ${code}`);
});
