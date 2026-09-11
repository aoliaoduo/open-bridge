/**
 * Unit tests for the self-stop guard (see src/bridge/stop-guard.ts): the marker
 * a serving process stamps into its children, and the exact conditions under
 * which `stop` refuses to kill the instance that issued the command.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HOST_PID_ENV, markHostProcess, selfStopRefusal } from "../src/bridge/stop-guard.js";

const CONSOLE = "http://127.0.0.1:18080/console/";

test("markHostProcess stamps the pid for the children to inherit", () => {
  const env: NodeJS.ProcessEnv = {};
  markHostProcess(env, 4242);
  assert.equal(env[HOST_PID_ENV], "4242");
});

test("a stop issued from inside the hosting instance is refused, with the way out", () => {
  const env: NodeJS.ProcessEnv = {};
  markHostProcess(env, 4242);
  const refusal = selfStopRefusal(env, 4242, CONSOLE);
  assert.ok(refusal, "refusing is the whole point");
  assert.match(refusal, /拒绝停止 pid 4242/);
  assert.match(refusal, /--force/, "the refusal must name the override");
  assert.match(refusal, /http:\/\/127\.0\.0\.1:18080\/console\//, "and where the console is");
});

test("a human terminal and other instances are never blocked", () => {
  assert.equal(selfStopRefusal({}, 4242, CONSOLE), null, "no marker at all");
  const other = { [HOST_PID_ENV]: "99" };
  assert.equal(selfStopRefusal(other, 4242, CONSOLE), null, "marker of a different instance");
});

test("a marker that is not a pid cannot block a real stop", () => {
  for (const bogus of ["", "abc", "0", "-1", "4242.5", " 4242"]) {
    assert.equal(selfStopRefusal({ [HOST_PID_ENV]: bogus }, 4242, CONSOLE), null, JSON.stringify(bogus));
  }
});
