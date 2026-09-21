import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const launcher = readFileSync(path.join(process.cwd(), "scripts/start-open-bridge-project.cmd"), "utf8");

test("the dedicated project launcher fixes both workspace and port", () => {
  assert.match(launcher, /cd \/d "%~dp0\.\."/);
  assert.match(launcher, /set "ROOT=%CD%"/);
  assert.match(launcher, /set "PORT=8123"/);
  assert.match(launcher, /serve --root "%ROOT%" --port %PORT%(?:\r?\n|\r)/);
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
