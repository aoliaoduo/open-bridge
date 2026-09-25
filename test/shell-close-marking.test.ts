/**
 * closeShell's manual finalization: when a session shell never reports its own
 * exit, closeShell marks the record done itself. The real 'close' event, when
 * it later arrives, early-returns on done (wireSpawnedChild), so this path is
 * the LAST chance to stamp endedAt — missing it left every closed session
 * shell without an end time, with uptime_ms growing on every snapshot poll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { markSessionShellClosed } from "../src/bridge/runtime/shell-sessions.js";
import type { CommandState } from "../src/bridge/runtime/processes.js";

test("a session shell closed by request gets an end time", () => {
  const startedAt = Date.now() - 5_000;
  const cmd = {
    done: false,
    exitCode: null,
    endedAt: undefined,
    lastEvent: "shell_open",
    startedAt,
  } as unknown as CommandState;

  markSessionShellClosed(cmd);

  assert.equal(cmd.done, true);
  assert.equal(cmd.exitCode, null, "nobody knows the exit code: null, never a fabricated 0");
  assert.equal(cmd.lastEvent, "shell_closed");
  assert.equal(typeof cmd.endedAt, "number", "the record gets an end time");
  assert.ok((cmd.endedAt ?? 0) >= startedAt, "the end time is not before the start");
});

test("marking preserves an exit code the shell did report", () => {
  const cmd = {
    done: false,
    exitCode: 3,
    endedAt: undefined,
    lastEvent: "exited",
    startedAt: Date.now() - 1_000,
  } as unknown as CommandState;

  markSessionShellClosed(cmd);

  assert.equal(cmd.exitCode, 3);
  assert.equal(typeof cmd.endedAt, "number");
});
