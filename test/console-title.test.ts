/**
 * Unit tests for the console-title pin (src/bridge/console-title.ts).
 *
 * The property under test is deliberately dull: whatever a child writes into the
 * shared console title, this instance can put its own back — and it never touches
 * a window it does not own (no console), nor fails a server because a cosmetic
 * call threw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TITLE_PREFIX, buildServeTitle, clearServeConsoleTitle, installServeConsoleTitle, reassertServeConsoleTitle,
} from "../src/bridge/console-title.js";

test("the title says what the window is and which workspace it serves", () => {
  assert.equal(buildServeTitle("open-bridge-app", 18080), "Open Bridge - open-bridge-app (:18080)");
  assert.equal(buildServeTitle("  spaced  ", 18080), "Open Bridge - spaced (:18080)");
  assert.equal(buildServeTitle("", 0), "Open Bridge - workspace", "an unknown name still gets a title");
});

test("the title is ASCII: a console renders it in its own codepage", () => {
  const title = buildServeTitle("workspace", 1234);
  assert.ok([...title].every(ch => ch.codePointAt(0)! < 128), title);
  assert.ok(title.startsWith(TITLE_PREFIX));
});

test("claiming writes immediately and can be re-claimed after a clobber", () => {
  const writes: string[] = [];
  const claimed = installServeConsoleTitle(buildServeTitle("ws", 18080), { set: v => writes.push(v), hasConsole: true });
  assert.equal(claimed, true, "the instance owns the console");
  assert.deepEqual(writes, ["Open Bridge - ws (:18080)"]);

  // A child (cmd.exe, npm) writes its own title...
  writes.push("C:\\Windows\\system32\\cmd.exe");
  // ...and the instance takes the window back.
  reassertServeConsoleTitle(v => writes.push(v));
  assert.equal(writes[writes.length - 1], "Open Bridge - ws (:18080)");
  clearServeConsoleTitle();
});

test("a process without a console never touches a title", () => {
  const writes: string[] = [];
  const claimed = installServeConsoleTitle(buildServeTitle("ws", 18080), { set: v => writes.push(v), hasConsole: false });
  assert.equal(claimed, false);
  reassertServeConsoleTitle(v => writes.push(v));
  assert.deepEqual(writes, [], "a service or CI run must stay silent");
});

test("re-claiming is a no-op before any claim, and after clearing", () => {
  const writes: string[] = [];
  clearServeConsoleTitle();
  reassertServeConsoleTitle(v => writes.push(v));
  assert.deepEqual(writes, []);

  installServeConsoleTitle(buildServeTitle("ws", 1), { set: () => undefined, hasConsole: true });
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
