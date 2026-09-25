/**
 * send_to_shell appends a completion sentinel line after the caller's
 * command. A command whose last line ends in a line continuation or an
 * incomplete pipe makes bash consume that sentinel as part of the command:
 * the marker never appears, pendingMarker wedges the session, and every
 * later send is refused until the shell is closed. The shape is refused up
 * front instead.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { closeShell, openShell, sendToShell } from "../src/bridge/runtime/shell-sessions.js";
import { state } from "../src/bridge/state.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-shell-cont-"));
  installNodeHost({ homeDir: home, version: "test", projectRoot: home });
  state.commands.clear();
});

afterEach(() => {
  state.commands.clear();
  rmSync(home, { recursive: true, force: true });
});

test("a command ending in a line continuation is refused instead of wedging the session", { timeout: 60_000 }, async () => {
  const opened = await openShell({ name: "cont" }) as { name: string };
  assert.equal(opened.name, "cont");
  try {
    await assert.rejects(
      sendToShell({ name: "cont", command: "true \\", timeout_ms: 1_000 }),
      /sentinel|continuation|续行/i,
    );
    // The session is still usable: the refused input never reached the shell.
    const again = await sendToShell({ name: "cont", command: "echo ok-after-refusal", timeout_ms: 10_000 });
    assert.match(String(again.output), /ok-after-refusal/);
  } finally {
    await closeShell({ name: "cont" });
  }
});

test("backgrounding with a single & is not mistaken for a continuation", { timeout: 60_000 }, async () => {
  await openShell({ name: "bg" });
  try {
    const result = await sendToShell({ name: "bg", command: "true &", timeout_ms: 10_000 });
    assert.equal(result.timed_out, false, "a background job still completes and reports the sentinel");
  } finally {
    await closeShell({ name: "bg" });
  }
});
