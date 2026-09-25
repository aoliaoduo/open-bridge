/**
 * docs/tools.md: interact_with_process is "面向普通非 PTY 管道；完整终端会话
 * 请用 open_shell". A shell session shares the command table, but its stdin
 * is owned by send_to_shell's FIFO and pendingMarker guard — writing to it
 * here would interleave with a running command and bypass the completion
 * sentinel entirely.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { interactWithProcess } from "../src/bridge/tools/process-tools.js";
import { state, type CommandState } from "../src/bridge/state.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-interact-refusal-"));
  installNodeHost({ homeDir: home, version: "test" });
  state.commands.clear();
});

afterEach(() => {
  state.commands.clear();
  rmSync(home, { recursive: true, force: true });
});

test("interact_with_process refuses to drive a persistent shell session", async () => {
  const emptyBuffer = {
    state: () => ({ bufferStartOffset: 0, totalBytes: 0 }),
    read: () => ({ data: Buffer.alloc(0), offset: 0, endOffset: 0, totalBytes: 0, availableBytes: 0, droppedBytes: 0, truncated: false }),
  };
  const shellSession = {
    id: "shell-fixture",
    // The marker spawnSessionShell writes into the command table.
    command: "[shell:default]",
    cwd: ".",
    env: {},
    done: false,
    exitCode: null,
    startedAt: Date.now(),
    restartCount: 0,
    autoRestart: false,
    maxRestarts: 0,
    restartDelayMs: 0,
    lastEvent: "shell_open",
    child: {
      pid: 1,
      killed: false,
      stdin: { destroyed: false, writable: true, write() {} },
      stdout: {},
      stderr: {},
    } as unknown as CommandState["child"],
    output: emptyBuffer,
    stdoutOutput: emptyBuffer,
    stderrOutput: emptyBuffer,
  } as unknown as CommandState;
  state.commands.set("shell-fixture", shellSession);

  await assert.rejects(
    interactWithProcess({ command_id: "shell-fixture", input: "ls", wait_ms: 0 }),
    /send_to_shell/,
    "the shell session's stdin belongs to send_to_shell's FIFO",
  );
});
