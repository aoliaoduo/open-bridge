/**
 * The restart handover's pure parts: replaying this process's command line, and
 * waiting for the successor's runtime record.
 *
 * Both are the kind of thing that looks obviously right until the detail bites —
 * a replayed command line that went through a shell would break on a workspace
 * path with spaces, and "is the runtime record there" answers yes when the record
 * is the *old* process's. So they are tested rather than trusted.
 *
 * No host, no state, no config: this module only touches node builtins, and the
 * runtime record is a path the caller passes in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  recordedPid, spawnSuccessor, successorPlan, waitForSuccessor,
} from "../src/bridge/restart.js";

test("the successor reuses this executable and this argv, verbatim", () => {
  const argv = ["/usr/bin/node", "/repo/bin/open-bridge.js", "serve", "--port", "18080", "--root", "C:\\my project"];
  const plan = successorPlan(argv, "/usr/bin/node", "C:\\my project");

  assert.equal(plan.command, "/usr/bin/node");
  assert.deepEqual(plan.args, ["/repo/bin/open-bridge.js", "serve", "--port", "18080", "--root", "C:\\my project"]);
  assert.equal(plan.cwd, "C:\\my project");
  // The path with a space must survive untouched: no shell, no quoting added.
  assert.ok(plan.args.includes("C:\\my project"));
  assert.ok(!plan.args.some(arg => /"/.test(arg)), "no argument was quoted on the way through");
});

test("the dev shape (interpreter script, no subcommand) replays too", () => {
  const plan = successorPlan(["/usr/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "src/cli.ts"], "/usr/bin/node", "/repo");
  assert.deepEqual(plan.args, ["/repo/node_modules/tsx/dist/cli.mjs", "src/cli.ts"]);
});

test("a process with no script argument refuses instead of guessing", () => {
  assert.throws(() => successorPlan(["/usr/bin/node"], "/usr/bin/node", "/repo"), /cannot be replayed/);
});

test("a spawned successor really starts, and its pid is what the caller waits on", async () => {
  // The cheapest possible successor: this very node, doing nothing for 300ms.
  // `cwd` is the repo (a directory the test does not delete): a process's cwd
  // cannot be removed on Windows while it lives, and the point here is the spawn
  // contract, not the directory.
  const pid = await spawnSuccessor({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 300)"],
    cwd: process.cwd(),
  });
  assert.ok(pid > 0, "spawn resolves with a pid");
  // It must be detached, not a child that dies with this process: kill(pid, 0)
  // proves the pid is a live process the test can reach on its own.
  assert.doesNotThrow(() => process.kill(pid, 0));
  try { process.kill(pid); } catch { /* it may have exited already */ }
});

test("waiting for a successor needs the successor's pid, not just a record", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ob-restart-record-"));
  const record = path.join(dir, "runtime-abc.json");
  try {
    assert.equal(recordedPid(record), undefined, "no record yet");
    assert.equal(await waitForSuccessor(record, 4242, 300), false, "an absent record never satisfies the wait");

    // The record of the process that is shutting down is NOT the successor.
    writeFileSync(record, JSON.stringify({ pid: 1111, port: 18080 }), "utf8");
    assert.equal(await waitForSuccessor(record, 4242, 300), false, "another pid's record does not count");

    writeFileSync(record, JSON.stringify({ pid: 4242, port: 18081 }), "utf8");
    assert.equal(await waitForSuccessor(record, 4242, 2_000), true, "the successor's own record does");

    // A corrupt file is "no record", not a crash.
    writeFileSync(record, "{not json", "utf8");
    assert.equal(recordedPid(record), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
