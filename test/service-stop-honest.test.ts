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
import { restartService, stopService } from "../src/bridge/service-tools.js";
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
    child: {
      pid: 1,
      killed: false,
      /**
       * The refusal this test is about: called, ignored, no `close` follows.
       *
       * It has to exist AND do nothing, which is the scenario itself, not a
       * detail of the stand-in. The missing method was the whole of this test's
       * ubuntu failure — "commandState.child.kill is not a function"
       * (processes.ts:413): Windows never calls it (the win32 branch goes
       * through `taskkill.exe`, and that loop swallows its refusals), so a
       * stand-in shaped only by the platform it was written on passed on one
       * platform and failed on the other.
       */
      kill() {},
      off() {},
      once() {},
    } as unknown as CommandState["child"],
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

test("restart_service refuses a second child when the existing one will not stop", { timeout: 30_000 }, async () => {
  const command = stuckCommand("stuck-restart");
  state.commands.set(command.id, command);
  state.services.set("web", {
    command: "node forever.js",
    cwd: ".",
    env: {},
    group: "default",
    autoRestart: false,
    maxRestarts: 3,
    restartDelayMs: 1000,
    commandId: command.id,
  } as ServiceDefinition & { commandId: string });

  await assert.rejects(
    restartService({ name: "web" }),
    /did not stop within the termination budget; refusing restart/i,
  );
  assert.equal(state.services.get("web")?.commandId, command.id,
    "the surviving service remains attributable and restartable instead of being replaced");
});

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

  // timeout: 30_000 above, because terminateProcess resolves false only after
  // waitForProcessClose's 5 s budget and this stand-in never fires close. That
  // wait is the point — a shorter budget would be testing a timeout that does
  // not exist — and it is what the production path costs when a process
  // ignores the signal.
  const result = await stopService({ name: "web" });
  assert.equal((result as { stopped: boolean }).stopped, false,
    "an unconfirmed termination must not claim stopped:true");
  assert.equal((result as { status: string }).status, "running",
    "the service stays running until the process is really gone");
  assert.equal(state.services.get("web")?.commandId, "stuck-1",
    "the command handle must survive so the operator can retry");
});
