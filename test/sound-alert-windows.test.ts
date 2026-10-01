import assert from "node:assert/strict";
import { test } from "node:test";

import { playerCommand } from "../src/bridge/tools/sound-alert.js";

test("Windows sound paths are hidden from cmd parsing inside EncodedCommand", () => {
  const file = String.raw`C:\alerts\100%REAL_ENV% & (x)\it's done.mp3`;
  const player = playerCommand(file, "win32");
  assert.ok(player);
  assert.equal(player.command, "powershell");
  assert.ok(player.args.includes("-EncodedCommand"));
  assert.equal(player.args.includes("-Command"), false);

  const encoded = player.args.at(-1) ?? "";
  assert.doesNotMatch(encoded, /[%&()']/,
    "Base64 payload must not expose cmd metacharacters from the configured path");

  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /100%REAL_ENV% & \(x\)/);
  assert.match(script, /it''s done\.mp3/,
    "PowerShell single-quoted path keeps its own quote escaping inside the encoded payload");
});

test("non-Windows sound players keep direct argv paths", () => {
  assert.deepEqual(playerCommand("/tmp/a b.wav", "darwin"), {
    command: "afplay",
    args: ["/tmp/a b.wav"],
  });
  assert.deepEqual(playerCommand("/tmp/a b.wav", "linux"), {
    command: "paplay",
    args: ["/tmp/a b.wav"],
  });
});
