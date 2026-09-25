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
import { restartProcess } from "../src/bridge/tools/process-tools.js";
import { state } from "../src/bridge/state.js";
import type { CommandState } from "../src/bridge/runtime/processes.js";

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

/** A managed process whose kill() DOES settle: close fires, termination confirms. */
function stoppableCommand(id: string): CommandState {
  let onClose: (() => void) | undefined;
  return {
    id,
    child: {
      // pid: undefined on purpose — terminateProcess takes the direct
      // child.kill() branch, so the stub itself decides when close fires
      // (a real pid would route through the Windows family kill).
      pid: undefined,
      killed: false,
      kill() {
        // A real close arrives asynchronously after kill(); firing on the
        // microtask keeps that ordering (terminateProcess registers its
        // close listener after calling kill).
        queueMicrotask(() => onClose?.());
      },
      once(event: string, fn: () => void) { if (event === "close") onClose = fn; },
      off() {},
    } as unknown as CommandState["child"],
    output: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stdoutOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stderrOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    done: false,
    exitCode: null,
    command: "node --version",
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

test("restart_process carries the service-log tee onto the replacement", { timeout: 30_000 }, async () => {
  // The auto-restart path deliberately hands `teeLogPath` to the replacement
  // (processes.ts); the manual restart used to drop it, so a restarted service
  // stopped mirroring output into the service log and read_service_log froze
  // at pre-restart content with no error anywhere.
  const old = stoppableCommand("old-tee");
  old.teeLogPath = path.join(home, "service.log");
  state.commands.set("old-tee", old);

  const result = await restartProcess({ command_id: "old-tee" }) as { command_id: string; restarted: boolean };
  assert.equal(result.restarted, true);

  const replacement = state.commands.get("old-tee");
  assert.ok(replacement && replacement !== old, "the replacement is a fresh record");
  assert.equal(replacement.teeLogPath, old.teeLogPath,
    "the replacement keeps teeing the service log");
  // The probe command exits on its own; give it a moment so the suite leaves
  // no managed child running behind it.
  for (let i = 0; i < 50 && !replacement.done; i += 1) await new Promise(r => setTimeout(r, 100));
  assert.equal(replacement.done, true, "nothing is left running behind the test");
});
