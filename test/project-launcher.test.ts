import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const launcher = readFileSync(path.join(process.cwd(), "scripts/start-open-bridge-project.cmd"), "utf8");
const run = promisify(execFile);

test("the dedicated project launcher fixes both workspace and port", () => {
  assert.match(launcher, /cd \/d "%~dp0\.\."/);
  assert.match(launcher, /set "ROOT=%CD%"/);
  assert.match(launcher, /set "PORT=8123"/);
  assert.match(launcher, /serve --port %PORT%(?:\r?\n|\r)/);
  assert.doesNotMatch(launcher, /--root "%ROOT%"/,
    "the repository is already cwd; re-encoding it into native argv breaks drive roots/trailing backslashes");
  assert.match(launcher, /chcp 65001 >nul/i, "Unicode repository paths must survive cmd output and child launch");
  assert.doesNotMatch(launcher, /echo\s+workspace\s*:\s*%ROOT%/i,
    "repo paths with cmd metacharacters must not be echoed unquoted");
  assert.doesNotMatch(launcher, /--open/, "the launcher must not open a browser");
  assert.doesNotMatch(launcher, /set \/p /i, "this launcher must not ask for a workspace");
  assert.doesNotMatch(launcher, /%\*/, "arguments must not override the fixed root or port");
});

test("the launcher builds current source and leaves startup errors readable", () => {
  assert.match(launcher, /call npm run build/);
  assert.match(launcher, /if errorlevel 1 goto failed/);
  assert.match(launcher, /pause/);
  assert.ok(launcher.includes("\r\n"), "a double-clicked Windows cmd file keeps CRLF line endings");
});

test("the project launcher survives a Unicode/metacharacter repository path on Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const tempParent = path.join(tmpdir(), "ob-project-launcher-" + process.pid);
  const root = path.join(tempParent, "中文 repo & (x) ! 100%");
  const scripts = path.join(root, "scripts");
  const fakeBin = path.join(tempParent, "fake-bin");
  const probe = path.join(tempParent, "probe.txt");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}");
  copyFileSync(path.join(process.cwd(), "scripts/start-open-bridge-project.cmd"), path.join(scripts, "start-open-bridge-project.cmd"));
  writeFileSync(path.join(fakeBin, "npm.cmd"), "@echo off\r\nexit /b 0\r\n");
  writeFileSync(path.join(fakeBin, "node.cmd"), [
    "@echo off",
    "> \"%OB_PROBE_OUT%\" echo cwd=\"%CD%\"",
    ">> \"%OB_PROBE_OUT%\" echo args=%*",
    "exit /b 0",
    "",
  ].join("\r\n"));

  try {
    const script = path.join(scripts, "start-open-bridge-project.cmd");
    // Invoke CALL as argv, not by generating a UTF-8 .cmd wrapper containing
    // the Unicode path. cmd parses a batch file before the launcher's own
    // `chcp 65001` can run, so such a wrapper tests the host code page rather
    // than the launcher. CALL also keeps &, parentheses and % inside argv.
    const result = await run("cmd.exe", ["/d", "/s", "/c", "call", script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: fakeBin + ";" + process.env.PATH,
        OB_PROBE_OUT: probe,
      },
    });
    assert.equal(result.stderr, "");
    const captured = readFileSync(probe, "utf8");
    const cwdLine = captured.split(/\r?\n/).find(line => line.startsWith("cwd=")) ?? "";
    assert.equal(path.resolve(cwdLine.slice(4).replace(/^"|"$/g, "")), path.resolve(root));
    assert.match(captured, /serve --port 8123/);
    assert.doesNotMatch(captured, /--root/);
  } finally {
    rmSync(tempParent, { recursive: true, force: true });
  }
});
