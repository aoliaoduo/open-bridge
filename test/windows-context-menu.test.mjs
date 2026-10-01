import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ROOT } from "./lib/bridge-runtime.mjs";

const run = promisify(execFile);
const scripts = path.join(ROOT, "scripts", "windows");

test("Explorer scripts are thin compatibility/GUI wrappers around the Node adapters", () => {
  const install = readFileSync(path.join(scripts, "install-context-menu.ps1"), "utf8");
  const relay = readFileSync(path.join(scripts, "context-menu-launch.vbs"), "utf8");
  const launcher = readFileSync(path.join(scripts, "context-menu-launch.ps1"), "utf8");
  const uninstall = readFileSync(path.join(scripts, "uninstall-context-menu.ps1"), "utf8");

  assert.match(install, /"explorer", "install"/);
  assert.match(uninstall, /"explorer", "uninstall"/);
  assert.doesNotMatch(install + uninstall, /New-Item|Set-Item|Remove-Item|HKCU:/,
    "registry business logic belongs to the TS reg.exe adapter");
  assert.match(relay, /OPEN_BRIDGE_EXPLORER_WORKSPACE/);
  assert.match(relay, /shell\.CurrentDirectory\s*=\s*packageRoot/,
    "the package path should travel as cwd, not be interpolated into command text");
  assert.match(relay, /command\s*=\s*"node\.exe bin\\open-bridge\.js windows-launch explorer"/i,
    "the GUI relay command line is fixed ASCII");
  assert.doesNotMatch(relay, /powershell\.exe|cmd\.exe|QuoteArg|&\s*entry/i,
    "Explorer's GUI relay should launch Node directly without dynamic command text");
  assert.match(launcher, /OPEN_BRIDGE_EXPLORER_WORKSPACE/);
  assert.match(launcher, /"windows-launch" "explorer"/);
  assert.doesNotMatch(launcher, /wt\.exe|Start-Process|--startingDirectory|--root/,
    "the PowerShell compatibility wrapper must not own launcher behaviour");
});

test("built CLI can dry-run Explorer registration without touching the registry", {
  skip: process.platform !== "win32",
}, async () => {
  const { stdout, stderr } = await run(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "explorer", "install", "--dry-run",
  ], { cwd: ROOT });
  assert.equal(stderr, "");
  assert.match(stdout, /reg\.exe add HKCU\\Software\\Classes\\Directory\\shell\\OpenBridge/);
  assert.match(stdout, /context-menu-launch\.vbs/);
  assert.doesNotMatch(stdout, /powershell\.exe/i);
});

test("legacy PowerShell wrappers still support -WhatIf without side effects", {
  skip: process.platform !== "win32",
}, async () => {
  const common = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
  for (const name of ["install-context-menu.ps1", "uninstall-context-menu.ps1"]) {
    const { stderr } = await run("powershell.exe", [...common, path.join(scripts, name), "-WhatIf"], { cwd: ROOT });
    assert.equal(stderr, "");
  }
  const relayResult = await run("cscript.exe", ["//NoLogo", path.join(scripts, "context-menu-launch.vbs")])
    .then(() => ({ code: 0 }))
    .catch(error => ({ code: error.code }));
  assert.equal(relayResult.code, 2);
});
