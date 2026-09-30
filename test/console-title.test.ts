/**
 * Unit tests for the console-title pin (src/bridge/lifecycle/console-title.ts).
 *
 * The property under test is deliberately dull: whatever a child writes into the
 * shared console title, this instance can put its own back — and it never touches
 * a window it does not own (no console), nor fails a server because a cosmetic
 * call threw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildServeTitle, clearServeConsoleTitle, installServeConsoleTitle, reassertServeConsoleTitle,
} from "../src/bridge/lifecycle/console-title.js";

test("the title is exactly the workspace directory name", () => {
  assert.equal(buildServeTitle("open-bridge"), "open-bridge");
  assert.equal(buildServeTitle("  spaced  "), "spaced");
  assert.equal(buildServeTitle(""), "workspace", "an unknown name still gets a title");
});

test("claiming writes immediately and can be re-claimed after a clobber", () => {
  const writes: string[] = [];
  const claimed = installServeConsoleTitle(buildServeTitle("ws"), { set: v => writes.push(v), hasConsole: true });
  assert.equal(claimed, true, "the instance owns the console");
  assert.deepEqual(writes, ["ws"]);

  // A child (cmd.exe, npm) writes its own title...
  writes.push("C:\\Windows\\system32\\cmd.exe");
  // ...and the instance takes the window back.
  reassertServeConsoleTitle(v => writes.push(v));
  assert.equal(writes[writes.length - 1], "ws");
  clearServeConsoleTitle();
});

test("a process without a console never touches a title", () => {
  const writes: string[] = [];
  const claimed = installServeConsoleTitle(buildServeTitle("ws"), { set: v => writes.push(v), hasConsole: false });
  assert.equal(claimed, false);
  reassertServeConsoleTitle(v => writes.push(v));
  assert.deepEqual(writes, [], "a service or CI run must stay silent");
});

test("re-claiming is a no-op before any claim, and after clearing", () => {
  const writes: string[] = [];
  clearServeConsoleTitle();
  reassertServeConsoleTitle(v => writes.push(v));
  assert.deepEqual(writes, []);

  installServeConsoleTitle(buildServeTitle("ws"), { set: () => undefined, hasConsole: true });
  clearServeConsoleTitle();
  reassertServeConsoleTitle(v => writes.push(v));
  assert.deepEqual(writes, [], "a stopping instance does not fight for the title");
});

test("a failing title write cannot take the server down", () => {
  const boom = (): never => { throw new Error("no console handle"); };
  assert.doesNotThrow(() => installServeConsoleTitle("t", { set: boom, hasConsole: true }));
  assert.doesNotThrow(() => reassertServeConsoleTitle(boom));
  clearServeConsoleTitle();
});
