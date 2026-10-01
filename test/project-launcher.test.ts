import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const launcher = readFileSync(path.join(root, "scripts/start-open-bridge-project.cmd"), "utf8");
const bootstrap = readFileSync(path.join(root, "scripts/windows/launcher-bootstrap.mjs"), "utf8");
const commands = readFileSync(path.join(root, "src/cli/windows-commands.ts"), "utf8");

test("the project cmd is only a thin Node bootstrap", () => {
  assert.match(launcher, /launcher-bootstrap\.mjs" project/i);
  assert.doesNotMatch(launcher, /npm\s+(?:install|run)/i);
  assert.doesNotMatch(launcher, /open-bridge\.js" serve/i);
  assert.doesNotMatch(launcher, /--root|set "ROOT=|set "PORT=/i);
  assert.match(launcher, /pause/i, "double-click failures remain readable");
  assert.ok(launcher.includes("\r\n"), "the Windows cmd wrapper keeps CRLF line endings");
});

test("project build/start policy lives behind the Node bootstrap and TS command", () => {
  assert.match(bootstrap, /mode === "project" \|\| !distReady/);
  assert.match(bootstrap, /runNpm\(\["run", "build"\]\)/);
  assert.match(bootstrap, /"windows-launch", mode/);
  assert.match(commands, /mode === "project"/);
  assert.match(commands, /flags\.set\("root", packageRoot\)/);
  assert.match(commands, /flags\.set\("port", "8123"\)/);
});
