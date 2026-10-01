import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { ROOT } from "./lib/bridge-runtime.mjs";

const run = promisify(execFile);
const launcher = path.join(ROOT, "scripts", "start-open-bridge.cmd");
const source = readFileSync(launcher, "utf8");

test("one-click cmd is a no-data double-click bootstrap", () => {
  assert.match(source, /launcher-bootstrap\.mjs" one-click/i);
  assert.match(source, /does not accept workspace paths or flags/i);
  assert.match(source, /open-bridge launch --root/i);
  assert.doesNotMatch(source, /OPEN_BRIDGE_ONE_CLICK|pushd\s+|--root\s+"%|npm\s+(?:install|run)|set \/p|serve\s+%\*/i);
  assert.ok(source.includes("\r\n"));
});

test("Node bootstrap forwards direct argv without cmd expansion", async () => {
  const temp = path.join(tmpdir(), "ob-bootstrap-argv-" + process.pid);
  const scripts = path.join(temp, "scripts", "windows");
  const bin = path.join(temp, "bin");
  const output = path.join(temp, "argv.json");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(temp, "node_modules"), { recursive: true });
  mkdirSync(path.join(temp, "dist", "ui"), { recursive: true });
  writeFileSync(path.join(temp, "dist", "cli.js"), "");
  writeFileSync(path.join(temp, "dist", "ui", "console.html"), "");
  writeFileSync(
    path.join(scripts, "launcher-bootstrap.mjs"),
    readFileSync(path.join(ROOT, "scripts", "windows", "launcher-bootstrap.mjs")),
  );
  writeFileSync(
    path.join(scripts, "launcher-build.mjs"),
    readFileSync(path.join(ROOT, "scripts", "windows", "launcher-build.mjs")),
  );
  writeFileSync(path.join(bin, "open-bridge.js"), [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.OB_PROBE_OUT, JSON.stringify(process.argv.slice(2)));",
    "",
  ].join("\n"));

  const special = String.raw`C:\中文 space & (x) ! %OB_LITERAL%`;
  try {
    const { stderr } = await run(process.execPath, [
      path.join(scripts, "launcher-bootstrap.mjs"),
      "one-click",
      special,
      "--open",
      "--port",
      "19000",
    ], {
      cwd: temp,
      env: { ...process.env, OB_PROBE_OUT: output, OB_LITERAL: "EXPANDED" },
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [
      "windows-launch", "one-click", special, "--open", "--port", "19000",
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("cmd wrapper rejects argument-bearing use instead of corrupting legal percent paths", {
  skip: process.platform !== "win32",
}, async () => {
  const literal = String.raw`C:\work\%OB_LITERAL% & (x)`;
  const result = await run("cmd.exe", ["/d", "/c", launcher, literal], {
    cwd: ROOT,
    env: { ...process.env, OB_LITERAL: "EXPANDED" },
  }).then(
    value => ({ code: 0, stdout: value.stdout, stderr: value.stderr }),
    error => ({
      code: typeof error.code === "number" ? error.code : -1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    }),
  );
  assert.equal(result.code, 2);
  assert.match(result.stdout, /does not accept workspace paths or flags/i);
  assert.match(result.stdout, /open-bridge launch --root/i);
  assert.equal(result.stderr, "");
});
