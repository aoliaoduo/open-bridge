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
  const relay = readFileSync(path.join(scripts, "context-menu-launch.vbs"), "utf8");
  const launcher = readFileSync(path.join(scripts, "context-menu-launch.ps1"), "utf8");
  const uninstall = readFileSync(path.join(scripts, "uninstall-context-menu.ps1"), "utf8");

  assert.match(install, /HKCU:\\Software\\Classes\\Directory\\shell\\OpenBridge/);
  assert.match(install, /HKCU:\\Software\\Classes\\Directory\\Background\\shell\\OpenBridge/);
  assert.match(install, /%1/);
  assert.match(install, /%V/);
  assert.doesNotMatch(install, /HKLM:/i, "installation must not require machine-wide registry writes");
  assert.doesNotMatch(install, /New-ItemProperty[^\n]+Position[^\n]+Top/i, "Open Bridge must not force itself into Explorer's top singleton group");
  assert.match(install, /0x5728, 0x6B64, 0x542F, 0x52A8/, "Windows PowerShell 5.1-safe Unicode code points define the default Chinese label");
  assert.match(install, /SeparatorBefore/, "the developer launcher should be visually separated from Explorer paste commands");
  assert.match(install, /wscript\.exe/, "Explorer should enter through a GUI-subsystem relay instead of flashing a console");
  assert.match(install, /context-menu-launch\.vbs/);
  assert.doesNotMatch(install, /\$command\s*=\s*'powershell\.exe/i, "the registry command must not launch a visible PowerShell console directly");
  assert.match(relay, /shell\.Run\(command, 0, True\)/i, "the PowerShell relay must be launched hidden");
  assert.match(relay, /MsgBox/, "a hidden launcher failure must still be visible to the operator");
  assert.match(relay, /-WindowStyle Hidden/i);
  assert.match(relay, /context-menu-launch\.ps1/);
  assert.match(launcher, /launch --root/);
  assert.match(launcher, /--open-existing/, "reusing an Explorer workspace should open its existing console instead of disappearing silently");
  assert.match(launcher, /--startingDirectory/, "Windows Terminal should start directly in the selected workspace");
  assert.match(launcher, /\$node\.Source/, "the terminal tab should run Node/Open Bridge directly");
  assert.doesNotMatch(launcher, /EncodedCommand/, "the terminal tab must not wrap Open Bridge in an intermediate PowerShell process");
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
