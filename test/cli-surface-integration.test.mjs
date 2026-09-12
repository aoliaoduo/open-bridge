/**
 * The CLI's own surface, driven as a user drives it — the part of this project
 * that has no test until something bites.
 *
 * The case that prompted this file: `open-bridge serve --help` started a real
 * server. Dispatch handed the flag to cmdServe, nothing there read it, and the
 * "just show me the usage" command published a listener, a runtime record and a
 * public URL. It was found by walking a process's parent chain back to the
 * script that ran it, hours later.
 *
 * So the assertions are deliberately about the absence of side effects: the
 * command must exit on its own, and its temporary data directory must still be
 * empty afterwards.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CLI = path.join(ROOT, "bin", "open-bridge.js");

/** Run the CLI to completion; fail loudly instead of hanging the suite. */
function runCli(args, home, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, OPEN_BRIDGE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`\`open-bridge ${args.join(" ")}\` did not exit within ${timeoutMs} ms — something started a server`));
    }, timeoutMs);
    child.once("exit", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", reject);
  });
}

function freshHome() {
  return mkdtempSync(path.join(tmpdir(), "ob-cli-surface-"));
}

test("serve --help prints the serve usage and starts nothing", async () => {
  const home = freshHome();
  try {
    const { code, stdout, stderr } = await runCli(["serve", "--help"], home);
    assert.equal(code, 0, "asking for help is not an error");
    assert.match(stdout, /open-bridge serve — 启动一个实例/, "the serve-specific usage is printed");
    assert.match(stdout, /--no-tunnel/, "the flags are listed");
    assert.deepEqual(readdirSync(home), [],
      "no runtime record, no serve lock, no secrets: help touched nothing on disk");
    assert.equal(stderr, "", "and it said nothing on stderr");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve -h is the same promise as --help", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["serve", "-h"], home);
    assert.equal(code, 0);
    assert.match(stdout, /open-bridge serve — 启动一个实例/);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the global help still describes every command it advertises", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["--help"], home);
    assert.equal(code, 0);
    // The usage groups several commands per line (`open-bridge stop | status | …`),
    // so the assertion is about the name being present at all.
    for (const command of ["serve", "stop", "status", "instances", "logs", "health", "prompt", "config", "token", "doctor", "version"]) {
      assert.ok(stdout.includes(command), `${command} is listed`);
    }
    assert.deepEqual(readdirSync(home), [], "help is a read-only command");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown command fails loudly instead of quietly starting something", async () => {
  const home = freshHome();
  try {
    const { code, stdout, stderr } = await runCli(["definitely-not-a-command"], home);
    assert.notEqual(code, 0, "a typo is an error");
    assert.match(stdout + stderr, /definitely-not-a-command|用法|unknown/i, "and the message mentions what was typed or how to get help");
    assert.deepEqual(readdirSync(home), [], "nothing was launched to find that out");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
