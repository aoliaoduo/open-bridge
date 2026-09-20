/**
 * A process restart is two lifecycle transitions: the old process must really
 * stop before a replacement can be claimed as started. Returning restarted:true
 * while the old tree survives creates two owners of the same port/resource.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { restartProcess } from "../src/bridge/process-tools.js";
import { state } from "../src/bridge/state.js";
import type { CommandState } from "../src/bridge/processes.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-process-restart-"));
  installNodeHost({ homeDir: home, version: "0.0.0-test" });
  state.commands.clear();
});

afterEach(() => {
  state.commands.clear();
  rmSync(home, { recursive: true, force: true });
});

/** A managed process whose termination request never results in close. */
function stuckCommand(id: string): CommandState {
  return {
    id,
    child: {
      pid: 1,
      killed: false,
      kill() {},
      off() {},
      once() {},
    } as unknown as CommandState["child"],
    output: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stdoutOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stderrOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    done: false,
    exitCode: null,
    command: 'node -e "setTimeout(() => {}, 60000)"',
    cwd: ".",
    env: {},
    startedAt: Date.now(),
    restartCount: 0,
    autoRestart: false,
    maxRestarts: 3,
    restartDelayMs: 1000,
    lastEvent: "started",
  } as unknown as CommandState;
}

test("restart_process refuses to claim a replacement when the old process will not stop", { timeout: 30_000 }, async () => {
  const command = stuckCommand("stuck-restart");
  state.commands.set(command.id, command);

  await assert.rejects(
    restartProcess({ command_id: command.id }),
    /did not stop within the termination budget; refusing restart/i,
  );
  assert.equal(state.commands.get(command.id), command,
    "the surviving process remains the tracked owner rather than being replaced by a phantom successor");
});
