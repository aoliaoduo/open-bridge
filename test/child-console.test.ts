import assert from "node:assert/strict";
import test from "node:test";
import {processHasConsole, windowsHideForChild} from "../src/bridge/child-console.js";

/**
 * A console window close terminates exactly the processes attached to that
 * console (measured with AttachConsole + GetConsoleProcessList on Windows 10).
 * A hidden child gets its OWN console, so it survived the window that started
 * it and kept the ngrok domain reserved; long-lived children must therefore
 * share our console whenever we have one.
 */
test("a long-lived child shares our console when we have one", () => {
  assert.equal(windowsHideForChild(true), false, "windowsHide must be off inside a terminal");
});

test("without a console of our own the child is hidden", () => {
  assert.equal(windowsHideForChild(false), true, "no console to share: hide the window");
});

test("the console probe is safe to call and always answers a boolean", () => {
  // The default argument path: under a test runner both streams are pipes, so
  // this reads as "no console" — the assertion only pins the shape.
  assert.equal(typeof processHasConsole(), "boolean");
  assert.equal(typeof windowsHideForChild(), "boolean");
});
