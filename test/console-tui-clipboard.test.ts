import assert from "node:assert/strict";
import { test } from "node:test";

import { clipboardCommands, clipboardInput, copyTextToClipboard, type ClipboardCommand } from "../src/console/tui/clipboard.js";

test("clipboard command selection is platform-native and WSL-aware", () => {
  assert.deepEqual(clipboardCommands("win32", {}), [{ file: "clip.exe", args: [], inputEncoding: "utf16le" }]);
  assert.deepEqual(clipboardCommands("darwin", {}), [{ file: "pbcopy", args: [], inputEncoding: "utf8" }]);
  assert.equal(clipboardCommands("linux", {}).at(0)?.file, "wl-copy");
  assert.deepEqual(clipboardCommands("linux", { WSL_DISTRO_NAME: "Ubuntu" }).at(0), {
    file: "clip.exe",
    args: [],
    inputEncoding: "utf16le",
  });
  assert.deepEqual(clipboardCommands("freebsd", {}), []);
});

test("Windows clip.exe receives UTF-16LE so CJK text is independent of the console code page", () => {
  const command = clipboardCommands("win32", {}).at(0);
  assert.ok(command);
  const text = "连接这个 MCP，复制提示词";
  assert.deepEqual(clipboardInput(command, text), Buffer.from(text, "utf16le"));
  assert.notDeepEqual(clipboardInput(command, text), Buffer.from(text, "utf8"));
});

test("clipboard copy falls back across Linux helpers and preserves text exactly", async () => {
  const attempts: ClipboardCommand[] = [];
  const payloads: string[] = [];
  await copyTextToClipboard("line 1\nline 2", {
    platform: "linux",
    env: {},
    run: async (command, text) => {
      attempts.push(command);
      payloads.push(text);
      if (command.file !== "xclip") throw new Error("fixture missing helper");
    },
  });
  assert.deepEqual(attempts.map(command => command.file), ["wl-copy", "xclip"]);
  assert.deepEqual(payloads, ["line 1\nline 2", "line 1\nline 2"]);
});

test("clipboard copy rejects empty text and unsupported platforms before spawning", async () => {
  let calls = 0;
  const run = async (): Promise<void> => { calls += 1; };
  await assert.rejects(copyTextToClipboard("", { platform: "win32", run }), /empty/i);
  await assert.rejects(copyTextToClipboard("x", { platform: "freebsd", run }), /supported system clipboard/i);
  assert.equal(calls, 0);
});
