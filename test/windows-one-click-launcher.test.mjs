import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { ROOT } from "./lib/bridge-runtime.mjs";

const run = promisify(execFile);
const launcher = path.join(ROOT, "scripts", "start-open-bridge.cmd");

test("one-click launcher resolves workspace through cwd instead of a lossy --root argv", () => {
  const source = readFileSync(launcher, "utf8");
  assert.doesNotMatch(source, /--root\s+"%WORKSPACE%"/i);
  assert.match(source, /pushd "%WORKSPACE%"/i);
  assert.ok(source.includes('node "%REPO_DIR%\\bin\\open-bridge.js" serve %*'));
  assert.match(source, /chcp 65001 >nul/i,
    "launcher should preserve Unicode workspace paths through cmd redirection");
  assert.doesNotMatch(source, /echo\s+%WORKSPACE%/i,
    "workspace text must not be reparsed by cmd metacharacter rules");
  assert.match(source, /set \/p "=%WORKSPACE%"/i,
    "last-workspace persistence must keep metacharacters inside a quoted SET command");
});

test("one-click launcher preserves drive roots, special-character cwd and extra CLI flags", {
  skip: process.platform !== "win32",
}, async () => {
  const temp = path.join(tmpdir(), "ob-cmd-launcher-" + process.pid);
  const fakeBin = path.join(temp, "bin");
  const special = path.join(temp, "中文 space & (x)");
  const probe = path.join(temp, "probe.txt");
  const lastDir = path.join(ROOT, "start-open-bridge.last-dir");
  const previousLastDir = existsSync(lastDir) ? readFileSync(lastDir) : null;
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(special, { recursive: true });
  writeFileSync(path.join(fakeBin, "node.cmd"), [
    "@echo off",
    "> \"%OB_PROBE_OUT%\" echo cwd=\"%CD%\"",
    ">> \"%OB_PROBE_OUT%\" echo args=%*",
    "exit /b 0",
    "",
  ].join("\r\n"));

  const env = {
    ...process.env,
    PATH: fakeBin + ";" + process.env.PATH,
    OB_PROBE_OUT: probe,
  };
  try {
    for (const workspace of [special, path.parse(ROOT).root]) {
      const result = await run("cmd.exe", ["/d", "/c", launcher, workspace, "--open"], {
        cwd: ROOT,
        env,
      });
      assert.equal(result.stderr, "");
      const captured = readFileSync(probe, "utf8");
      const cwdLine = captured.split(/\r?\n/).find(line => line.startsWith("cwd=")) ?? "";
      const actualCwd = cwdLine.slice(4).replace(/^"|"$/g, "");
      assert.equal(path.resolve(actualCwd), path.resolve(workspace));
      assert.match(captured, /--open/);
      assert.doesNotMatch(captured, /--root/i);
    }
  } finally {
    if (previousLastDir === null) rmSync(lastDir, { force: true });
    else writeFileSync(lastDir, previousLastDir);
    rmSync(temp, { recursive: true, force: true });
  }
});
