import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ROOT } from "./lib/bridge-runtime.mjs";

const run = promisify(execFile);
const scripts = path.join(ROOT, "scripts", "windows");

test("Explorer integration stays per-user and delegates workspace semantics to launch", () => {
  const install = readFileSync(path.join(scripts, "install-context-menu.ps1"), "utf8");
  const launcher = readFileSync(path.join(scripts, "context-menu-launch.ps1"), "utf8");
  const uninstall = readFileSync(path.join(scripts, "uninstall-context-menu.ps1"), "utf8");

  assert.match(install, /HKCU:\\Software\\Classes\\Directory\\shell\\OpenBridge/);
  assert.match(install, /HKCU:\\Software\\Classes\\Directory\\Background\\shell\\OpenBridge/);
  assert.match(install, /%1/);
  assert.match(install, /%V/);
  assert.doesNotMatch(install, /HKLM:/i, "installation must not require machine-wide registry writes");
  assert.match(launcher, /launch --root/);
  assert.match(launcher, /EncodedCommand/, "workspace paths should not be interpolated into a raw shell command line");
  assert.match(uninstall, /Remove-Item/);
});

test("Windows context-menu scripts parse and dry-run without touching the registry or opening a terminal", {
  skip: process.platform !== "win32",
}, async () => {
  const powershell = "powershell.exe";
  const common = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
  for (const name of ["install-context-menu.ps1", "uninstall-context-menu.ps1"]) {
    const { stderr } = await run(powershell, [...common, path.join(scripts, name), "-WhatIf"], { cwd: ROOT });
    assert.equal(stderr, "", `${name} should dry-run cleanly`);
  }
  const { stdout, stderr } = await run(powershell, [
    ...common,
    path.join(scripts, "context-menu-launch.ps1"),
    "-Path",
    ROOT,
    "-WhatIf",
  ], { cwd: ROOT });
  assert.equal(stderr, "");
  assert.match(stdout, /What\s*If:/i, "launcher dry-run reaches the terminal-spawn boundary without spawning it");
});
