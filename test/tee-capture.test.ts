import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPath, isBashLikeShell, wrapWithTeeAppend } from "../src/process/tee-capture.js";

test("bashPath converts backslashes for Git Bash", () => {
  assert.equal(bashPath("C:\\Users\\x\\f.log"), "C:/Users/x/f.log");
  assert.equal(bashPath("/already/posix"), "/already/posix");
});

test("wrapWithTeeAppend tees merged output and preserves the command exit code", () => {
  const w = wrapWithTeeAppend("npm run build", "C:\\tmp\\id.log");
  assert.ok(w.startsWith("( npm run build ) 2>&1 | tee -a '"));
  assert.ok(w.includes("C:/tmp/id.log"));
  // Exit code comes from the wrapped command, not tee.
  assert.ok(w.endsWith("exit ${PIPESTATUS[0]}"));
});

test("wrapWithTeeAppend escapes single quotes in the capture path", () => {
  const w = wrapWithTeeAppend("cmd", "/tmp/o'b.log");
  assert.ok(w.includes(`'\\''`));
});

test("isBashLikeShell tells bash/sh from PowerShell", () => {
  assert.equal(isBashLikeShell("C:\\Program Files\\Git\\bin\\bash.exe"), true);
  assert.equal(isBashLikeShell("/bin/sh"), true);
  assert.equal(isBashLikeShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), false);
  assert.equal(isBashLikeShell("powershell.exe"), false);
});
