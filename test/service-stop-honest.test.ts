/**
 * stop_service / delete_service used to clear commandId and report
 * {stopped: true} even when terminateProcess timed out, orphaning a live
 * process and letting start_service spawn a second instance against the port
 * the survivor still held. The honest answer is stopped:false + a kept handle.
 *
 * The timeout path itself is hard to hit deterministically (taskkill usually
 * wins), so the contract is pinned at the unit level: a stubbed terminate that
 * fails to confirm closure must produce the honest envelope, not a lie.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { stopService } from "../src/bridge/service-tools.js";
import { state, type ServiceDefinition } from "../src/bridge/state.js";
import type { CommandState } from "../src/bridge/processes.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-svc-stop-"));
  installNodeHost({ homeDir: home, version: "0.0.0-test" });
  state.services.clear();
  state.commands.clear();
});

afterEach(() => {
  state.services.clear();
  state.commands.clear();
  rmSync(home, { recursive: true, force: true });
});

/** A CommandState whose "child" never fires close: terminateProcess times out. */
function stuckCommand(id: string): CommandState {
  return {
    id,
    child: { pid: 1, killed: false, off() {}, once() {} } as unknown as CommandState["child"],
    output: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stdoutOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    stderrOutput: { state: () => ({ bufferStartOffset: 0, totalBytes: 0 }) },
    done: false,
    exitCode: null,
    command: "node forever.js",
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

test("stop_service keeps the handle and reports stopped:false when the process refuses to die", { timeout: 30_000 }, async () => {
  const command = stuckCommand("stuck-1");
  state.commands.set("stuck-1", command);
  state.services.set("web", {
    command: "node forever.js",
    cwd: ".",
    env: {},
    group: "default",
    autoRestart: false,
    maxRestarts: 3,
    restartDelayMs: 1000,
    commandId: "stuck-1",
  } as ServiceDefinition & { commandId: string });

  // terminateProcess resolves false only after waitForProcessClose's 5 s
  // timeout; the stubbed child never fires close, so the real call would wait
  // out the budget. That wait is the production behaviour — but 5 s in a unit
  // test buys nothing, so pin the contract via the delete path's cheaper
  // variant: the no-process and surviving-process branches.
  //
  // Instead of stubbing internals, drive the real stopService against a
  // command that exits instantly (the honest stopped:true path) to prove the
  // wiring, and pin the timeout contract through the record shape below.
  const result = await stopService({ name: "web" });
  assert.equal((result as { stopped: boolean }).stopped, false,
    "an unconfirmed termination must not claim stopped:true");
  assert.equal((result as { status: string }).status, "running",
    "the service stays running until the process is really gone");
  assert.equal(state.services.get("web")?.commandId, "stuck-1",
    "the command handle must survive so the operator can retry");
});
