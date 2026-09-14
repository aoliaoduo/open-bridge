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
import {mkdirSync, mkdtempSync, readdirSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CLI = path.join(ROOT, "bin", "open-bridge.js");

/** Run the CLI to completion; fail loudly instead of hanging the suite. */
function runCli(args, home, timeoutMs = 20_000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, OPEN_BRIDGE_HOME: home, ...extraEnv },
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
    removeTempDir(home);
  }
});

/**
 * A TZ the runtime cannot resolve costs nothing at startup and everything when
 * reading logs: Node just runs in UTC, so on a UTC+8 desk every line reads
 * eight hours stale. This actually happened here — `export TZ=CST-8` in
 * ~/.bashrc, a POSIX-style value ICU does not know. doctor exists to catch
 * environment faults like this, so it has to say so out loud.
 */
test("a POSIX TZ is repaired to the right offset, and doctor still says it is a workaround", async () => {
  const home = freshHome();
  try {
    // POSIX inverts the sign: CST-8 means UTC+8.
    const { stdout } = await runCli(["doctor"], home, 20_000, { TZ: "CST-8" });
    assert.match(stdout, /\[OK\][^\n]*timezone/, "the clock is no longer silently UTC");
    assert.match(stdout, /Etc\/GMT-8/, "mapped onto the zone with the same inverted-sign convention");
    assert.match(stdout, /\+08:00/, "and the resolved offset is spelled out, so the reader can check it");
    assert.match(stdout, /夏令时|TZ/, "the message still points at the environment as the real fix");
  } finally {
    removeTempDir(home);
  }
});

test("a TZ too odd to map is left alone and reported as a failure", async () => {
  const home = freshHome();
  try {
    // A half-hour offset has no Etc/GMT* equivalent, so guessing would trade a
    // visibly wrong clock for a quietly wrong one. It must stay a failure.
    const { stdout } = await runCli(["doctor"], home, 20_000, { TZ: "IST-5:30" });
    assert.match(stdout, /\[!!\][^\n]*timezone/, "an unresolvable zone is a failure, not a pass");
    assert.match(stdout, /IST-5:30/, "the offending value is quoted back");
    assert.match(stdout, /Asia\/Shanghai/, "and a valid IANA name is suggested");
  } finally {
    removeTempDir(home);
  }
});

test("asking for UTC and getting UTC is not a failure", async () => {
  const home = freshHome();
  try {
    // The check above cannot be "the offset is zero", because that is also the
    // right answer for someone who deliberately runs in UTC -- servers do. The
    // failure is a TZ asking for one offset and silently getting another, so
    // the two cases are told apart by what TZ asked for, not by the offset.
    // Without this the fix would report every UTC machine as broken, which is
    // most CI runners, including the one that caught the original bug.
    const { stdout } = await runCli(["doctor"], home, 20_000, { TZ: "UTC" });
    assert.match(stdout, /\[OK\][^\n]*timezone/, "a deliberate UTC is healthy");
  } finally {
    removeTempDir(home);
  }
});

test("doctor is satisfied by a real IANA zone", async () => {
  const home = freshHome();
  try {
    const { stdout } = await runCli(["doctor"], home, 20_000, { TZ: "Asia/Shanghai" });
    assert.match(stdout, /\[OK\][^\n]*timezone[^\n]*Asia\/Shanghai/,
      "a resolvable zone passes and is echoed");
    assert.match(stdout, /\[OK\][^\n]*timezone[^\n]*\+08:00/,
      "doctor is where the offset lives now that log lines no longer repeat it");
  } finally {
    removeTempDir(home);
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
    removeTempDir(home);
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
    removeTempDir(home);
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
    removeTempDir(home);
  }
});

/**
 * `logs --follow | head -5` is ordinary shell usage, and it used to leave an
 * orphan behind: head closes the pipe once it has its lines, and a follower
 * watching only for SIGINT kept waking every second to write into a reader
 * that no longer existed. Nobody sees it -- there is no window and no output
 * -- so it accumulates until someone opens the task manager.
 *
 * Listening for EPIPE alone did not fix it, which is the part worth pinning
 * down: the error only fires when a write actually fails, and this follower
 * writes only when the log grows. A quiet log meant no write, no error, and
 * no exit -- exactly when the orphan survives longest. The fix probes the
 * pipe on a timer instead, so this test deliberately does not write to the
 * log while it waits.
 */
test("logs --follow exits when the pipe it writes to closes", async () => {
  const home = freshHome();
  try {
    // The follower needs an existing log file: without one cmdLogs prints
    // "no log yet" and returns before it ever starts following, which is how
    // the first version of this test passed against the bug it was meant to
    // catch. Write enough lines that head -3 is satisfied from the first read,
    // then leave the file alone -- a quiet log is precisely the case where the
    // old code never attempted a write and so never noticed the closed pipe.
    mkdirSync(path.join(home, "logs"), { recursive: true });
    writeFileSync(
      path.join(home, "logs", "bridge.log"),
      Array.from({ length: 20 }, (_, i) => `[2026-09-15 02:00:0${i % 10}] [test] line ${i}`).join("\n") + "\n",
    );

    // Destroying the child's stdout from here does NOT reproduce the bug: that
    // closes the read end inside this process, and the follower never learns
    // of it. Only a real downstream reader that exits -- head -- closes the
    // write end the follower holds. Verified both ways: with `head` in the
    // pipeline the old code hangs and this test fails; with a destroy() it
    // passed against the bug, which is how the first version of this test
    // managed to be useless.
    const pipeline = spawn(
      `"${process.execPath}" "${CLI}" logs --follow | head -3`,
      { env: { ...process.env, OPEN_BRIDGE_HOME: home }, stdio: ["ignore", "ignore", "ignore"], shell: true },
    );

    const verdict = await Promise.race([
      new Promise(resolve => pipeline.on("exit", () => resolve("exited"))),
      new Promise(resolve => setTimeout(() => resolve("still running"), 10_000)),
    ]);
    if (verdict !== "exited") pipeline.kill("SIGKILL");
    assert.equal(verdict, "exited", "the follower noticed its reader was gone");
  } finally {
    removeTempDir(home);
  }
});
