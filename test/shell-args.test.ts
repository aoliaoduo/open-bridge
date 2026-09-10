import assert from "node:assert/strict";
import test from "node:test";
import { defaultShellArgs } from "../src/shell/shell-args.js";

test("Git Bash receives its command through -lc", () => {
  assert.deepEqual(defaultShellArgs("C:/Program Files/Git/bin/bash.exe"), ["-lc"]);
});

test("PowerShell uses a non-profile command invocation", () => {
  assert.deepEqual(defaultShellArgs("pwsh.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
});
