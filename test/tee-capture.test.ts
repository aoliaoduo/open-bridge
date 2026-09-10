import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { bashPath, isBashLikeShell, tailCommandForShell, visibleCaptureDir, visibleCapturePath, wrapWithTee } from "../src/process/tee-capture.js";

test("capture path lives under the temp dir and is keyed by command id", () => {
  const p = visibleCapturePath("abc123");
  assert.equal(path.dirname(p), visibleCaptureDir());
  assert.equal(path.basename(p), "abc123.log");
  assert.notEqual(visibleCapturePath("a"), visibleCapturePath("b"));
});

test("bashPath converts backslashes for Git Bash", () => {
  assert.equal(bashPath("C:\\Users\\x\\f.log"), "C:/Users/x/f.log");
  assert.equal(bashPath("/already/posix"), "/already/posix");
});

test("wrapWithTee tees merged output and preserves the command exit code", () => {
  const w = wrapWithTee("npm run build", "C:\\tmp\\id.log");
  assert.ok(w.startsWith("( npm run build ) 2>&1 | tee '"));
  assert.ok(w.includes("C:/tmp/id.log"));
  // Exit code comes from the wrapped command, not tee.
  assert.ok(w.endsWith("exit ${PIPESTATUS[0]}"));
});

test("wrapWithTee escapes single quotes in the capture path", () => {
  const w = wrapWithTee("cmd", "/tmp/o'b.log");
  assert.ok(w.includes(`'\\''`));
});

test("isBashLikeShell tells bash/sh from PowerShell", () => {
  assert.equal(isBashLikeShell("C:\\Program Files\\Git\\bin\\bash.exe"), true);
  assert.equal(isBashLikeShell("/bin/sh"), true);
  assert.equal(isBashLikeShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), false);
  assert.equal(isBashLikeShell("powershell.exe"), false);
});

test("tailCommandForShell picks tail for bash and Get-Content for PowerShell", () => {
  assert.equal(tailCommandForShell("C:\\Git\\bin\\bash.exe", "C:\\tmp\\a.log"), "tail -f 'C:/tmp/a.log'");
  assert.equal(tailCommandForShell("pwsh.exe", "C:\\tmp\\a.log"), "Get-Content -Wait -Path 'C:\\tmp\\a.log'");
});
